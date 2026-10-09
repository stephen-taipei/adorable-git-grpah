import type { GraphBranch, GraphLayout, GraphNode } from './types.ts';

/** 畫面上顯示的 git 統計與查詢（純函式，只看已載入的範圍）。 */

export interface AuthorStat {
  name: string;
  login?: string;
  avatarUrl?: string;
  commits: number;
}

export interface GraphStats {
  commits: number;
  /** parent 數 > 1 的 commit */
  merges: number;
  branches: number;
  /** 不重複的 tag 名稱數 */
  tags: number;
  /** 依 commit 數由多到少 */
  authors: AuthorStat[];
  /** 範圍內最舊 / 最新 commit 的時間（ISO） */
  firstDate?: string;
  lastDate?: string;
}

const time = (iso: string) => Date.parse(iso);

export function computeStats(layout: GraphLayout): GraphStats {
  const authors = new Map<string, AuthorStat>();
  const tags = new Set<string>();
  let merges = 0;
  let first: GraphNode | undefined;
  let last: GraphNode | undefined;
  for (const n of layout.nodes) {
    if (new Set(n.parents).size > 1) merges++;
    for (const r of n.refs) if (r.kind === 'tag') tags.add(r.name);
    const key = n.authorLogin ?? n.authorName;
    const a = authors.get(key);
    if (a) {
      a.commits++;
      a.avatarUrl ??= n.avatarUrl;
    } else {
      authors.set(key, {
        name: n.authorName,
        login: n.authorLogin,
        avatarUrl: n.avatarUrl,
        commits: 1,
      });
    }
    const t = time(n.date);
    if (!Number.isNaN(t)) {
      if (!first || t < time(first.date)) first = n;
      if (!last || t > time(last.date)) last = n;
    }
  }
  return {
    commits: layout.nodes.length,
    merges,
    branches: layout.branches.length,
    tags: tags.size,
    authors: [...authors.values()].sort(
      (a, b) => b.commits - a.commits || a.name.localeCompare(b.name),
    ),
    firstDate: first?.date,
    lastDate: last?.date,
  };
}

/** 從 `sha` 沿 parent 走得到的所有 commit（含自己）。只限已載入範圍。 */
export function reachableFrom(layout: GraphLayout, sha: string): Set<string> {
  return walk(new Map(layout.nodes.map((n) => [n.sha, n])), sha);
}

function walk(bySha: Map<string, GraphNode>, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const node = bySha.get(sha);
    if (!node) continue;
    seen.add(sha);
    for (const p of node.parents) stack.push(p);
  }
  return seen;
}

/** branch 名稱 → 該 branch 的 tip 可到達的 commit 集合。一次建好，供「包含此 commit 的 branch」與「領先幾個 commit」使用。 */
export function buildReachability(layout: GraphLayout): Map<string, Set<string>> {
  const bySha = new Map(layout.nodes.map((n) => [n.sha, n]));
  const out = new Map<string, Set<string>>();
  for (const b of layout.branches) out.set(b.name, walk(bySha, b.sha));
  return out;
}

/** 哪些 branch 包含這個 commit（tip 可到達它）。順序同 `layout.branches`。 */
export function branchesContaining(
  layout: GraphLayout,
  reach: ReadonlyMap<string, ReadonlySet<string>>,
  sha: string,
): GraphBranch[] {
  return layout.branches.filter((b) => reach.get(b.name)?.has(sha));
}

/** `branch` 比 `base` 多出幾個 commit（`git rev-list base..branch --count`，只算已載入範圍）。 */
export function aheadCount(
  reach: ReadonlyMap<string, ReadonlySet<string>>,
  branch: string,
  base: string,
): number {
  const a = reach.get(branch);
  const b = reach.get(base);
  if (!a) return 0;
  if (!b) return a.size;
  let n = 0;
  for (const sha of a) if (!b.has(sha)) n++;
  return n;
}

/**
 * 搜尋：空白分隔的每個詞都要出現在「標題 / 內文 / 作者 / sha / ref 名稱」之中（不分大小寫）。
 * 空查詢＝全部符合。
 */
export function matchesQuery(node: GraphNode, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = [
    node.message,
    node.authorName,
    node.authorLogin ?? '',
    node.sha,
    ...node.refs.map((r) => r.name),
  ]
    .join('\n')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
