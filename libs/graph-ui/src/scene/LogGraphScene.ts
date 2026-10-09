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

interface Actor {
  node: GraphNode;
  /** world 座標 */
  cx: number;
  cy: number;
  /** track 座標（CSS px），node 中心 */
  px: number;
  py: number;
  radius: number;
  group: THREE.Group;
  hull: THREE.Mesh;
  body: THREE.Mesh;
  bodyMat: THREE.Material;
  face: THREE.Group;
  eyes: THREE.Mesh;
  pupils: THREE.Mesh;
  extras: Extra[];
  ring: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  spawnAt: number;
  phase: number;
  nextBlink: number;
  blinkStart: number;
  hover: { v: number; vel: number };
  look: { x: number; y: number };
  dim: boolean;
  dimV: number;
}

interface EdgeActor {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  length: number;
  /** 上方（較新）的 node：完整重播時由它決定何時長出來 */
  child: Actor;
  parent: Actor;
  /** 這條邊涵蓋的列範圍（含） */
  rowFrom: number;
  rowTo: number;
  baseColor: THREE.Color;
}

interface Stub {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  length: number;
  actor: Actor;
  dots: THREE.Sprite;
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
  private graphDisposables: Array<{ dispose(): void }> = [];

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
    this.metrics = metrics;
    this.u = metrics.radius / BASE_RADIUS;
    this.win = null;
    if (this.layout) {
      const keep = new Map(this.actors.map((a) => [a.node.sha, a.spawnAt]));
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
      a.group.visible = a.spawnAt < 0;
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

  private spriteMat(map: THREE.Texture, opacity = 1, depthTest = false): THREE.SpriteMaterial {
    const m = new THREE.SpriteMaterial({ map, transparent: true, depthTest, opacity });
    this.graphDisposables.push(m);
    return m;
  }

  private applyTheme() {
    const dim = DIM[this.theme];
    this.dimBodyMat.color.set(dim.body);
    this.dimHullMat.color.set(dim.outline);
    this.applyFocus();
  }

  private clearGraph() {
    this.hovered = null;
    this.selected = null;
    for (const child of [...this.world.children]) this.world.remove(child);
    for (const d of this.graphDisposables) d.dispose();
    this.graphDisposables = [];
    this.actors = [];
    this.actorBySha.clear();
    this.edgeActors = [];
    this.stubs = [];
  }

  /** `keepSpawn`：重建時沿用既有的出現時間（尺寸改變時不重播動畫）。 */
  private rebuild(keepSpawn: Map<string, number> | null) {
    const hoverSha = this.hovered?.node.sha ?? null;
    this.clearGraph();
    if (!this.layout) return;
    this.buildGraph(this.layout);
    if (keepSpawn) {
      for (const a of this.actors) a.spawnAt = keepSpawn.get(a.node.sha) ?? -1e6;
    }
    this.hovered = (hoverSha && this.actorBySha.get(hoverSha)) || null;
    this.selected = (this.selectedSha && this.actorBySha.get(this.selectedSha)) || null;
    this.applyFocus();
  }

  private worldOf(lane: number, row: number): [number, number] {
    const m = this.metrics;
    return [(m.padLeft + lane * m.lanePitch) / this.u, -(m.topPad + (row + 0.5) * m.rowH) / this.u];
  }

  private buildGraph(layout: GraphLayout) {
    const rand = rng(layout.nodes.length * 31 + 5);
    const m = this.metrics;

    for (const node of layout.nodes) {
      const actor = this.createActor(node, rand);
      this.actors.push(actor);
      this.actorBySha.set(node.sha, actor);
      this.world.add(actor.group);
    }

    for (const e of layout.edges) {
      const parent = this.actorBySha.get(e.from);
      const child = this.actorBySha.get(e.to);
      if (!parent || !child) continue;
      const pts = e.points.map(([lane, row]) => this.worldOf(lane, row));
      const { geometry, length } = buildRibbon(pts, RIBBON_WIDTH, Z_RIBBON);
      const material = createRibbonMaterial(this.shared, e.color);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.world.add(mesh);
      this.graphDisposables.push(geometry, material);
      this.edgeActors.push({
        mesh,
        material,
        length,
        child,
        parent,
        rowFrom: child.node.row,
        rowTo: parent.node.row,
        baseColor: new THREE.Color(e.color),
      });
    }

    // 歷史被截斷的 node：往下畫一小段虛線 + …
    const stubLen = (m.rowH * 0.85) / this.u;
    for (const node of layout.nodes) {
      if (!node.hasHiddenParents) continue;
      const actor = this.actorBySha.get(node.sha)!;
      const x = actor.cx;
      const y = actor.cy;
      const { geometry, length } = buildRibbon(
        [
          [x, y],
          [x, y - stubLen],
        ],
        RIBBON_WIDTH * 0.7,
        Z_RIBBON,
      );
      const material = createRibbonMaterial(this.shared, node.color, {
        chevron: false,
        dash: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.world.add(mesh);
      this.graphDisposables.push(geometry, material);

      const dots = new THREE.Sprite(this.spriteMat(this.kit.dots, 0.8));
      dots.scale.set(0.9, 0.3, 1);
      dots.position.set(x, y - stubLen - 0.32, 0);
      dots.renderOrder = 4;
      this.world.add(dots);
      this.stubs.push({ mesh, material, length, actor, dots });
    }
  }

  private createActor(node: GraphNode, rand: () => number): Actor {
    const mood = moodFor(node.kind);
    const radius = BASE_RADIUS * mood.scale * (node.isHead ? 1.1 : 1);
    const group = new THREE.Group();
    const [cx, cy] = this.worldOf(node.lane, node.row);
    group.position.set(cx, cy, 0);

    const hull = new THREE.Mesh(this.sphere, this.hullMat);
    hull.scale.setScalar(radius * 1.13);
    const bodyMat = this.bodyMaterial(node.color);
    const body = new THREE.Mesh(this.sphere, bodyMat);
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
      this.graphDisposables.push(mat);
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
    this.graphDisposables.push(ringMat);
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
      const sprite = new THREE.Sprite(this.spriteMat(tex));
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

    const m = this.metrics;
    return {
      node,
      cx,
      cy,
      px: m.padLeft + node.lane * m.lanePitch,
      py: m.topPad + (node.row + 0.5) * m.rowH,
      radius,
      group,
      hull,
      body,
      bodyMat,
      face,
      eyes,
      pupils,
      extras,
      ring,
      ringMat,
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

  // ───────────────────────── focus / dimming ─────────────────────────

  private applyFocus() {
    const { active, edges } = this.focus;
    const dim = DIM[this.theme];
    for (const a of this.actors) {
      const dimmed = active !== null && !active.has(a.node.sha);
      a.dim = dimmed;
      a.body.material = dimmed ? this.dimBodyMat : a.bodyMat;
      a.hull.material = dimmed ? this.dimHullMat : this.hullMat;
      a.face.visible = !dimmed;
      for (const ex of a.extras) ex.sprite.visible = !dimmed;
    }
    for (const e of this.edgeActors) {
      const dimmed =
        active !== null &&
        edges &&
        !(active.has(e.child.node.sha) && active.has(e.parent.node.sha));
      const u = e.material.uniforms;
      (u['uColor']!.value as THREE.Color).set(dimmed ? dim.body : e.baseColor);
      (u['uOutline']!.value as THREE.Color).set(dimmed ? dim.outline : OUTLINE_COLOR);
      u['uChevron']!.value = dimmed ? 0 : 1;
    }
  }

  // ───────────────────────── animation ─────────────────────────

  private updateIncrementally(previous: Set<string>) {
    const animated = !this.reduced;
    // 新增的 commit 由舊到新依序彈出來
    const fresh = this.actors.filter((a) => !previous.has(a.node.sha)).reverse();
    // 一次進來很多筆（pull / rebase）時要壓縮節奏，不然要等上好幾十秒
    const step = clamp(2 / Math.max(fresh.length, 1), 0.03, 0.2);
    let lastSpawn = this.t;
    for (const a of this.actors) {
      a.nextBlink = this.t + 1 + Math.random() * 3;
      if (previous.has(a.node.sha) || !animated) {
        a.spawnAt = -1e6;
        a.group.visible = true;
      }
    }
    if (animated) {
      fresh.forEach((a, k) => {
        a.spawnAt = this.t + 0.25 + k * step;
        a.group.visible = false;
        lastSpawn = a.spawnAt;
      });
    }
    this.edgeTiming = 'incremental';
    this.replayEnd = lastSpawn + 0.9;
    this.waveStart = this.replayEnd + 0.5;
    this.setReplayState(fresh.length > 0 && animated ? 'playing' : 'done');
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
    this.shared.uTime.value = this.t;

    if (this.replayState === 'playing' && this.t > this.replayEnd) this.setReplayState('done');
    this.updateActors(dt);
    this.updateEdges();
    this.renderer.render(this.scene, this.camera);
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

    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i]!;
      if (i < r0 || i > r1 || this.t < a.spawnAt) {
        a.group.visible = false;
        continue;
      }
      a.group.visible = true;
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
      a.group.scale.set(
        s * (1 - breath * 0.03 - h.v * 0.04),
        s * (1 + breath * 0.035 + h.v * 0.04),
        s,
      );
      a.group.position.y =
        a.cy +
        hop +
        Math.sin(this.t * 1.5 + a.phase) * 0.05 * motion * (a.dim ? 0 : 1) +
        h.v * 0.12;

      // 進場光環
      if (age < 0.6 && motion) {
        a.ring.visible = true;
        const r = clamp01(age / 0.6);
        a.ring.scale.setScalar(a.radius * (1 + r * 1.4));
        a.ringMat.opacity = (1 - r) * 0.75;
      } else if (a.ring.visible) {
        a.ring.visible = false;
      }

      if (a.dim) continue;

      // 眨眼
      if (motion && this.t > a.nextBlink) {
        a.blinkStart = this.t;
        a.nextBlink = this.t + 2.2 + Math.random() * 4;
      }
      const bp = clamp01((this.t - a.blinkStart) / 0.17);
      const blink = bp < 1 ? 1 - Math.sin(bp * Math.PI) * 0.92 : 1;
      a.eyes.scale.y = 0.4 * blink;
      a.pupils.scale.y = 0.4 * blink;

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
      a.pupils.position.x = a.look.x * 0.06;
      a.pupils.position.y = 0.1 + a.look.y * 0.045;

      for (const ex of a.extras) {
        const w = Math.sin(this.t * 3 + a.phase) * motion;
        if (ex.kind === 'crown') {
          ex.sprite.position.y = ex.base.y + Math.abs(w) * 0.05;
          ex.sprite.material.rotation = w * 0.1;
        } else if (ex.kind === 'sparkle') {
          const sc = 0.36 * (0.8 + 0.3 * Math.sin(this.t * 4 + a.phase));
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
    if (sel && sel.group.visible) {
      this.selection.visible = true;
      this.selection.position.set(sel.group.position.x, sel.group.position.y, -0.2);
      const pulse = 1 + Math.sin(this.t * 4.2) * 0.05 * motion;
      this.selection.scale.setScalar(sel.radius * 1.5 * pulse);
    } else {
      this.selection.visible = false;
    }
  }

  private updateEdges() {
    const win = this.win;
    const { rowH, topPad } = this.metrics;
    const top = win ? Math.floor((win.top - topPad) / rowH) - 2 : -Infinity;
    const bottom = win ? Math.ceil((win.top + win.height - topPad) / rowH) + 2 : Infinity;
    for (const e of this.edgeActors) {
      e.mesh.visible = e.rowTo >= top && e.rowFrom <= bottom;
      if (!e.mesh.visible) continue;
      const start =
        this.edgeTiming === 'incremental'
          ? Math.max(e.child.spawnAt - 0.35, e.parent.spawnAt + 0.05)
          : e.child.spawnAt + 0.05;
      const p = clamp01((this.t - start) / 0.4);
      e.material.uniforms['uReveal']!.value = p >= 1 ? e.length + 1 : easeInOutCubic(p) * e.length;
    }
    for (const s of this.stubs) {
      const row = s.actor.node.row;
      s.mesh.visible = s.dots.visible = row >= top && row <= bottom;
      if (!s.mesh.visible) continue;
      const p = clamp01((this.t - s.actor.spawnAt) / 0.4);
      s.material.uniforms['uReveal']!.value = p >= 1 ? s.length + 1 : p * s.length;
      s.dots.visible = p > 0.6;
    }
  }
}
