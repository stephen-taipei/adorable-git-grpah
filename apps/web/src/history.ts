import { MAX_DEPTH } from './protocol';

/**
 * 更早的歷史（infinite scroll）的共用規則：本機（向 dev server 要更深的快照）與 GitHub（從缺的 parent 往回抓）都用。
 */

/** 一次多要幾筆 */
export const HISTORY_PAGE = 300;

/** 下一次要讀到多深：已載入 + 一頁，最多 MAX_DEPTH。 */
export const nextDepth = (loaded: number): number =>
  Math.min(MAX_DEPTH, Math.max(1, Math.floor(loaded)) + HISTORY_PAGE);

export interface PagingState {
  loading: boolean;
  /** 上一次載入失敗的原因（錯誤代碼或已翻譯的訊息）；有值時 viewer 顯示「再試一次」，不自動重試 */
  error?: string;
  /**
   * 上一次載入完 commit 數沒有變多（shallow clone 的邊界、GitHub 回來的全是已有的）：
   * 這個數量就是盡頭了，不要再顯示「還有更早的」。之後 commit 數變了（有新 commit）就重新判斷。
   */
  exhaustedAt?: number;
}

/** 還能不能往前載入：來源說被截斷了、還沒到上限、上一次也不是白跑。 */
export function hasMore(
  truncated: boolean | undefined,
  loaded: number,
  paging: PagingState | undefined,
): boolean {
  if (!truncated || loaded >= MAX_DEPTH) return false;
  return paging?.exhaustedAt === undefined || loaded > paging.exhaustedAt;
}

/** 載入完成：commit 數沒變多就記下盡頭。 */
export const settled = (before: number, after: number): PagingState =>
  after <= before ? { loading: false, exhaustedAt: after } : { loading: false };
