import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import snapshot from 'virtual:git-snapshot';
import { GitHubError, buildLayout, fetchGitHubGraph } from '@adorable/graph-core';
import type { GraphData } from '@adorable/graph-core';
import type { ViewerState } from '@adorable/graph-ui';
import { DEFAULT_REPO, HMR_EVENT, isRepoId, snapshotKey } from './protocol';
import type { GitSnapshot, SnapshotEvent } from './protocol';
import type { Source } from './source';
import { fetchLocalSnapshot } from './localRepos';
import { t } from './i18n';

const GH_CACHE_MS = 10 * 60_000;
const GH_CACHE_PREFIX = 'agg:gh:';
const API_BASE: string | undefined = import.meta.env['VITE_GITHUB_API_BASE'];

/**
 * 本機：預設 repo 是啟動 / 建置當下的快照；dev 時可以切到 dev server 清單裡的其他 repo，
 * 每個 repo 的更新都由 HMR 推送（payload 帶 repo id）。
 * 監聽器一律註冊（不隨目前顯示的來源開關）：切到別處期間發生的 commit，切回來時才不會是舊圖。
 */
function useLocalSnapshot(id: string) {
  const [snaps, setSnaps] = useState<Record<string, GitSnapshot>>(() => ({
    [DEFAULT_REPO]: snapshot,
  }));
  /** 'unknown'：dev server 不認得這個 id；'offline'：連不上 */
  const [missing, setMissing] = useState<Record<string, 'unknown' | 'offline'>>({});

  const forget = useCallback((repo: string) => {
    setMissing((prev) => {
      if (!(repo in prev)) return prev;
      const next = { ...prev };
      delete next[repo];
      return next;
    });
  }, []);

  // 內容沒變就保留舊物件：不重算 layout，場景也就不會被重播、捲動位置不會被重設
  const accept = useCallback(
    (repo: string, next: GitSnapshot) => {
      setSnaps((prev) => {
        const cur = prev[repo];
        return cur && snapshotKey(cur) === snapshotKey(next) ? prev : { ...prev, [repo]: next };
      });
      forget(repo);
    },
    [forget],
  );

  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const onEvent = (e: SnapshotEvent | undefined) => {
      if (e && typeof e.repo === 'string' && isRepoId(e.repo) && e.snapshot) {
        accept(e.repo, e.snapshot);
      }
    };
    hot.on(HMR_EVENT, onEvent);
    return () => hot.off(HMR_EVENT, onEvent);
  }, [accept]);

  const load = useCallback(
    async (repo: string) => {
      const result = await fetchLocalSnapshot(repo);
      if (result === 'unknown') setMissing((prev) => ({ ...prev, [repo]: 'unknown' }));
      else if (result === null) setMissing((prev) => ({ ...prev, [repo]: 'offline' }));
      else accept(repo, result);
    },
    [accept],
  );

  // 非預設 repo：每次選到（包含切回來）都向 dev server 要最新快照——它也會因此（重新）開始監看這個 repo
  useEffect(() => {
    if (!import.meta.env.DEV || id === DEFAULT_REPO) return;
    forget(id);
    void load(id);
  }, [id, load, forget]);

  const refresh = useCallback(() => load(id), [id, load]);
  return { snap: snaps[id], missing: missing[id], refresh };
}

type Remote =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message?: string; resetAt?: number }
  | { kind: 'ready'; graph: GraphData };

interface GhCacheEntry {
  savedAt: number;
  graph: GraphData;
  /** 是否帶 token 抓的：帶 token 抓到的可能是私有 repo，沒有 token 時不能再拿來用。 */
  authed: boolean;
}

function readGhCache(key: string, authed: boolean): GraphData | null {
  try {
    const raw = sessionStorage.getItem(GH_CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as GhCacheEntry;
    if (Date.now() - entry.savedAt >= GH_CACHE_MS) return null;
    if (entry.authed && !authed) return null;
    return entry.graph;
  } catch {
    return null;
  }
}

/** token 變更（含清除）時呼叫：認證後抓到的私有 repo 資料不該在 token 移除後還留在 sessionStorage。 */
export function clearGitHubCache(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(GH_CACHE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

function writeGhCache(key: string, graph: GraphData, authed: boolean) {
  try {
    const entry: GhCacheEntry = { savedAt: Date.now(), graph, authed };
    sessionStorage.setItem(GH_CACHE_PREFIX + key, JSON.stringify(entry));
  } catch {
    /* 容量不足等：略過 */
  }
}

/** 任意 GitHub repo：直接從瀏覽器呼叫 REST API（CORS 允許），結果快取 10 分鐘。 */
function useGitHubGraph(source: Source, token: string) {
  const [remote, setRemote] = useState<Remote>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<{ code: string; message?: string } | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const force = useRef(false);

  const key = source.kind === 'github' ? `${source.owner}/${source.repo}`.toLowerCase() : '';

  useEffect(() => {
    if (source.kind !== 'github') return;
    const forced = force.current;
    force.current = false;
    if (!forced) {
      const hit = readGhCache(key, Boolean(token));
      if (hit) {
        setRefreshing(false);
        setRemote({ kind: 'ready', graph: hit });
        return;
      }
    }

    const ctrl = new AbortController();
    // 重新整理時留著舊圖（捲動位置與選取不動）；換 repo / token 才回到 loading
    setRemote((prev) => (forced && prev.kind === 'ready' ? prev : { kind: 'loading' }));
    setRefreshing(forced);
    setRefreshError(null);
    // 重新整理失敗時保留原本的圖，只回報錯誤
    const fail = (err: { code: string; message?: string; resetAt?: number }) => {
      if (forced && remoteRef.current.kind === 'ready') setRefreshError(err);
      else setRemote({ kind: 'error', ...err });
    };
    fetchGitHubGraph(source.owner, source.repo, {
      token: token || undefined,
      apiBase: API_BASE,
      signal: ctrl.signal,
    }).then(
      (graph) => {
        writeGhCache(key, graph, Boolean(token));
        setRefreshing(false);
        setRemote({ kind: 'ready', graph });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setRefreshing(false);
        if (err instanceof GitHubError) {
          fail({ code: err.code, message: err.message, resetAt: err.resetAt });
        } else {
          fail({ code: 'unknown', message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => ctrl.abort();
    // token 變更要重抓（可能解鎖私有 repo / 提高額度）
  }, [source.kind, key, token, nonce]);

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { remote, refresh, refreshing, refreshError };
}

export interface GraphSource {
  state: ViewerState;
  /** 沒有後端可重讀時（靜態建置的本機快照）為 undefined，UI 不顯示重新整理。 */
  refresh: (() => void) | undefined;
  /** 標題列顯示用 */
  repoName?: { owner: string; name: string };
}

export function useGraphSource(source: Source, token: string): GraphSource {
  // 靜態建置只有預設 repo 的快照（沒有 dev server 可以問）
  const localId =
    import.meta.env.DEV && source.kind === 'local' ? (source.id ?? DEFAULT_REPO) : DEFAULT_REPO;
  const local = useLocalSnapshot(localId);
  const gh = useGitHubGraph(source, token);
  // dev server 說不認得這個 repo 時，不要繼續顯示快取的舊圖（它不會再更新了）
  const localSnap = local.missing === 'unknown' ? undefined : local.snap;

  const graph: GraphData | null =
    source.kind === 'local'
      ? (localSnap?.graph ?? null)
      : gh.remote.kind === 'ready'
        ? gh.remote.graph
        : null;
  // 取得階段已經限制過筆數（AGG_MAX_COMMITS / API 上限），這裡不要再用 buildLayout 預設的 400 偷偷截掉
  const layout = useMemo(
    () => (graph ? buildLayout(graph, { maxCommits: Math.max(graph.commits.length, 1) }) : null),
    [graph],
  );

  let state: ViewerState;
  if (layout) {
    state = {
      kind: 'ready',
      layout,
      refreshing: source.kind === 'github' && gh.refreshing,
      refreshError: (source.kind === 'github' && gh.refreshError) || undefined,
    };
  } else if (source.kind === 'local') {
    // 'local_git' 不在 i18n 錯誤表內，viewer 會直接顯示 message
    const message =
      local.missing === 'unknown'
        ? t.localUnknown
        : localSnap
          ? (localSnap.error ?? t.localFailed)
          : local.missing === 'offline'
            ? t.localOffline
            : undefined;
    state = message ? { kind: 'error', code: 'local_git', message } : { kind: 'loading' };
  } else if (gh.remote.kind === 'error') {
    state = gh.remote;
  } else {
    state = { kind: 'loading' };
  }

  return {
    state,
    refresh:
      source.kind === 'github'
        ? gh.refresh
        : import.meta.env.DEV
          ? () => void local.refresh()
          : undefined,
    repoName: graph ? { owner: graph.repo.owner, name: graph.repo.name } : undefined,
  };
}
