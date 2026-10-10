import type { GraphLayout, GraphNode, RefInput } from '@adorable/graph-core';

/**
 * 更早的歷史（infinite scroll）的狀態，由使用端（extension / web app）提供給 GitGraphViewer。
 * 列表捲到接近底部時 viewer 會呼叫 `onLoadMore()`；使用端把更早的 commit 併進 layout（接在後面）並更新這個狀態。
 */
export interface HistoryState {
  /** 還有更早的 commit 可以載入 */
  more: boolean;
  /** 正在載入 */
  loading: boolean;
  /** 上一次載入失敗：錯誤代碼（對得到 `Messages.errors` 就顯示翻譯）或訊息。有值時不自動重試，要按「再試一次」。 */
  error?: string;
}

/**
 * 列表尾端（footer）的狀態，也輸出在 `.agg-footer[data-state]`（給 e2e / 樣式）。
 *   end      沒有更早的可以載入（或使用端不支援）：顯示「更早的歷史已省略」/「最初的 commit 在這裡」
 *   idle     還有更早的：捲到附近就自動載入，也可以按「載入更早的歷史」
 *   loading  載入中
 *   error    載入失敗：顯示「再試一次」
 */
export type HistoryFooterState = 'end' | 'idle' | 'loading' | 'error';

export function historyFooterState(
  canLoadMore: boolean,
  history: HistoryState | undefined,
): HistoryFooterState {
  if (!canLoadMore || !history?.more) return 'end';
  if (history.loading) return 'loading';
  if (history.error) return 'error';
  return 'idle';
}

/**
 * 頁尾進入「可視範圍下方 1.5 個視窗高」時要不要自動呼叫 onLoadMore。
 * `key` 是「repo 識別 + 目前的 node 數」：同一個 key 只自動觸發一次，所以就算載入回來的 commit 全是重複的
 * （node 數沒變、頁尾仍在附近），也不會變成無限迴圈；這時改由使用者按按鈕重試。
 */
export function shouldAutoLoad(opts: {
  state: HistoryFooterState;
  near: boolean;
  key: string;
  lastKey: string | null;
}): boolean {
  return opts.state === 'idle' && opts.near && opts.key !== opts.lastKey;
}

/**
 * `next` 是不是「只在 `prev` 後面接上更早的 commit」（infinite scroll 載入的結果）：
 * 同一個 repo、列數變多、原本的每一列 sha 與順序都沒變。
 * 這種更新不刷新相對時間的「現在」，既有的列也就不用整批重繪。
 */
export function isAppendOnly(prev: GraphLayout | null, next: GraphLayout | null): boolean {
  if (!prev || !next || prev === next) return false;
  if (prev.repo.owner !== next.repo.owner || prev.repo.name !== next.repo.name) return false;
  if (next.nodes.length <= prev.nodes.length || prev.nodes.length === 0) return false;
  for (let i = 0; i < prev.nodes.length; i++) {
    if (prev.nodes[i]!.sha !== next.nodes[i]!.sha) return false;
  }
  return true;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

const sameRef = (a: RefInput, b: RefInput) =>
  a.name === b.name &&
  a.sha === b.sha &&
  a.kind === b.kind &&
  Boolean(a.isDefault) === Boolean(b.isDefault) &&
  a.remote === b.remote;

/**
 * 列表的一列會用到的欄位是否都一樣。重新排版（例如併進更早的歷史）時 node 物件全是新的，
 * 用這個比較讓 memo 過的列只在真的有變時重繪：幾千列時每次載入都整批重繪會卡。
 */
export function sameRowNode(a: GraphNode, b: GraphNode): boolean {
  if (a === b) return true;
  return (
    a.sha === b.sha &&
    a.shortSha === b.shortSha &&
    a.row === b.row &&
    a.lane === b.lane &&
    a.kind === b.kind &&
    a.color === b.color &&
    a.subject === b.subject &&
    a.message === b.message &&
    a.authorName === b.authorName &&
    a.authorLogin === b.authorLogin &&
    a.avatarUrl === b.avatarUrl &&
    a.date === b.date &&
    sameList(a.parents, b.parents) &&
    (a.refs === b.refs ||
      (a.refs.length === b.refs.length && a.refs.every((r, i) => sameRef(r, b.refs[i]!))))
  );
}
