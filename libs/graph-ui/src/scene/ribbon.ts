import * as THREE from 'three';

export interface RibbonGeometry {
  geometry: THREE.BufferGeometry;
  /** 折線總長（world unit） */
  length: number;
}

/**
 * 沿折線展開的帶狀 mesh。
 * aU = 累積距離、aV = 橫切面 -1..1，shader 用來畫描邊與流動箭頭。
 */
export function buildRibbon(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  z = 0,
): RibbonGeometry {
  const n = points.length;
  const half = width / 2;
  const positions = new Float32Array(n * 2 * 3);
  const us = new Float32Array(n * 2);
  const vs = new Float32Array(n * 2);

  // 每段單位切線
  const tangents: Array<[number, number]> = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    tangents.push([(x1 - x0) / l, (y1 - y0) / l]);
  }
  if (tangents.length === 0) tangents.push([1, 0]);

  let acc = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i]!;
    if (i > 0) {
      const [px, py] = points[i - 1]!;
      acc += Math.hypot(x - px, y - py);
    }
    const a = tangents[Math.max(0, i - 1)]!;
    const b = tangents[Math.min(tangents.length - 1, i)]!;
    // 兩段法線平均 → 轉角處平順，並限制 miter 長度
    let nx = -(a[1] + b[1]);
    let ny = a[0] + b[0];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const dot = nx * -a[1] + ny * a[0];
    const miter = 1 / Math.max(dot, 0.5);
    const o = i * 2;
    positions.set([x + nx * half * miter, y + ny * half * miter, z], o * 3);
    positions.set([x - nx * half * miter, y - ny * half * miter, z], (o + 1) * 3);
    us[o] = acc;
    us[o + 1] = acc;
    vs[o] = 1;
    vs[o + 1] = -1;
  }

  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const o = i * 2;
    index.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geometry.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return { geometry, length: acc };
}
