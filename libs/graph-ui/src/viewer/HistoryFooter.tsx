import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, RefObject } from 'react';
import type { Messages } from '../i18n';
import { historyFooterState, shouldAutoLoad } from './history';
import type { HistoryState } from './history';

export interface HistoryFooterProps {
  t: Messages;
  /** 捲動容器：IntersectionObserver 的 root */
  scrollerRef: RefObject<HTMLElement | null>;
  /** layout.truncated（沒有更多可載入時，決定顯示「更早的歷史已省略」還是「最初的 commit 在這裡」） */
  truncated: boolean;
  /** 目前已載入的 commit 數 */
  count: number;
  history?: HistoryState;
  onLoadMore?: () => void;
}

/** 頁尾進入「可視範圍下緣再往下 1.5 個視窗高」就自動載入，使用者捲到底之前下一批通常已經到了。 */
const PRELOAD_MARGIN = '0px 0px 150% 0px';

/**
 * 列表的最後一列：歷史的起點 / 已省略，或 infinite scroll 的觸發點（載入中、失敗重試、手動載入）。
 * 高度固定一列（場景的 track 高度也算這一列），換狀態時列表不會跳動。
 * 換 repo 時由父層用 `key` 重新掛載，「這個數量已經觸發過」的記錄跟著重設。
 */
export function HistoryFooter({
  t,
  scrollerRef,
  truncated,
  count,
  history,
  onLoadMore,
}: HistoryFooterProps) {
  const state = historyFooterState(Boolean(onLoadMore), history);
  const ref = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;
  // 已經用哪個 node 數觸發過：同一個數量只自動觸發一次（載入回來沒有新的 commit 時不會無限迴圈）
  const lastKey = useRef<string | null>(null);
  const key = String(count);

  // 使用端自己清掉錯誤（例如重新整理）之後，允許再自動載入
  const prevState = useRef(state);
  if (prevState.current === 'error' && state === 'idle') lastKey.current = null;
  prevState.current = state;

  // 載入完成後顯示 / 朗讀「已載入 N 個更早的 commit」
  const loadStart = useRef<number | null>(null);
  const prevCount = useRef(count);
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    // 列數變少（重新整理回到第一批）：之前的「已載入 N 個」不再成立
    if (count < prevCount.current) setLoaded(0);
    prevCount.current = count;
    if (state === 'loading') {
      loadStart.current ??= count;
      return;
    }
    if (loadStart.current === null) return;
    setLoaded(state === 'error' ? 0 : Math.max(0, count - loadStart.current));
    loadStart.current = null;
  }, [state, count]);

  // 每次回到閒置（或數量變了）就重新觀察：observe() 一定會先回報一次目前的交集狀態，
  // 所以「載入完了但頁尾仍在附近」（例如一批不夠填滿畫面）也會接著載下一批
  useEffect(() => {
    if (state !== 'idle') return;
    const el = ref.current;
    const root = scrollerRef.current;
    if (!el || !root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const near = entries.some((e) => e.isIntersecting);
        if (!shouldAutoLoad({ state: 'idle', near, key, lastKey: lastKey.current })) return;
        lastKey.current = key;
        loadRef.current?.();
      },
      { root, rootMargin: PRELOAD_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [state, key, scrollerRef]);

  const load = () => {
    lastKey.current = key;
    loadRef.current?.();
  };

  // 按鈕在載入中會消失：焦點原本在按鈕上、而且沒有移到別處時，移回列表，
  // 不然會掉到 body（快捷鍵失效，extension 裡按鍵會漏給 GitHub 頁面）
  const btnFocused = useRef(false);
  useLayoutEffect(() => {
    if (!btnFocused.current || state === 'idle' || state === 'error') return;
    btnFocused.current = false;
    const scope = ref.current?.getRootNode() as Document | ShadowRoot | undefined;
    const active = scope?.activeElement;
    if (active && active !== document.body) return;
    scrollerRef.current?.focus({ preventScroll: true });
  }, [state, scrollerRef]);
  const btnFocus = {
    onFocus: () => {
      btnFocused.current = true;
    },
    // 元素被移除時的 blur（有的瀏覽器會發）沒有 relatedTarget：那種情況交給上面的 effect 處理
    onBlur: (e: FocusEvent<HTMLButtonElement>) => {
      if (e.relatedTarget) btnFocused.current = false;
    },
  };

  const errorDetail = history?.error ? (t.errors[history.error] ?? history.error) : '';
  const message =
    state === 'loading'
      ? t.loadingMore
      : state === 'error'
        ? `${t.loadMoreFailed}${errorDetail ? ` · ${errorDetail}` : ''}`
        : state === 'idle'
          ? loaded > 0
            ? t.loadedMore(loaded)
            : ''
          : truncated
            ? `… ${t.truncated}`
            : t.startOfHistory;

  return (
    <div className="agg-footer" ref={ref} data-state={state}>
      {state === 'loading' && <span className="agg-spinner" aria-hidden="true" />}
      <span
        className="agg-footer-msg"
        role="status"
        aria-live="polite"
        title={state === 'error' ? message : undefined}
      >
        {message}
      </span>
      {state === 'idle' && (
        <button type="button" className="agg-mini-btn agg-footer-btn" onClick={load} {...btnFocus}>
          {t.loadMore}
        </button>
      )}
      {state === 'error' && (
        <button type="button" className="agg-mini-btn agg-footer-btn" onClick={load} {...btnFocus}>
          {t.retry}
        </button>
      )}
    </div>
  );
}
