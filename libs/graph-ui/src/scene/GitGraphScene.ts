import * as THREE from 'three';
import { OUTLINE_COLOR } from '@adorable/graph-core';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import { buildRibbon } from './ribbon';
import { createGridMaterial, createRibbonMaterial } from './materials';
import type { SharedUniforms } from './materials';
import { TextureKit } from './textures';
import type { Mouth } from './textures';
import { clamp, clamp01, damp, easeInOutCubic, easeOutElastic, rng } from './easing';

export type SceneTheme = 'day' | 'night';

export interface HoverInfo {
  node: GraphNode;
  clientX: number;
  clientY: number;
}

export interface SceneOptions {
  theme?: SceneTheme;
  /** 尊重 prefers-reduced-motion：不播放進場動畫與閒置晃動。 */
  reducedMotion?: boolean;
  onHover?: (info: HoverInfo | null) => void;
  onSelect?: (node: GraphNode) => void;
}

/** grid unit → world unit */
const SX = 2.7;
const SY = 2.1;
const Z_RIBBON = -0.4;
const RIBBON_WIDTH = 0.42;
const BASE_RADIUS = 0.62;
const FACE_Z = 0.03;

interface Extra {
  sprite: THREE.Sprite;
  kind: 'crown' | 'sparkle' | 'sweat' | 'sprout';
  base: THREE.Vector3;
}

interface Actor {
  node: GraphNode;
  cx: number;
  cy: number;
  radius: number;
  group: THREE.Group;
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
}

interface EdgeActor {
  material: THREE.ShaderMaterial;
  length: number;
  /** 以 parent 的 actor 決定何時開始長出來 */
  parent: Actor;
}

interface Cloud {
  sprite: THREE.Sprite;
  ox: number;
  oy: number;
  speed: number;
  size: number;
  parallax: number;
}

interface Star {
  sprite: THREE.Sprite;
  ox: number;
  oy: number;
  size: number;
  phase: number;
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

export class GitGraphScene {
  private readonly container: HTMLElement;
  private readonly opts: SceneOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 80);
  private readonly kit = new TextureKit();
  private readonly shared: SharedUniforms = { uTime: { value: 0 } };
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly sphere = new THREE.SphereGeometry(1, 40, 28);
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly ringGeo = new THREE.RingGeometry(0.92, 1, 40);
  private readonly hullMat = new THREE.MeshBasicMaterial({
    color: OUTLINE_COLOR,
    side: THREE.BackSide,
  });
  private readonly bodyMats = new Map<string, THREE.MeshToonMaterial>();

  private readonly world = new THREE.Group();
  private readonly gridMesh: THREE.Mesh;
  private readonly clouds: Cloud[] = [];
  private readonly stars: Star[] = [];

  private layout: GraphLayout | null = null;
  private actors: Actor[] = [];
  private actorBySha = new Map<string, Actor>();
  private edgeActors: EdgeActor[] = [];
  private stubs: Array<{
    material: THREE.ShaderMaterial;
    length: number;
    actor: Actor;
    dots: THREE.Sprite;
  }> = [];

  private width = 1;
  private height = 1;
  private t = 0;
  private lastFrame = 0;
  private raf = 0;
  private paused = false;
  private disposed = false;
  private theme: SceneTheme;
  private reduced: boolean;

  private cam = { cx: 0, cy: 0, viewH: 12, tx: 0, ty: 0, tViewH: 12, vx: 0, vy: 0 };
  private following = false;
  private replayEnd = 0;
  private replayState: 'idle' | 'playing' | 'done' = 'idle';
  private waveStart = 0;
  private maxViewH = 40;
  private minViewH = 5;

  private pointer: { cx: number; cy: number; wx: number; wy: number } | null = null;
  private drag: {
    id: number;
    lx: number;
    ly: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null = null;
  private hovered: Actor | null = null;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, opts: SceneOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.theme = opts.theme ?? 'day';
    this.reduced = opts.reducedMotion ?? false;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.renderer.domElement;
    canvas.style.cssText =
      'display:block;width:100%;height:100%;touch-action:none;outline:none;cursor:grab;';
    container.appendChild(canvas);

    this.camera.position.set(0, 0, 30);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.55));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(-4, 6, 8);
    this.scene.add(sun);
    this.scene.add(this.world);

    const gridMat = createGridMaterial();
    this.gridMesh = new THREE.Mesh(this.plane, gridMat);
    this.gridMesh.renderOrder = -20;
    this.gridMesh.position.z = -8;
    this.scene.add(this.gridMesh);
    this.disposables.push(gridMat);

    this.buildSky();
    this.applyTheme();

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDblClick);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

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

  setLayout(layout: GraphLayout, opts: { replay?: boolean } = {}) {
    this.clearGraph();
    this.layout = layout;
    this.buildGraph(layout);

    const viewFit = this.viewFor(0, layout.maxX);
    this.maxViewH = Math.max(viewFit.viewH * 1.6, 24);
    this.minViewH = 5;

    this.replay(opts.replay ?? true);
  }

  /** 重播：由最舊的 commit 依序長出來。 */
  replay(animate = true) {
    if (!this.layout) return;
    const L = this.layout;
    const n = this.actors.length;
    const animated = animate && !this.reduced;
    const step = animated ? clamp(2.6 / Math.max(n, 1), 0.035, 0.14) : 0;
    const start = this.t + (animated ? 0.35 : 0);
    this.actors.forEach((a, i) => {
      a.spawnAt = animated ? start + i * step : -1e6;
      a.group.visible = !animated;
      a.nextBlink = this.t + 1 + Math.random() * 3;
    });
    this.replayEnd = start + n * step + 0.9;
    this.setReplayState('playing');
    this.waveStart = this.replayEnd + 0.5;

    const head = this.viewFor(Math.max(0, L.maxX - 11), L.maxX);
    const all = this.viewFor(0, L.maxX);
    const fits = L.maxX <= 12;
    const target = fits ? all : head;
    this.cam.tViewH = target.viewH;
    this.cam.vx = this.cam.vy = 0;

    if (animated && !fits) {
      this.following = true;
      this.cam.viewH = target.viewH;
      this.cam.cy = this.cam.ty = target.cy;
      const vw = target.viewH * this.aspect();
      this.cam.cx = this.cam.tx = Math.max(vw / 2 - 3, 0);
    } else {
      this.following = false;
      this.cam.tx = target.cx;
      this.cam.ty = target.cy;
      if (!animated) {
        this.cam.cx = target.cx;
        this.cam.cy = target.cy;
        this.cam.viewH = target.viewH;
      }
    }
  }

  fit() {
    if (!this.layout) return;
    const v = this.viewFor(0, this.layout.maxX);
    this.flyTo(v.cx, v.cy, v.viewH);
  }

  focusHead() {
    if (!this.layout) return;
    const L = this.layout;
    const v = this.viewFor(Math.max(0, L.maxX - 11), L.maxX);
    this.flyTo(v.cx, v.cy, v.viewH);
  }

  focusSha(sha: string) {
    const a = this.actorBySha.get(sha);
    if (!a) return;
    this.flyTo(a.cx, a.cy, clamp(this.cam.tViewH, this.minViewH, 14));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('dblclick', this.onDblClick);
    this.clearGraph();
    for (const d of this.disposables) d.dispose();
    for (const m of this.bodyMats.values()) m.dispose();
    this.hullMat.dispose();
    this.sphere.dispose();
    this.plane.dispose();
    this.ringGeo.dispose();
    this.kit.dispose();
    this.renderer.dispose();
    // 盡快釋放 WebGL context（瀏覽器對同時存在的 context 數量有上限）
    this.renderer.forceContextLoss();
    canvas.remove();
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

  private graphDisposables: Array<{ dispose(): void }> = [];

  private buildSky() {
    const rand = rng(7);
    const cloudMat = new THREE.SpriteMaterial({
      map: this.kit.cloud,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      opacity: 0.85,
    });
    this.disposables.push(cloudMat);
    for (let i = 0; i < 7; i++) {
      const sprite = new THREE.Sprite(cloudMat);
      sprite.renderOrder = -15;
      this.scene.add(sprite);
      this.clouds.push({
        sprite,
        ox: rand(),
        oy: 0.08 + rand() * 0.84,
        speed: 0.004 + rand() * 0.006,
        size: 0.16 + rand() * 0.14,
        parallax: 0.18 + rand() * 0.22,
      });
    }
    const starMat = new THREE.SpriteMaterial({
      map: this.kit.star,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    this.disposables.push(starMat);
    for (let i = 0; i < 46; i++) {
      const sprite = new THREE.Sprite(starMat.clone());
      sprite.renderOrder = -16;
      this.scene.add(sprite);
      this.disposables.push(sprite.material);
      this.stars.push({
        sprite,
        ox: rand(),
        oy: rand(),
        size: 0.012 + rand() * 0.02,
        phase: rand() * 6.28,
      });
    }
  }

  private applyTheme() {
    const night = this.theme === 'night';
    for (const c of this.clouds) {
      c.sprite.material.color.set(night ? '#6a63b8' : '#ffffff');
      c.sprite.material.opacity = night ? 0.22 : 0.85;
    }
    for (const s of this.stars) s.sprite.visible = night;
    const mat = this.gridMesh.material as THREE.ShaderMaterial;
    (mat.uniforms['uColor']!.value as THREE.Color).set(night ? '#b9b2f0' : '#8a7fb8');
    mat.uniforms['uAlpha']!.value = night ? 0.2 : 0.28;
  }

  private clearGraph() {
    this.hovered = null;
    this.opts.onHover?.(null);
    for (const child of [...this.world.children]) this.world.remove(child);
    for (const d of this.graphDisposables) d.dispose();
    this.graphDisposables = [];
    this.actors = [];
    this.actorBySha.clear();
    this.edgeActors = [];
    this.stubs = [];
  }

  private buildGraph(layout: GraphLayout) {
    const rand = rng(layout.nodes.length * 31 + 5);

    for (const node of layout.nodes) {
      const actor = this.createActor(node, rand);
      this.actors.push(actor);
      this.actorBySha.set(node.sha, actor);
      this.world.add(actor.group);
    }

    for (const e of layout.edges) {
      const parent = this.actorBySha.get(e.from);
      if (!parent) continue;
      const pts = e.points.map(([x, y]) => [x * SX, y * SY] as const);
      const { geometry, length } = buildRibbon(pts, RIBBON_WIDTH, Z_RIBBON);
      const material = createRibbonMaterial(this.shared, e.color);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      this.world.add(mesh);
      this.graphDisposables.push(geometry, material);
      this.edgeActors.push({ material, length, parent });
    }

    // 歷史被截斷的節點：往左畫一小段虛線 + …
    for (const node of layout.nodes) {
      if (!node.hasHiddenParents) continue;
      const actor = this.actorBySha.get(node.sha)!;
      const x = node.x * SX;
      const y = node.y * SY;
      const { geometry, length } = buildRibbon(
        [
          [x - 2.1, y],
          [x, y],
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
      dots.position.set(x - 2.55, y, 0);
      dots.renderOrder = 4;
      this.world.add(dots);
      this.stubs.push({ material, length, actor, dots });
    }
  }

  private createActor(node: GraphNode, rand: () => number): Actor {
    const mood = moodFor(node.kind);
    const radius = BASE_RADIUS * mood.scale * (node.isHead ? 1.1 : 1);
    const group = new THREE.Group();
    const cx = node.x * SX;
    const cy = node.y * SY;
    group.position.set(cx, cy, 0);

    const hull = new THREE.Mesh(this.sphere, this.hullMat);
    hull.scale.setScalar(radius * 1.13);
    const body = new THREE.Mesh(this.sphere, this.bodyMaterial(node.color));
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
      const m = new THREE.Mesh(this.plane, mat);
      m.scale.set(w, h, 1);
      m.position.set(0, y, z);
      face.add(m);
      return m;
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

    let topY = radius * 1.12;
    if (node.kind === 'root') {
      addExtra('sprout', this.kit.sprout, 0.62, 0.62, 0, radius + 0.16);
      topY += 0.5;
    }
    if (node.isHead) {
      addExtra('crown', this.kit.crown, 0.78, 0.62, 0.02, radius + 0.17);
      topY += 0.55;
    }
    if (node.kind === 'feat')
      addExtra('sparkle', this.kit.sparkle, 0.36, 0.36, radius * 0.92, radius * 0.86);
    if (node.kind === 'fix')
      addExtra('sweat', this.kit.sweat, 0.24, 0.32, radius * 0.88, radius * 0.5);

    // branch 標籤（氣泡）往上疊；tag 標籤往下疊
    let up = topY + 0.08;
    let down = radius * 1.12 + 0.08;
    for (const ref of node.refs) {
      if (ref.kind === 'branch') {
        const lab = this.kit.label(ref.name, { fill: node.color, text: OUTLINE_COLOR, tail: true });
        const s = new THREE.Sprite(this.spriteMat(lab.texture));
        s.center.set(0.5, 0);
        s.scale.set(lab.width, lab.height, 1);
        s.position.set(0, up, 0.3);
        s.renderOrder = 8;
        group.add(s);
        up += lab.height + 0.04;
      } else {
        const lab = this.kit.label(`⚑ ${ref.name}`, {
          fill: '#ffe27a',
          text: OUTLINE_COLOR,
          maxChars: 16,
        });
        const s = new THREE.Sprite(this.spriteMat(lab.texture));
        s.center.set(0.5, 1);
        s.scale.set(lab.width * 0.9, lab.height * 0.9, 1);
        s.position.set(0, -down, 0.3);
        s.renderOrder = 8;
        group.add(s);
        down += lab.height * 0.9 + 0.04;
      }
    }

    return {
      node,
      cx,
      cy,
      radius,
      group,
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
    };
  }

  // ───────────────────────── camera ─────────────────────────

  private aspect() {
    return this.width / Math.max(this.height, 1);
  }

  private viewFor(x0: number, x1: number) {
    const L = this.layout;
    const minY = L?.minY ?? 0;
    const maxY = L?.maxY ?? 0;
    const spanW = (x1 - x0) * SX + 6;
    const spanH = (maxY - minY) * SY + 6.2;
    return {
      cx: ((x0 + x1) / 2) * SX,
      cy: ((minY + maxY) / 2) * SY + 0.35,
      viewH: Math.max(spanH, spanW / this.aspect(), 7),
    };
  }

  private flyTo(cx: number, cy: number, viewH: number) {
    this.following = false;
    this.cam.tx = cx;
    this.cam.ty = cy;
    this.cam.tViewH = clamp(viewH, this.minViewH, this.maxViewH);
    this.cam.vx = this.cam.vy = 0;
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
  }

  private clientToWorld(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const nx = (clientX - rect.left) / Math.max(rect.width, 1);
    const ny = (clientY - rect.top) / Math.max(rect.height, 1);
    const vh = this.cam.viewH;
    const vw = vh * this.aspect();
    return { x: this.cam.cx + (nx - 0.5) * vw, y: this.cam.cy - (ny - 0.5) * vh };
  }

  // ───────────────────────── input ─────────────────────────

  private pick(wx: number, wy: number): Actor | null {
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const a of this.actors) {
      if (this.t < a.spawnAt + 0.15) continue;
      const dx = wx - a.cx;
      const dy = wy - a.cy;
      const d = Math.hypot(dx, dy);
      if (d < a.radius * 1.15 && d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  private setHovered(a: Actor | null, clientX = 0, clientY = 0) {
    if (a !== this.hovered) {
      this.hovered = a;
      this.renderer.domElement.style.cursor = a
        ? 'pointer'
        : this.drag?.moved
          ? 'grabbing'
          : 'grab';
    }
    this.opts.onHover?.(a ? { node: a.node, clientX, clientY } : null);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.drag = {
      id: e.pointerId,
      lx: e.clientX,
      ly: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    this.cam.vx = this.cam.vy = 0;
  };

  private onPointerMove = (e: PointerEvent) => {
    const w = this.clientToWorld(e.clientX, e.clientY);
    this.pointer = { cx: e.clientX, cy: e.clientY, wx: w.x, wy: w.y };
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) {
        d.moved = true;
        this.following = false;
        this.setHovered(null);
        this.renderer.domElement.style.cursor = 'grabbing';
      }
      if (d.moved) {
        const upp = this.cam.viewH / this.height;
        const dx = -(e.clientX - d.lx) * upp;
        const dy = (e.clientY - d.ly) * upp;
        this.cam.cx += dx;
        this.cam.cy += dy;
        this.cam.tx = this.cam.cx;
        this.cam.ty = this.cam.cy;
        this.cam.tViewH = this.cam.viewH;
        this.cam.vx = dx * 60;
        this.cam.vy = dy * 60;
      }
      d.lx = e.clientX;
      d.ly = e.clientY;
      return;
    }
    this.setHovered(this.pick(w.x, w.y), e.clientX, e.clientY);
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!d.moved && e.type === 'pointerup') {
      const w = this.clientToWorld(e.clientX, e.clientY);
      const hit = this.pick(w.x, w.y);
      if (hit) this.opts.onSelect?.(hit.node);
    } else {
      this.cam.tx = this.cam.cx;
      this.cam.ty = this.cam.cy;
    }
    canvas.style.cursor = this.hovered ? 'pointer' : 'grab';
  };

  private onPointerLeave = () => {
    this.pointer = null;
    if (!this.drag) this.setHovered(null);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.following = false;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(clamp(e.deltaY * unit, -240, 240) * 0.0014);
    const before = this.clientToWorld(e.clientX, e.clientY);
    const next = clamp(this.cam.viewH * factor, this.minViewH, this.maxViewH);
    const r = next / this.cam.viewH;
    this.cam.cx = before.x - (before.x - this.cam.cx) * r;
    this.cam.cy = before.y - (before.y - this.cam.cy) * r;
    this.cam.viewH = next;
    this.cam.tx = this.cam.cx;
    this.cam.ty = this.cam.cy;
    this.cam.tViewH = next;
    this.cam.vx = this.cam.vy = 0;
  };

  private onDblClick = () => this.fit();

  // ───────────────────────── frame loop ─────────────────────────

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
    this.updateCamera(dt);
    this.updateSky();
    this.updateActors(dt);
    this.updateEdges();
    this.renderer.render(this.scene, this.camera);
  };

  /** 讓外部（測試 / 樣式）知道動畫是否播完：container[data-replay]。 */
  private setReplayState(state: 'idle' | 'playing' | 'done') {
    this.replayState = state;
    this.container.dataset['replay'] = state;
  }

  private updateCamera(dt: number) {
    const c = this.cam;
    const aspect = this.aspect();

    if (this.following) {
      let frontX = 0;
      for (const a of this.actors) if (this.t >= a.spawnAt) frontX = Math.max(frontX, a.cx);
      const vw = c.viewH * aspect;
      c.tx = Math.max(frontX - vw * 0.22, vw / 2 - 3);
      if (this.t > this.replayEnd) {
        this.following = false;
        this.focusHead();
      }
    }

    if (!this.drag?.moved) {
      if (Math.abs(c.vx) > 0.01 || Math.abs(c.vy) > 0.01) {
        c.cx += c.vx * dt;
        c.cy += c.vy * dt;
        c.tx = c.cx;
        c.ty = c.cy;
        const k = Math.exp(-5 * dt);
        c.vx *= k;
        c.vy *= k;
      } else {
        const k = damp(this.following ? 9 : 5.5, dt);
        c.cx += (c.tx - c.cx) * k;
        c.cy += (c.ty - c.cy) * k;
      }
      c.viewH += (c.tViewH - c.viewH) * damp(5.5, dt);
    }

    const L = this.layout;
    if (L) {
      c.cx = clamp(c.cx, -4, L.maxX * SX + 4);
      c.cy = clamp(c.cy, L.minY * SY - 5, L.maxY * SY + 5);
    }

    const halfH = c.viewH / 2;
    const halfW = halfH * aspect;
    const cam = this.camera;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.position.set(c.cx, c.cy, 30);
    cam.updateProjectionMatrix();
  }

  private updateSky() {
    const c = this.cam;
    const vh = c.viewH;
    const vw = vh * this.aspect();

    this.gridMesh.position.set(c.cx, c.cy, -8);
    this.gridMesh.scale.set(vw * 1.05, vh * 1.05, 1);

    if (this.theme === 'day') {
      for (const cl of this.clouds) {
        const sx = (((cl.ox + this.t * cl.speed - (c.cx * cl.parallax) / vw) % 1.3) + 1.3) % 1.3;
        const x = c.cx + (sx - 0.65) * vw * 1.1;
        const y = c.cy + (cl.oy - 0.5) * vh;
        const w = vh * cl.size * 2.2;
        cl.sprite.position.set(x, y, -6);
        cl.sprite.scale.set(w, w * 0.5, 1);
      }
    } else {
      for (const cl of this.clouds) {
        const sx = (((cl.ox + this.t * cl.speed - (c.cx * cl.parallax) / vw) % 1.3) + 1.3) % 1.3;
        cl.sprite.position.set(c.cx + (sx - 0.65) * vw * 1.1, c.cy + (cl.oy - 0.5) * vh, -6);
        const w = vh * cl.size * 2.2;
        cl.sprite.scale.set(w, w * 0.5, 1);
      }
      for (const s of this.stars) {
        const tw = this.reduced ? 1 : 0.55 + 0.45 * Math.sin(this.t * 2 + s.phase);
        s.sprite.position.set(c.cx + (s.ox - 0.5) * vw, c.cy + (s.oy - 0.5) * vh, -7);
        const size = vh * s.size * (0.7 + tw * 0.5);
        s.sprite.scale.set(size, size, 1);
        s.sprite.material.opacity = 0.35 + tw * 0.65;
      }
    }
  }

  private updateActors(dt: number) {
    const c = this.cam;
    const halfW = (c.viewH * this.aspect()) / 2 + 4;
    const halfH = c.viewH / 2 + 4;
    const motion = this.reduced ? 0 : 1;
    const maxX = this.layout?.maxX ?? 0;
    // 沿時間軸掃過的脈衝波（像訊號在流程圖上傳遞）
    const period = (maxX + 10) / 4.5 + 2.5;
    const waveX =
      this.t > this.waveStart && motion ? ((this.t - this.waveStart) % period) * 4.5 - 4 : -1e3;

    for (const a of this.actors) {
      if (this.t < a.spawnAt) {
        a.group.visible = false;
        continue;
      }
      const age = this.t - a.spawnAt;
      a.group.visible = true;
      const onScreen = Math.abs(a.cx - c.cx) < halfW && Math.abs(a.cy - c.cy) < halfH;
      if (!onScreen && age > 1) continue;

      const p = clamp01(age / 0.75);
      const pop = easeOutElastic(p);
      const hop = motion ? Math.sin(clamp01(age / 0.5) * Math.PI) * 0.55 : 0;

      // hover spring
      const target = a === this.hovered ? 1 : 0;
      const h = a.hover;
      h.vel += ((target - h.v) * 260 - h.vel * 17) * dt;
      h.v += h.vel * dt;

      const dxw = a.node.x - waveX;
      const pulse = Math.exp(-(dxw * dxw) / 1.6);
      const breath = Math.sin(this.t * 2.1 + a.phase) * motion;
      const s = pop * (1 + h.v * 0.3 + pulse * 0.16);
      a.group.scale.set(
        s * (1 - breath * 0.03 - h.v * 0.04),
        s * (1 + breath * 0.035 + h.v * 0.04),
        s,
      );
      a.group.position.y =
        a.cy + hop + Math.sin(this.t * 1.5 + a.phase) * 0.05 * motion + h.v * 0.12;

      // 進場光環
      if (age < 0.6 && motion) {
        a.ring.visible = true;
        const r = clamp01(age / 0.6);
        a.ring.scale.setScalar(a.radius * (1 + r * 1.4));
        a.ringMat.opacity = (1 - r) * 0.75;
      } else if (a.ring.visible) {
        a.ring.visible = false;
      }

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
        const dx = this.pointer.wx - a.cx;
        const dy = this.pointer.wy - a.cy;
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
  }

  private updateEdges() {
    for (const e of this.edgeActors) {
      const start = e.parent.spawnAt + 0.1;
      const p = clamp01((this.t - start) / 0.4);
      e.material.uniforms['uReveal']!.value = p >= 1 ? e.length + 1 : easeInOutCubic(p) * e.length;
    }
    for (const s of this.stubs) {
      const p = clamp01((this.t - s.actor.spawnAt) / 0.4);
      s.material.uniforms['uReveal']!.value = p >= 1 ? s.length + 1 : p * s.length;
      s.dots.visible = p > 0.6;
    }
  }
}
