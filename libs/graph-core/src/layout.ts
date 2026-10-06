import { colorAt } from './palette.ts';
import type {
  CommitInput,
  CommitKind,
  EdgeKind,
  GraphBranch,
  GraphData,
  GraphEdge,
  GraphLayout,
  GraphNode,
  LayoutOptions,
  RefInput,
} from './types.ts';

const DEFAULT_MAX_COMMITS = 400;
/** 換 lane 時，S 型曲線佔用的 x 長度（grid unit）。 */
const CURVE_LEN = 1;
const CURVE_SAMPLES = 10;

/** lane 序號 → y。0 在中線，奇數往上、偶數往下，交替展開。 */
export function laneY(lane: number): number {
  if (lane === 0) return 0;
  const step = Math.ceil(lane / 2);
  return lane % 2 === 1 ? step : -step;
}

export function classifyCommit(message: string, parentCount: number): CommitKind {
  if (parentCount === 0) return 'root';
  if (parentCount > 1) return 'merge';
  const head = message.trimStart().slice(0, 40).toLowerCase();
  if (/^revert\b/.test(head)) return 'revert';
  const m = /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style)(\([^)]*\))?!?:/.exec(head);
  switch (m?.[1]) {
    case 'feat':
      return 'feat';
    case 'fix':
      return 'fix';
    case 'docs':
      return 'docs';
    case 'chore':
    case 'build':
    case 'ci':
    case 'style':
      return 'chore';
    default:
      return 'normal';
  }
}

interface PendingEdge {
  parent: string;
  child: string;
  kind: 'first' | 'other';
  childLane: number;
  viaLane: number;
  colorIndex: number;
}

/** children-first 的拓樸排序；同層以日期新→舊為先。 */
function topoOrder(commits: Map<string, CommitInput>): string[] {
  const remaining = new Map<string, number>();
  for (const sha of commits.keys()) remaining.set(sha, 0);
  for (const c of commits.values()) {
    for (const p of new Set(c.parents)) {
      if (commits.has(p)) remaining.set(p, (remaining.get(p) ?? 0) + 1);
    }
  }
  const time = (sha: string) => Date.parse(commits.get(sha)?.date ?? '') || 0;
  const ready: string[] = [];
  for (const [sha, n] of remaining) if (n === 0) ready.push(sha);

  const order: string[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i]!;
      const b = ready[best]!;
      if (time(a) > time(b) || (time(a) === time(b) && a > b)) best = i;
    }
    const sha = ready.splice(best, 1)[0]!;
    order.push(sha);
    for (const p of new Set(commits.get(sha)!.parents)) {
      if (!commits.has(p)) continue;
      const left = (remaining.get(p) ?? 0) - 1;
      remaining.set(p, left);
      if (left === 0) ready.push(p);
    }
  }
  return order;
}

function bezier(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Array<[number, number]>,
): void {
  const dx = (x1 - x0) * 0.5;
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const u = 1 - t;
    // cubic bezier, 水平切線 → S 型
    const px =
      u * u * u * x0 + 3 * u * u * t * (x0 + dx) + 3 * u * t * t * (x1 - dx) + t * t * t * x1;
    const py = u * u * u * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y1 + t * t * t * y1;
    out.push([px, py]);
  }
}

/** parent(舊, 左) → child(新, 右) 的折線；換 lane 的 S 曲線只佔兩端 CURVE_LEN。 */
export function routeEdge(
  parent: { x: number; y: number },
  child: { x: number; y: number },
  viaY: number,
): Array<[number, number]> {
  const raw: Array<[number, number]> = [[parent.x, parent.y]];
  const dx = child.x - parent.x;
  const needStart = Math.abs(parent.y - viaY) > 1e-9;
  const needEnd = Math.abs(viaY - child.y) > 1e-9;
  const curves = (needStart ? 1 : 0) + (needEnd ? 1 : 0);
  const len = curves === 0 ? 0 : Math.min(CURVE_LEN, dx / curves);

  if (needStart) bezier(parent.x, parent.y, parent.x + len, viaY, raw);
  if (needEnd) {
    raw.push([child.x - len, viaY]);
    bezier(child.x - len, viaY, child.x, child.y, raw);
  } else {
    raw.push([child.x, child.y]);
  }

  // 去除重複點（零長度線段會讓 ribbon 法線退化）
  const pts: Array<[number, number]> = [];
  for (const p of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
  }
  return pts;
}

export function buildLayout(data: GraphData, options: LayoutOptions = {}): GraphLayout {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;

  // 1. 去重並截取最新 N 筆
  let list = [...new Map(data.commits.map((c) => [c.sha, c])).values()];
  let clipped = false;
  if (list.length > maxCommits) {
    list = list
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
      .slice(0, maxCommits);
    clipped = true;
  }
  const commits = new Map(list.map((c) => [c.sha, c]));

  const order = topoOrder(commits);
  const n = order.length;
  // 循環 / 自己を parent に持つ（壊れた or 偽造された）commit は topoOrder に出てこない。
  // それらを parent とする辺を作ると後段で未配置ノードを参照して落ちるので、配置済みのものだけを辺の対象にする。
  const placed = new Set(order);

  // 2. lane 配置（git log --graph 演算法）
  const defaultRef = data.refs.find((r) => r.kind === 'branch' && r.isDefault);
  const defaultHead = defaultRef && commits.has(defaultRef.sha) ? defaultRef.sha : undefined;

  const lanes: Array<string | null> = [];
  const laneColor: number[] = [];
  let nextColor = 1;
  if (defaultHead) {
    lanes[0] = defaultHead;
    laneColor[0] = 0;
  }
  const firstFree = (): number => {
    let i = 0;
    while (lanes[i] != null) i++;
    return i;
  };

  const nodeLane = new Map<string, number>();
  const nodeColorIndex = new Map<string, number>();
  const pending: PendingEdge[] = [];
  const hidden = new Set<string>();

  for (const sha of order) {
    const c = commits.get(sha)!;
    const waiting: number[] = [];
    lanes.forEach((s, i) => {
      if (s === sha) waiting.push(i);
    });

    if (waiting.length === 0) {
      const lane = firstFree();
      lanes[lane] = sha;
      laneColor[lane] = nextColor++;
      waiting.push(lane);
    }
    const lane = waiting[0]!;
    nodeLane.set(sha, lane);
    nodeColorIndex.set(sha, laneColor[lane] ?? 0);
    for (const j of waiting.slice(1)) lanes[j] = null;
    lanes[lane] = null;

    const parents = [...new Set(c.parents)];
    parents.forEach((p, k) => {
      if (!commits.has(p)) {
        hidden.add(sha);
        return;
      }
      if (!placed.has(p)) return;
      if (k === 0) {
        // 沿用同一條 lane；就算 parent 已被別條 lane 等待，也要保留，避免中途被別的 branch 佔用。
        lanes[lane] = p;
        pending.push({
          parent: p,
          child: sha,
          kind: 'first',
          childLane: lane,
          viaLane: lane,
          colorIndex: laneColor[lane] ?? 0,
        });
        return;
      }
      let via = lanes.indexOf(p);
      if (via === -1) {
        via = firstFree();
        lanes[via] = p;
        laneColor[via] = nextColor++;
      }
      pending.push({
        parent: p,
        child: sha,
        kind: 'other',
        childLane: lane,
        viaLane: via,
        colorIndex: laneColor[via] ?? 0,
      });
    });
    // 第一個 parent 不在範圍內 → lane 結束
  }

  // 3. 節點
  const refsBySha = new Map<string, RefInput[]>();
  for (const r of data.refs) {
    if (!commits.has(r.sha)) continue;
    const arr = refsBySha.get(r.sha) ?? [];
    arr.push(r);
    refsBySha.set(r.sha, arr);
  }

  const nodes: GraphNode[] = [];
  const nodeBySha = new Map<string, GraphNode>();
  order.forEach((sha, i) => {
    const c = commits.get(sha)!;
    const lane = nodeLane.get(sha)!;
    const colorIndex = nodeColorIndex.get(sha)!;
    const [subject = ''] = c.message.split('\n');
    const parentCount = new Set(c.parents).size;
    const node: GraphNode = {
      sha,
      shortSha: sha.slice(0, 7),
      x: n - 1 - i,
      lane,
      y: laneY(lane),
      colorIndex,
      color: colorAt(colorIndex),
      kind: classifyCommit(c.message, parentCount),
      subject: subject.trim(),
      message: c.message,
      authorName: c.authorName,
      authorLogin: c.authorLogin,
      avatarUrl: c.avatarUrl,
      date: c.date,
      url: c.url,
      refs: refsBySha.get(sha) ?? [],
      parents: c.parents,
      isHead: sha === defaultHead,
      hasHiddenParents: hidden.has(sha),
    };
    nodes.push(node);
    nodeBySha.set(sha, node);
  });
  nodes.reverse(); // 由舊到新

  // 4. 邊
  const edges: GraphEdge[] = pending.map((e) => {
    const parent = nodeBySha.get(e.parent)!;
    const child = nodeBySha.get(e.child)!;
    const kind: EdgeKind =
      e.kind === 'other' ? 'merge' : parent.lane === child.lane ? 'main' : 'fork';
    return {
      from: parent.sha,
      to: child.sha,
      kind,
      colorIndex: e.colorIndex,
      color: colorAt(e.colorIndex),
      points: routeEdge(parent, child, laneY(e.viaLane)),
    };
  });

  // 5. 圖例 / 範圍
  const branches: GraphBranch[] = data.refs
    .filter((r) => r.kind === 'branch' && nodeBySha.has(r.sha))
    .map((r) => ({
      name: r.name,
      sha: r.sha,
      color: nodeBySha.get(r.sha)!.color,
      isDefault: Boolean(r.isDefault),
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  let minY = 0;
  let maxY = 0;
  let laneCount = 0;
  for (const node of nodes) {
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y);
    laneCount = Math.max(laneCount, node.lane + 1);
  }
  for (const e of edges) {
    for (const [, y] of e.points) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  return {
    repo: data.repo,
    nodes,
    edges,
    branches,
    maxX: Math.max(0, n - 1),
    laneCount,
    minY,
    maxY,
    truncated: Boolean(data.truncated) || clipped || hidden.size > 0,
  };
}
