import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLayout } from '@adorable/graph-core';
import type { GraphData } from '@adorable/graph-core';
import type { HistoryState, ViewerState } from '@adorable/graph-ui';
import { mergeOlder, nextStarts } from '../shared/history';
import { FETCH_MORE_MAX_STARTS, HISTORY_LIMIT, sendToBackground } from '../shared/messages';
import type { FetchGraphResponse, FetchMoreResponse } from '../shared/messages';
import type { RepoRef } from '../shared/repo';

type Fetched =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message?: string; resetAt?: number }
  /** `dead`：GitHub 已經不認得、不再往回抓的 missing parent（見 mergeOlder）。 */
  | { kind: 'ready'; graph: GraphData; dead: ReadonlySet<string> };

const NO_DEAD: ReadonlySet<string> = new Set();
/**
 * 排版時保留的 commit 上限：一批最多 FETCH_MORE_MAX_STARTS × 100 筆，所以就算在 HISTORY_LIMIT 附近又載入一批，
 * buildLayout 也不會把中間的 commit 截掉（預設的 400 筆會讓往回載入的 commit 全被裁掉）。
 */
const LAYOUT_MAX_COMMITS = HISTORY_LIMIT + FETCH_MORE_MAX_STARTS * 100;

export interface UseGraph {
  state: ViewerState;
  refresh: () => void;
  /** infinite scroll：從目前的 missing parent 往回再載入一批（已在載入中 / 沒有更多時什麼都不做）。 */
  loadMore: () => void;
  /** 給 GitGraphViewer 的 `history`（圖還沒好時是 undefined）。 */
  history: HistoryState | undefined;
}

/** 向 background 取得 repo 的 git 歷史，並轉成 viewer 要用的 state。 */
export function useGraph(repo: RepoRef): UseGraph {
  const [fetched, setFetched] = useState<Fetched>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<{ code: string; message?: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);
  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;
  const hintRef = useRef(repo.branchHint);
  hintRef.current = repo.branchHint;
  const force = useRef(false);
  // 每次（重新）抓第一批就換一代：上一代還沒回來的「更早的歷史」結果直接丟掉（不會併進別的 repo / 新抓的圖）
  const generation = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    let alive = true;
    generation.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setMoreError(undefined);
    // 使用者按「重新整理」且已經有這個 repo 的圖：留著舊圖（捲動位置、選取、詳情都不動），背景重抓；
    // 換 repo 或第一次載入才回到 loading（絕不顯示別的 repo 的舊圖）。
    const forced = force.current;
    force.current = false;
    setFetched((prev) => (forced && prev.kind === 'ready' ? prev : { kind: 'loading' }));
    setRefreshing(forced);
    setRefreshError(null);
    // 背景重新抓取失敗時保留原本的圖，只回報錯誤（不要讓使用者的捲動位置與選取跟著消失）
    const fail = (err: { code: string; message?: string; resetAt?: number }) => {
      if (forced && fetchedRef.current.kind === 'ready') setRefreshError(err);
      else setFetched({ kind: 'error', ...err });
    };
    sendToBackground<FetchGraphResponse>({
      type: 'fetch-graph',
      owner: repo.owner,
      repo: repo.repo,
      branchHint: hintRef.current,
      force: forced,
    })
      .then((res) => {
        if (!alive) return;
        setRefreshing(false);
        // 重新整理 = 回到第一批（之前往回載入的更早歷史不保留）
        if (res?.ok) setFetched({ kind: 'ready', graph: res.data.graph, dead: NO_DEAD });
        else fail(res?.error ?? { code: 'unknown' });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setRefreshing(false);
        // 例如 extension 剛更新、舊 content script 失去 background 連線
        fail({ code: 'unknown', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
  }, [repo.owner, repo.repo, nonce]);

  const layout = useMemo(
    () =>
      fetched.kind === 'ready'
        ? buildLayout(fetched.graph, { maxCommits: LAYOUT_MAX_COMMITS })
        : null,
    [fetched],
  );

  const hasMore = useMemo(
    () => fetched.kind === 'ready' && nextStarts(fetched.graph, fetched.dead).length > 0,
    [fetched],
  );

  const state: ViewerState = layout
    ? { kind: 'ready', layout, refreshing, refreshError: refreshError ?? undefined }
    : fetched.kind === 'ready'
      ? { kind: 'loading' }
      : fetched;

  const history = useMemo<HistoryState | undefined>(
    () => (layout ? { more: hasMore, loading: loadingMore, error: moreError } : undefined),
    [layout, hasMore, loadingMore, moreError],
  );

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  const loadMore = useCallback(() => {
    const cur = fetchedRef.current;
    if (cur.kind !== 'ready' || loadingMoreRef.current) return;
    const shas = nextStarts(cur.graph, cur.dead);
    if (shas.length === 0) return;
    const gen = generation.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(undefined);
    const done = (error?: string) => {
      if (generation.current !== gen) return;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setMoreError(error);
    };
    sendToBackground<FetchMoreResponse>({
      type: 'fetch-more',
      owner: repo.owner,
      repo: repo.repo,
      shas,
    })
      .then((res) => {
        if (generation.current !== gen) return;
        if (!res?.ok) return done(res?.error?.code ?? 'unknown');
        setFetched((prev) => {
          if (prev.kind !== 'ready') return prev;
          const next = mergeOlder(prev.graph, prev.dead, shas, res.data.commits);
          return next.graph === prev.graph && next.dead === prev.dead
            ? prev
            : { kind: 'ready', ...next };
        });
        done();
      })
      .catch(() => done('unknown'));
  }, [repo.owner, repo.repo]);

  return { state, refresh, loadMore, history };
}
