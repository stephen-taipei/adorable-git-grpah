import * as THREE from 'three';
import { OUTLINE_COLOR } from '@adorable/graph-core';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import { buildRibbon } from './ribbon';
import { createRibbonMaterial } from './materials';
import type { SharedUniforms } from './materials';
import { TextureKit } from './textures';
import type { Mouth } from './textures';
import { clamp, clamp01, damp, easeInOutCubic, easeOutElastic, rng } from './easing';
import { computeMetrics, planWindow, visibleRows } from './geometry';
import type { CanvasWindow, LogMetrics } from './geometry';

export type SceneTheme = 'day' | 'night';

export interface SceneOptions {
  theme?: SceneTheme;
  /** 尊重 prefers-reduced-motion：不播放進場動畫與閒置晃動。 */
  reducedMotion?: boolean;
}

/** 搜尋 / branch 聚焦時要「淡化」哪些：`active` 為 null 表示全部都亮。 */
export interface SceneFocus {
  active: ReadonlySet<string> | null;
  /** 為真時，兩端不全是 active 的邊也一起淡化（branch 聚焦）；搜尋時只淡化 node。 */
  edges: boolean;
}

const Z_RIBBON = -0.4;
const RIBBON_WIDTH = 0.42;
const BASE_RADIUS = 0.62;
const FACE_Z = 0.03;
const FALLBACK_VIEW_H = 640;

const DIM = {
  day: { body: '#e6e1f1', outline: '#bcb3d8' },
  night: { body: '#6a5fa8', outline: '#8479c4' },
} as const;

interface Extra {
  sprite: THREE.Sprite;
  kind: 'crown' | 'sparkle' | 'sweat' | 'sprout';
  base: THREE.Vector3;
}

type Disposable = { dispose(): void };

/** 一個 node 的 three.js 物件。列第一次進入 canvas 視窗時才建立（幾千列時不必一次建好幾千組 mesh）。 */
interface ActorView {
  group: THREE.Group;
  hull: THREE.Mesh;
  body: THREE.Mesh;
  face: THREE.Group;
  eyes: THREE.Mesh;
  pupils: THREE.Mesh;
  extras: Extra[];
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  disposables: Disposable[];
}

interface Actor {
  node: GraphNode;
  /** world 座標 */
  cx: number;
  cy: number;
  /** track 座標（CSS px），node 中心 */
  px: number;
  py: number;
  radius: number;
  bodyMat: THREE.Material;
  /** 還沒進過視窗的是 null */
  view: ActorView | null;
  /** view 目前掛在 world 底下（只有視窗內、已經出現的才掛：每個 frame 的 updateMatrixWorld / render 只走這些） */
  attached: boolean;
  spawnAt: number;
  phase: number;
  nextBlink: number;
  blinkStart: number;
  hover: { v: number; vel: number };
  look: { x: number; y: number };
  dim: boolean;
  dimV: number;
}

interface RibbonView {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  length: number;
}

interface EdgeActor {
  /** world 座標的折線（mesh 在第一次進入視窗時才建立） */
  points: Array<[number, number]>;
  color: string;
  view: RibbonView | null;
  attached: boolean;
  dimmed: boolean;
  /** 上方（較新）的 node：完整重播時由它決定何時長出來 */
  child: Actor;
  parent: Actor;
  /** 這條邊涵蓋的列範圍（含） */
  rowFrom: number;
  rowTo: number;
  baseColor: THREE.Color;
}

/** 歷史被截斷的 node 往下的虛線 + …（同樣在進入視窗時才建立） */
interface Stub {
  actor: Actor;
  view: (RibbonView & { dots: THREE.Sprite; dotsMat: THREE.SpriteMaterial }) | null;
  attached: boolean;
}

const moodFor = (kind: GraphNode['kind']): { mouth: Mouth; scale: number } => {
  switch (kind) {
    case 'merge':
      return { mouth: 'oh', scale: 1.2 };
    case 'feat':
      return { mouth: 'grin', scale: 1 };
    case 'fix':
    case 'revert':
      return { mouth: 'worry', scale: 1 };
    case 'root':
      return { mouth: 'smile', scale: 0.88 };
    default:
      return { mouth: 'smile', scale: 1 };
  }
};

/**
 * 垂直捲動 git log 的卡通線圖：一條 lane 一欄、最新的 commit 在最上面。
 *
 * canvas 只畫「可視範圍 + 上下緩衝」的視窗（見 planWindow），並且放在捲動內容裡跟著 DOM 列一起捲，
 * 所以線圖與文字列永遠對齊。互動（hover / 點擊）全部由 DOM 列處理，這裡只負責畫與動畫。
 */
export class LogGraphScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 80);
  private readonly kit = new TextureKit();
  private readonly shared: SharedUniforms = { uTime: { value: 0 } };
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly sphere = new THREE.SphereGeometry(1, 40, 28);
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly ringGeo = new THREE.RingGeometry(0.92, 1, 40);
  private readonly selGeo = new THREE.RingGeometry(0.84, 1, 48);
  private readonly hullMat = new THREE.MeshBasicMaterial({
    color: OUTLINE_COLOR,
    side: THREE.BackSide,
  });
  private readonly dimHullMat = new THREE.MeshBasicMaterial({
    color: DIM.day.outline,
    side: THREE.BackSide,
  });
  private readonly dimBodyMat: THREE.MeshToonMaterial;
  private readonly bodyMats = new Map<string, THREE.MeshToonMaterial>();

  private readonly world = new THREE.Group();
  private readonly selection = new THREE.Group();
  private readonly selInner: THREE.MeshBasicMaterial;
  private readonly selOuter: THREE.MeshBasicMaterial;

  private layout: GraphLayout | null = null;
  private actors: Actor[] = [];
  private actorBySha = new Map<string, Actor>();
  private edgeActors: EdgeActor[] = [];
  private stubs: Stub[] = [];
  /** 目前掛在 world 底下的 actor（離開視窗時拿掉） */
  private shown = new Set<Actor>();
  /**
   * 重建時換下來的 material / geometry：等新的畫過一次再 dispose。three.js 在最後一個用到某個 shader program 的
   * material 被 dispose 時會刪掉那個 program，先 dispose 再畫就得整個重新編譯（每次載入更早的歷史都卡一下）。
   */
  private trash: Disposable[] = [];

  private metrics: LogMetrics = computeMetrics(1200, 1);
  /** 1 world unit = `u` CSS px */
  private u = this.metrics.radius / BASE_RADIUS;
  private scroll = { top: 0, viewH: FALLBACK_VIEW_H };
  private win: CanvasWindow | null = null;

  private t = 0;
  private lastFrame = 0;
  private raf = 0;
  private paused = false;
  private disposed = false;
  private theme: SceneTheme;
  private reduced: boolean;

  private replayEnd = 0;
  private replayState: 'idle' | 'playing' | 'done' = 'idle';
  private edgeTiming: 'replay' | 'incremental' = 'replay';
  private waveStart = 0;

  private pointer: { x: number; y: number } | null = null;
  private hovered: Actor | null = null;
  private selected: Actor | null = null;
  private selectedSha: string | null = null;
  private focus: SceneFocus = { active: null, edges: false };

  constructor(host: HTMLElement, opts: SceneOptions = {}) {
    this.host = host;
    this.theme = opts.theme ?? 'day';
    this.reduced = opts.reducedMotion ?? false;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.style.cssText = 'display:block;pointer-events:none;';
    host.style.cssText += ';position:absolute;left:0;pointer-events:none;';
    host.appendChild(canvas);

    this.camera.position.set(0, 0, 30);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.55));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(-4, 6, 8);
    this.scene.add(sun);
    this.scene.add(this.world);

    this.dimBodyMat = new THREE.MeshToonMaterial({
      color: DIM.day.body,
      gradientMap: this.kit.toonGradient,
    });

    // 選取環：深色外環 + 黃色內環，會輕輕脈動
    this.selOuter = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, depthWrite: false });
    this.selInner = new THREE.MeshBasicMaterial({ color: '#ffd23f', depthWrite: false });
    const outer = new THREE.Mesh(this.selGeo, this.selOuter);
    outer.scale.setScalar(1.06);
    const inner = new THREE.Mesh(this.selGeo, this.selInner);
    inner.scale.setScalar(0.97);
    inner.position.z = 0.01;
    this.selection.add(outer, inner);
    this.selection.visible = false;
    this.selection.position.z = -0.2;
    this.scene.add(this.selection);

    this.applyTheme();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ───────────────────────── public API ─────────────────────────

  setTheme(theme: SceneTheme) {
    this.theme = theme;
    this.applyTheme();
  }

  setReducedMotion(reduced: boolean) {
    this.reduced = reduced;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) this.lastFrame = performance.now();
  }

  /** 列高 / lane 間距 / 欄寬改變（視窗寬度跨過斷點、lane 數變了）：用新尺寸重建，不重播動畫。 */
  setMetrics(metrics: LogMetrics) {
    const p = this.metrics;
    // size / cols 只影響 DOM；畫面幾何沒變就不要重建（開關詳情面板時常常只換了欄位組合）
    if (
      this.win &&
      p.rowH === metrics.rowH &&
      p.topPad === metrics.topPad &&
      p.lanePitch === metrics.lanePitch &&
      p.padLeft === metrics.padLeft &&
      p.graphW === metrics.graphW &&
      p.radius === metrics.radius
    ) {
      this.metrics = metrics;
      return;
    }
    this.metrics = metrics;
    this.u = metrics.radius / BASE_RADIUS;
    this.win = null;
    if (this.layout) {
      const keep = new Map(this.actors.map((a) => [a.node.sha, a]));
      this.rebuild(keep);
    }
    this.applyWindow(true);
  }

  /** 捲動位置 / 可視高度改變時呼叫（每個 scroll 事件都可以呼叫，沒有必要時不會重畫）。 */
  setViewport(scrollTop: number, viewH: number) {
    this.scroll = { top: Math.max(0, scrollTop), viewH: Math.max(1, viewH) };
    this.applyWindow(false);
  }

  /** 滑鼠位置（track 座標，CSS px）；null = 不在列表上。node 的瞳孔會看向它。 */
  setPointer(x: number | null, y = 0) {
    this.pointer = x === null ? null : { x, y };
  }

  setHover(sha: string | null) {
    this.hovered = (sha && this.actorBySha.get(sha)) || null;
  }

  setSelected(sha: string | null) {
    this.selectedSha = sha;
    this.selected = (sha && this.actorBySha.get(sha)) || null;
    this.selection.visible = false;
  }

  setFocus(focus: SceneFocus) {
    this.focus = focus;
    this.applyFocus();
  }

  /**
   * 載入圖。`incremental` 為真（同一個 repo 的更新，例如剛 commit 了一筆）時：
   * 既有的 commit 立刻就位、只有新增的會「彈出來」。捲動位置由呼叫端（DOM）負責維持。
   */
  setLayout(layout: GraphLayout, opts: { incremental?: boolean } = {}) {
    const previous = opts.incremental ? new Set(this.actorBySha.keys()) : null;
    this.layout = layout;
    this.rebuild(null);
    // 先決定哪些 node 要彈出來，再畫第一張：否則會先閃一張「全部就位」的畫面
    if (previous && previous.size > 0) this.updateIncrementally(previous);
    else this.replay(true);
    this.applyWindow(true);
  }

  /** 重播：目前可視範圍的 node 由上往下依序彈出來；可視範圍之外的立刻就位。 */
  replay(animate = true) {
    if (!this.layout) return;
    this.edgeTiming = 'replay';
    const animated = animate && !this.reduced;
    const { first, last } = this.visible();
    const count = Math.max(1, last - first + 1);
    const step = animated ? clamp(1.8 / count, 0.03, 0.09) : 0;
    const start = this.t + (animated ? 0.25 : 0);
    this.actors.forEach((a, row) => {
      const inView = row >= first - 1 && row <= last + 1;
      a.spawnAt = animated && inView ? start + Math.max(0, row - first) * step : -1e6;
      a.nextBlink = this.t + 1 + Math.random() * 3;
    });
    this.replayEnd = start + (animated ? count * step + 0.9 : 0);
    this.waveStart = this.replayEnd + 0.5;
    this.setReplayState(animated ? 'playing' : 'done');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.clearGraph();
    this.emptyTrash();
    for (const d of this.disposables) d.dispose();
    for (const m of this.bodyMats.values()) m.dispose();
    this.dimBodyMat.dispose();
    this.hullMat.dispose();
    this.dimHullMat.dispose();
    this.selOuter.dispose();
    this.selInner.dispose();
    this.sphere.dispose();
    this.plane.dispose();
    this.ringGeo.dispose();
    this.selGeo.dispose();
    this.kit.dispose();
    this.renderer.dispose();
    // 盡快釋放 WebGL context（瀏覽器對同時存在的 context 數量有上限）
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ───────────────────────── window / camera ─────────────────────────

  private trackHeight(): number {
    // 與 DOM 一致：上方留白 + 每列 rowH + 一列的頁尾
    return this.metrics.topPad + ((this.layout?.nodes.length ?? 0) + 1) * this.metrics.rowH;
  }

  private visible() {
    return visibleRows(
      this.scroll.top,
      this.scroll.viewH,
      this.metrics.rowH,
      this.layout?.nodes.length ?? 0,
      this.metrics.topPad,
    );
  }

  /** 決定 canvas 視窗；有變動才調整大小 / 位置並立刻重畫一次（避免這個 frame 出現空白）。 */
  private applyWindow(force: boolean) {
    if (this.disposed) return;
    const next = planWindow({
      scrollTop: this.scroll.top,
      viewH: this.scroll.viewH,
      trackH: this.trackHeight(),
      prev: this.win,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
    if (!force && next === this.win) return;
    const prev = this.win;
    this.win = next;

    const width = this.metrics.graphW;
    if (!prev || prev.dpr !== next.dpr) this.renderer.setPixelRatio(next.dpr);
    const canvas = this.renderer.domElement;
    if (!prev || prev.height !== next.height || force) {
      this.renderer.setSize(width, next.height, false);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${next.height}px`;
    }
    this.host.style.top = `${next.top}px`;
    this.host.style.width = `${width}px`;
    this.host.style.height = `${next.height}px`;
    this.host.dataset['winTop'] = String(next.top);
    // 給 e2e / 除錯：node 中心 = (padLeft + lane * lanePitch, topPad + (row + 0.5) * rowH)，單位 CSS px（track 座標）
    this.host.dataset['padLeft'] = String(this.metrics.padLeft);
    this.host.dataset['lanePitch'] = String(this.metrics.lanePitch);
    this.host.dataset['rowH'] = String(this.metrics.rowH);
    this.host.dataset['topPad'] = String(this.metrics.topPad);

    const u = this.u;
    const cam = this.camera;
    cam.left = 0;
    cam.right = width / u;
    cam.top = -next.top / u;
    cam.bottom = -(next.top + next.height) / u;
    cam.updateProjectionMatrix();

    this.updateActors(0);
    this.updateEdges();
    this.renderer.render(this.scene, this.camera);
    this.emptyTrash();
  }

  // ───────────────────────── building ─────────────────────────

  private bodyMaterial(color: string): THREE.MeshToonMaterial {
    let m = this.bodyMats.get(color);
    if (!m) {
      m = new THREE.MeshToonMaterial({ color, gradientMap: this.kit.toonGradient });
      this.bodyMats.set(color, m);
    }
    return m;
  }

  private spriteMat(
    bag: Disposable[],
    map: THREE.Texture,
    opacity = 1,
    depthTest = false,
  ): THREE.SpriteMaterial {
    const m = new THREE.SpriteMaterial({ map, transparent: true, depthTest, opacity });
    bag.push(m);
    return m;
  }

  private applyTheme() {
    const dim = DIM[this.theme];
    this.dimBodyMat.color.set(dim.body);
    this.dimHullMat.color.set(dim.outline);
    this.applyFocus();
  }

  private emptyTrash() {
    if (this.trash.length === 0) return;
    for (const d of this.trash) d.dispose();
    this.trash = [];
  }

  private clearGraph() {
    this.hovered = null;
    this.selected = null;
    for (const child of [...this.world.children]) this.world.remove(child);
    for (const a of this.actors) if (a.view) this.trash.push(...a.view.disposables);
    for (const r of [...this.edgeActors, ...this.stubs]) {
      if (r.view) this.trash.push(r.view.mesh.geometry, r.view.material);
    }
    for (const st of this.stubs) if (st.view) this.trash.push(st.view.dotsMat);
    this.actors = [];
    this.actorBySha.clear();
    this.shown.clear();
    this.edgeActors = [];
    this.stubs = [];
  }

  /** `keep`：重建時沿用舊 actor 的狀態（出現時間、hover 彈簧、視線、眨眼節奏），尺寸改變時不重播、不會整排一起眨眼。 */
  private rebuild(keep: Map<string, Actor> | null) {
    const hoverSha = this.hovered?.node.sha ?? null;
    this.clearGraph();
    if (!this.layout) return;
    this.buildGraph(this.layout);
    for (const a of this.actors) {
      const old = keep?.get(a.node.sha);
      if (old) {
        a.spawnAt = old.spawnAt;
        a.hover = { ...old.hover };
        a.look = { ...old.look };
        a.nextBlink = old.nextBlink;
        a.blinkStart = old.blinkStart;
      } else {
        a.nextBlink = this.t + 1 + Math.random() * 3;
      }
    }
    this.hovered = (hoverSha && this.actorBySha.get(hoverSha)) || null;
    this.selected = (this.selectedSha && this.actorBySha.get(this.selectedSha)) || null;
    this.applyFocus(true);
  }

  private worldOf(lane: number, row: number): [number, number] {
    const m = this.metrics;
    return [(m.padLeft + lane * m.lanePitch) / this.u, -(m.topPad + (row + 0.5) * m.rowH) / this.u];
  }

  /**
   * 只建立「資料」：每個 node 的位置與動畫狀態、每條邊的折線。three.js 的 mesh 等列進入 canvas 視窗時才建
   * （ensureActorView / ensureEdgeView / ensureStubView），所以載入幾千列或在後面接上更早的歷史時不會卡住。
   */
  private buildGraph(layout: GraphLayout) {
    const rand = rng(layout.nodes.length * 31 + 5);

    for (const node of layout.nodes) {
      const actor = this.createActor(node, rand);
      this.actors.push(actor);
      this.actorBySha.set(node.sha, actor);
    }

    for (const e of layout.edges) {
      const parent = this.actorBySha.get(e.from);
      const child = this.actorBySha.get(e.to);
      if (!parent || !child) continue;
      this.edgeActors.push({
        points: e.points.map(([lane, row]) => this.worldOf(lane, row)),
        color: e.color,
        view: null,
        attached: false,
        dimmed: false,
        child,
        parent,
        rowFrom: child.node.row,
        rowTo: parent.node.row,
        baseColor: new THREE.Color(e.color),
      });
    }

    // 歷史被截斷的 node：往下畫一小段虛線 + …
    // 已經有一條邊從這個 node 沿自己的 lane 直直往下時不畫（虛線會蓋在那條真的邊上）
    const straightDown = new Set(
      layout.edges.filter((e) => e.points[1]?.[0] === e.points[0]?.[0]).map((e) => e.to),
    );
    for (const node of layout.nodes) {
      if (!node.hasHiddenParents) continue;
      // 只有 first parent 被截掉才畫虛線尾巴；只是被 merge 進來的那條線的 parent 不在範圍內時，
      // 虛線會蓋在真正的 first-parent 邊上
      const first = node.parents[0];
      if ((first && this.actorBySha.has(first)) || straightDown.has(node.sha)) continue;
      this.stubs.push({ actor: this.actorBySha.get(node.sha)!, view: null, attached: false });
    }
  }

  private createActor(node: GraphNode, rand: () => number): Actor {
    const mood = moodFor(node.kind);
    const radius = BASE_RADIUS * mood.scale * (node.isHead ? 1.1 : 1);
    const [cx, cy] = this.worldOf(node.lane, node.row);
    const m = this.metrics;
    return {
      node,
      cx,
      cy,
      px: m.padLeft + node.lane * m.lanePitch,
      py: m.topPad + (node.row + 0.5) * m.rowH,
      radius,
      bodyMat: this.bodyMaterial(node.color),
      view: null,
      attached: false,
      spawnAt: -1e6,
      phase: rand() * Math.PI * 2,
      nextBlink: 1 + rand() * 3,
      blinkStart: -10,
      hover: { v: 0, vel: 0 },
      look: { x: 0, y: 0 },
      dim: false,
      dimV: 0,
    };
  }

  /** 第一次需要畫這個 node 時建立它的 three.js 物件（之後重複使用，直到下一次重建）。 */
  private ensureActorView(a: Actor): ActorView {
    if (a.view) return a.view;
    const { node, radius } = a;
    const mood = moodFor(node.kind);
    const disposables: Disposable[] = [];
    const group = new THREE.Group();
    group.position.set(a.cx, a.cy, 0);

    const hull = new THREE.Mesh(this.sphere, this.hullMat);
    hull.scale.setScalar(radius * 1.13);
    const body = new THREE.Mesh(this.sphere, a.bodyMat);
    body.scale.setScalar(radius);
    group.add(hull, body);

    const face = new THREE.Group();
    face.position.z = radius + FACE_Z;
    face.scale.setScalar(radius / BASE_RADIUS);
    group.add(face);

    const flat = (map: THREE.Texture, w: number, h: number, y: number, z = 0) => {
      const mat = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        depthWrite: false,
      });
      disposables.push(mat);
      const mesh = new THREE.Mesh(this.plane, mat);
      mesh.scale.set(w, h, 1);
      mesh.position.set(0, y, z);
      face.add(mesh);
      return mesh;
    };
    const eyes = flat(this.kit.eyes, 0.8, 0.4, 0.1);
    const pupils = flat(this.kit.pupils, 0.8, 0.4, 0.1, 0.004);
    flat(this.kit.mouths[mood.mouth], 0.8, 0.4, -0.2, 0.002);

    const gloss = flat(this.kit.gloss, 0.3, 0.22, 0.3, 0.01);
    gloss.position.x = -0.22;
    gloss.rotation.z = 0.5;

    // 發光環（進場時擴散）
    const ringMat = new THREE.MeshBasicMaterial({
      color: node.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    disposables.push(ringMat);
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.position.z = -0.3;
    ring.visible = false;
    group.add(ring);

    const extras: Extra[] = [];
    const addExtra = (
      kind: Extra['kind'],
      tex: THREE.Texture,
      w: number,
      h: number,
      x: number,
      y: number,
    ) => {
      const sprite = new THREE.Sprite(this.spriteMat(disposables, tex));
      sprite.scale.set(w, h, 1);
      sprite.position.set(x, y, 0.2);
      sprite.renderOrder = 6;
      group.add(sprite);
      extras.push({ sprite, kind, base: sprite.position.clone() });
    };

    if (node.kind === 'root') addExtra('sprout', this.kit.sprout, 0.62, 0.62, 0, radius + 0.16);
    if (node.isHead) addExtra('crown', this.kit.crown, 0.78, 0.62, 0.02, radius + 0.17);
    if (node.kind === 'feat')
      addExtra('sparkle', this.kit.sparkle, 0.36, 0.36, radius * 0.92, radius * 0.86);
    if (node.kind === 'fix')
      addExtra('sweat', this.kit.sweat, 0.24, 0.32, radius * 0.88, radius * 0.5);

    a.view = { group, hull, body, face, eyes, pupils, extras, ring, ringMat, disposables };
    this.applyActorFocus(a);
    return a.view;
  }

  /** 掛到 world 底下（要畫）。 */
  private showActor(a: Actor): ActorView {
    const v = this.ensureActorView(a);
    if (!a.attached) {
      this.world.add(v.group);
      a.attached = true;
      this.shown.add(a);
    }
    v.group.visible = true;
    return v;
  }

  /** 從 world 拿掉（視窗外 / 還沒輪到它出現）。 */
  private hideActor(a: Actor) {
    if (!a.attached) return;
    this.world.remove(a.view!.group);
    a.attached = false;
    this.shown.delete(a);
  }

  private ensureEdgeView(e: EdgeActor): RibbonView {
    if (e.view) return e.view;
    const { geometry, length } = buildRibbon(e.points, RIBBON_WIDTH, Z_RIBBON);
    const material = createRibbonMaterial(this.shared, e.color);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    e.view = { mesh, material, length };
    this.applyEdgeFocus(e);
    return e.view;
  }

  private ensureStubView(st: Stub): NonNullable<Stub['view']> {
    if (st.view) return st.view;
    const { actor } = st;
    const x = actor.cx;
    const y = actor.cy;
    const stubLen = (this.metrics.rowH * 0.85) / this.u;
    const { geometry, length } = buildRibbon(
      [
        [x, y],
        [x, y - stubLen],
      ],
      RIBBON_WIDTH * 0.7,
      Z_RIBBON,
    );
    const material = createRibbonMaterial(this.shared, actor.node.color, {
      chevron: false,
      dash: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;

    const bag: Disposable[] = [];
    const dotsMat = this.spriteMat(bag, this.kit.dots, 0.8);
    const dots = new THREE.Sprite(dotsMat);
    dots.scale.set(0.9, 0.3, 1);
    dots.position.set(x, y - stubLen - 0.32, 0);
    dots.renderOrder = 4;
    st.view = { mesh, material, length, dots, dotsMat };
    return st.view;
  }

  // ───────────────────────── focus / dimming ─────────────────────────

  /** `snap`：重建後立刻套用（不要讓已淡化的 node 又從全尺寸慢慢縮回去）。 */
  private applyFocus(snap = false) {
    const { active, edges } = this.focus;
    for (const a of this.actors) {
      const dimmed = active !== null && !active.has(a.node.sha);
      a.dim = dimmed;
      if (snap) a.dimV = dimmed ? 1 : 0;
      this.applyActorFocus(a);
    }
    for (const e of this.edgeActors) {
      e.dimmed =
        active !== null &&
        edges &&
        !(active.has(e.child.node.sha) && active.has(e.parent.node.sha));
      this.applyEdgeFocus(e);
    }
  }

  /** 把 actor 的淡化狀態套到它的 mesh 上（還沒建立 mesh 的，建立時再套）。 */
  private applyActorFocus(a: Actor) {
    const v = a.view;
    if (!v) return;
    v.body.material = a.dim ? this.dimBodyMat : a.bodyMat;
    v.hull.material = a.dim ? this.dimHullMat : this.hullMat;
    v.face.visible = !a.dim;
    for (const ex of v.extras) ex.sprite.visible = !a.dim;
  }

  private applyEdgeFocus(e: EdgeActor) {
    if (!e.view) return;
    const dim = DIM[this.theme];
    const u = e.view.material.uniforms;
    (u['uColor']!.value as THREE.Color).set(e.dimmed ? dim.body : e.baseColor);
    (u['uOutline']!.value as THREE.Color).set(e.dimmed ? dim.outline : OUTLINE_COLOR);
    u['uChevron']!.value = e.dimmed ? 0 : 1;
  }

  // ───────────────────────── animation ─────────────────────────

  private updateIncrementally(previous: Set<string>) {
    const animated = !this.reduced;
    // 只讓可視範圍附近的新 commit 彈出來（由舊到新）；畫面外的立刻就位，不然要白等一長串看不到的動畫
    // 接在最後面的是更早的歷史（infinite scroll 載入的），不是新的 commit：直接就位，不彈出來
    const { first, last } = this.visible();
    let lastOld = -1;
    for (const a of this.actors) if (previous.has(a.node.sha)) lastOld = a.node.row;
    const fresh = this.actors
      .filter((a) => !previous.has(a.node.sha) && a.node.row < lastOld)
      .filter((a) => a.node.row >= first - 2 && a.node.row <= last + 2)
      .reverse();
    const animate = new Set(animated ? fresh : []);
    // 一次進來很多筆（pull / rebase）時要壓縮節奏
    const step = clamp(2 / Math.max(fresh.length, 1), 0.03, 0.2);
    for (const a of this.actors) {
      a.nextBlink = this.t + 1 + Math.random() * 3;
      if (!animate.has(a)) a.spawnAt = -1e6;
    }
    let lastSpawn = this.t;
    fresh.forEach((a, k) => {
      if (!animate.has(a)) return;
      a.spawnAt = this.t + 0.25 + k * step;
      lastSpawn = a.spawnAt;
    });
    this.edgeTiming = 'incremental';
    this.replayEnd = lastSpawn + 0.9;
    this.waveStart = this.replayEnd + 0.5;
    this.setReplayState(animate.size > 0 ? 'playing' : 'done');
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.paused || document.hidden) {
      this.lastFrame = now;
      return;
    }
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.t += dt;
    // prefers-reduced-motion：管線上流動的箭頭也要停下來（uTime 固定）
    this.shared.uTime.value = this.reduced ? 0 : this.t;

    if (this.replayState === 'playing' && this.t > this.replayEnd) this.setReplayState('done');
    this.updateActors(dt);
    this.updateEdges();
    this.renderer.render(this.scene, this.camera);
    this.emptyTrash();
  };

  /** 讓外部（測試 / 樣式）知道動畫是否播完：host[data-replay]。 */
  private setReplayState(state: 'idle' | 'playing' | 'done') {
    this.replayState = state;
    this.host.dataset['replay'] = state;
  }

  private updateActors(dt: number) {
    const win = this.win;
    if (!win || this.actors.length === 0) return;
    const { rowH, topPad } = this.metrics;
    const r0 = Math.max(0, Math.floor((win.top - topPad) / rowH) - 1);
    const r1 = Math.min(
      this.actors.length - 1,
      Math.ceil((win.top + win.height - topPad) / rowH) + 1,
    );
    const motion = this.reduced ? 0 : 1;
    const u = this.u;

    // 沿列掃過的脈衝波（像訊號在流程圖上往下傳遞），只在目前可視範圍內跑
    const view = this.visible();
    const span = view.last - view.first + 7;
    const period = span / 5 + 2.5;
    const waveRow =
      this.t > this.waveStart && motion
        ? view.first - 3 + (((this.t - this.waveStart) % period) / period) * span
        : -1e3;

    // 離開視窗的從 world 拿掉；視窗內的才建立 / 更新（幾千列時每個 frame 只處理視窗內的幾十個）
    for (const a of this.shown) {
      if (a.node.row < r0 || a.node.row > r1) this.hideActor(a);
    }
    for (let i = r0; i <= r1; i++) {
      const a = this.actors[i]!;
      if (this.t < a.spawnAt) {
        this.hideActor(a);
        continue;
      }
      const v = this.showActor(a);
      const age = this.t - a.spawnAt;
      const p = clamp01(age / 0.75);
      const pop = easeOutElastic(p);
      const hop = motion ? Math.sin(clamp01(age / 0.5) * Math.PI) * 0.55 : 0;

      // hover spring
      const target = a === this.hovered ? 1 : 0;
      const h = a.hover;
      h.vel += ((target - h.v) * 260 - h.vel * 17) * dt;
      h.v += h.vel * dt;

      a.dimV += ((a.dim ? 1 : 0) - a.dimV) * damp(12, dt);
      const dimScale = 1 - a.dimV * 0.24;

      const dr = a.node.row - waveRow;
      const pulse = Math.exp(-(dr * dr) / 1.6);
      const breath = Math.sin(this.t * 2.1 + a.phase) * motion * (a.dim ? 0 : 1);
      const s = pop * dimScale * (1 + h.v * 0.3 + pulse * 0.16 * (a.dim ? 0 : 1));
      v.group.scale.set(
        s * (1 - breath * 0.03 - h.v * 0.04),
        s * (1 + breath * 0.035 + h.v * 0.04),
        s,
      );
      v.group.position.y =
        a.cy +
        hop +
        Math.sin(this.t * 1.5 + a.phase) * 0.05 * motion * (a.dim ? 0 : 1) +
        h.v * 0.12;

      // 進場光環
      if (age < 0.6 && motion) {
        v.ring.visible = true;
        const r = clamp01(age / 0.6);
        v.ring.scale.setScalar(a.radius * (1 + r * 1.4));
        v.ringMat.opacity = (1 - r) * 0.75;
      } else if (v.ring.visible) {
        v.ring.visible = false;
      }

      if (a.dim) continue;

      // 眨眼
      if (motion && this.t > a.nextBlink) {
        a.blinkStart = this.t;
        a.nextBlink = this.t + 2.2 + Math.random() * 4;
      }
      const bp = clamp01((this.t - a.blinkStart) / 0.17);
      const blink = bp < 1 ? 1 - Math.sin(bp * Math.PI) * 0.92 : 1;
      v.eyes.scale.y = 0.4 * blink;
      v.pupils.scale.y = 0.4 * blink;

      // 瞳孔看向游標；沒有游標時輕輕飄移
      let lx = Math.sin(this.t * 0.6 + a.phase) * 0.35 * motion;
      let ly = Math.cos(this.t * 0.45 + a.phase) * 0.2 * motion;
      if (this.pointer) {
        const dx = (this.pointer.x - a.px) / u;
        const dy = -(this.pointer.y - a.py) / u;
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 3.2);
        lx = (dx / d) * k;
        ly = (dy / d) * k;
      }
      a.look.x += (lx - a.look.x) * damp(10, dt);
      a.look.y += (ly - a.look.y) * damp(10, dt);
      v.pupils.position.x = a.look.x * 0.06;
      v.pupils.position.y = 0.1 + a.look.y * 0.045;

      for (const ex of v.extras) {
        const w = Math.sin(this.t * 3 + a.phase) * motion;
        if (ex.kind === 'crown') {
          ex.sprite.position.y = ex.base.y + Math.abs(w) * 0.05;
          ex.sprite.material.rotation = w * 0.1;
        } else if (ex.kind === 'sparkle') {
          const sc = 0.36 * (0.8 + 0.3 * Math.sin(this.t * 4 + a.phase) * motion);
          ex.sprite.scale.set(sc, sc, 1);
          ex.sprite.material.rotation = this.t * 0.8 * motion;
        } else if (ex.kind === 'sweat') {
          ex.sprite.position.y = ex.base.y - ((this.t * 0.5 + a.phase) % 1) * 0.12 * motion;
        } else {
          ex.sprite.material.rotation = w * 0.08;
        }
      }
    }

    // 選取環跟著被選取的 node（含它的彈跳）
    const sel = this.selected;
    const selGroup = sel?.attached ? sel.view?.group : undefined;
    if (sel && selGroup) {
      this.selection.visible = true;
      this.selection.position.set(selGroup.position.x, selGroup.position.y, -0.2);
      const pulse = 1 + Math.sin(this.t * 4.2) * 0.05 * motion;
      this.selection.scale.setScalar(sel.radius * 1.4 * pulse);
    } else {
      this.selection.visible = false;
    }
  }

  private updateEdges() {
    const win = this.win;
    if (!win) return;
    const { rowH, topPad } = this.metrics;
    const top = Math.floor((win.top - topPad) / rowH) - 2;
    const bottom = Math.ceil((win.top + win.height - topPad) / rowH) + 2;
    for (const e of this.edgeActors) {
      // 視窗外的邊從 world 拿掉；第一次進入視窗時才建立 mesh
      if (e.rowTo < top || e.rowFrom > bottom) {
        if (e.attached) {
          this.world.remove(e.view!.mesh);
          e.attached = false;
        }
        continue;
      }
      const v = this.ensureEdgeView(e);
      if (!e.attached) {
        this.world.add(v.mesh);
        e.attached = true;
      }
      const start =
        this.edgeTiming === 'incremental'
          ? Math.max(e.child.spawnAt - 0.35, e.parent.spawnAt + 0.05)
          : e.child.spawnAt + 0.05;
      const p = clamp01((this.t - start) / 0.4);
      v.material.uniforms['uReveal']!.value = p >= 1 ? v.length + 1 : easeInOutCubic(p) * v.length;
    }
    for (const st of this.stubs) {
      const row = st.actor.node.row;
      if (row < top || row > bottom) {
        if (st.attached) {
          this.world.remove(st.view!.mesh, st.view!.dots);
          st.attached = false;
        }
        continue;
      }
      const v = this.ensureStubView(st);
      if (!st.attached) {
        this.world.add(v.mesh, v.dots);
        st.attached = true;
      }
      const p = clamp01((this.t - st.actor.spawnAt) / 0.4);
      v.material.uniforms['uReveal']!.value = p >= 1 ? v.length + 1 : p * v.length;
      v.dots.visible = p > 0.6;
    }
  }
}
