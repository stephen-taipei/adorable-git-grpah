import { appendCommits, isValidRepoSegment, missingParents } from '@adorable/graph-core';
import type { CommitInput, GraphData } from '@adorable/graph-core';
import { FETCH_MORE_MAX_STARTS, HISTORY_LIMIT } from './messages';
import type { BgRequest } from './messages';

type FetchMoreRequest = Extract<BgRequest, { type: 'fetch-more' }>;

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * background 收到的 fetch-more 請求是否合法：owner / repo 是合法的 repo 名稱、shas 是 1–FETCH_MORE_MAX_STARTS 個
 * 40 位 hex。不合法回傳 null（不碰網路）。回傳值是新建的物件，不帶任何多餘的欄位。
 */
export function parseFetchMore(raw: unknown): FetchMoreRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'fetch-more') return null;
  const { owner, repo, shas } = r;
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;
  if (!Array.isArray(shas) || shas.length === 0 || shas.length > FETCH_MORE_MAX_STARTS) return null;
  if (!shas.every((s): s is string => typeof s === 'string' && SHA_RE.test(s))) return null;
  return { type: 'fetch-more', owner, repo, shas: [...shas] };
}

/**
 * 下一批要從哪些 missing parent 往回抓：去掉已經確認抓不到的（`dead`），最多 FETCH_MORE_MAX_STARTS 個；
 * 已載入的數量到 HISTORY_LIMIT 就不再抓（回傳空陣列 = 沒有更多可以載入）。
 */
export function nextStarts(graph: GraphData, dead: ReadonlySet<string>): string[] {
  if (graph.commits.length >= HISTORY_LIMIT) return [];
  return missingParents(graph)
    .filter((sha) => !dead.has(sha))
    .slice(0, FETCH_MORE_MAX_STARTS);
}

/**
 * 把一批更早的 commit 併進來。請求過、回來之後卻仍然不在圖裡的起點（GitHub 已經不認得，例如 force push 後被回收）
 * 記進 `dead`，之後不再從它往回抓，否則「還有更早的」永遠不會結束。沒有任何變化時回傳原本的物件。
 */
export function mergeOlder(
  graph: GraphData,
  dead: ReadonlySet<string>,
  requested: readonly string[],
  older: readonly CommitInput[],
): { graph: GraphData; dead: ReadonlySet<string> } {
  const next = appendCommits(graph, older);
  const have = new Set(next.commits.map((c) => c.sha));
  const gone = requested.filter((sha) => !have.has(sha) && !dead.has(sha));
  return { graph: next, dead: gone.length > 0 ? new Set([...dead, ...gone]) : dead };
}
