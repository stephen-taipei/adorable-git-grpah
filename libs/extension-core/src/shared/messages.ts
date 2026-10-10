import type { CommitInput, GraphData } from '@adorable/graph-core';

/** 一次「載入更早的歷史」最多從幾個 missing parent 往回抓（每個起點一個 API 請求）。 */
export const FETCH_MORE_MAX_STARTS = 5;
/** 已載入的 commit 到這個數量就不再往回載入（infinite scroll 的上限，和 web app 的 MAX_DEPTH 一致）。 */
export const HISTORY_LIMIT = 5000;

export type BgRequest =
  | { type: 'fetch-graph'; owner: string; repo: string; branchHint?: string; force?: boolean }
  /** infinite scroll：從這些 missing parent（40 位 hex，最多 FETCH_MORE_MAX_STARTS 個）各往回抓一頁。 */
  | { type: 'fetch-more'; owner: string; repo: string; shas: string[] }
  | { type: 'open-options' }
  | { type: 'rate-limit' }
  | { type: 'clear-cache' };

export interface BgError {
  code: string;
  message: string;
  resetAt?: number;
}

export type BgResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: BgError };

export type FetchGraphResponse = BgResponse<{ graph: GraphData; fromCache: boolean }>;
export type FetchMoreResponse = BgResponse<{ commits: CommitInput[] }>;
export type RateLimitResponse = BgResponse<{
  limit: number;
  remaining: number;
  reset: number;
  authenticated: boolean;
}>;

export type TabCommand = { type: 'toggle' };

/** content script / options page → background 的簡易 RPC。 */
export function sendToBackground<R extends BgResponse>(req: BgRequest): Promise<R> {
  return chrome.runtime.sendMessage(req) as Promise<R>;
}
