import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import snapshot from 'virtual:git-snapshot';
import { GitHubError, buildLayout, fetchGitHubGraph } from '@adorable/graph-core';
import type { GraphData } from '@adorable/graph-core';
import type { ViewerState } from '@adorable/graph-ui';
import { HMR_EVENT, SNAPSHOT_ENDPOINT } from './protocol';
import type { GitSnapshot } from './protocol';
import type { Source } from './source';

const GH_CACHE_MS = 10 * 60_000;
const GH_CACHE_PREFIX = 'agg:gh:';
const API_BASE: string | undefined = import.meta.env['VITE_GITHUB_API_BASE'];

/** 本機：啟動 / 建置當下的快照 + dev 時由 HMR 推送的更新。 */
function useLocalSnapshot(enabled: boolean) {
  const [snap, setSnap] = useState<GitSnapshot>(snapshot);

  useEffect(() => {
    const hot = import.meta.hot;
    if (!enabled || !hot) return;
    const onUpdate = (data: GitSnapshot) => setSnap(data);
    hot.on(HMR_EVENT, onUpdate);
    return () => hot.off(HMR_EVENT, onUpdate);
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!import.meta.env.DEV) return; // 靜態部署沒有後端，快照是建置當下的
    try {
      const res = await fetch(SNAPSHOT_ENDPOINT, { cache: 'no-store' });
      if (res.ok) setSnap((await res.json()) as GitSnapshot);
    } catch {
      /* dev server 暫時連不上時保留現有畫面 */
    }
  }, []);

  return { snap, refresh };
}

type Remote =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message?: string; resetAt?: number }
  | { kind: 'ready'; graph: GraphData };

function readGhCache(key: string): GraphData | null {
  try {
    const raw = sessionStorage.getItem(GH_CACHE_PREFIX + key);
    if (!raw) return null;
    const { savedAt, graph } = JSON.parse(raw) as { savedAt: number; graph: GraphData };
    return Date.now() - savedAt < GH_CACHE_MS ? graph : null;
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

function writeGhCache(key: string, graph: GraphData) {
  try {
    sessionStorage.setItem(GH_CACHE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), graph }));
  } catch {
    /* 容量不足等：略過 */
  }
}

/** 任意 GitHub repo：直接從瀏覽器呼叫 REST API（CORS 允許），結果快取 10 分鐘。 */
function useGitHubGraph(source: Source, token: string) {
  const [remote, setRemote] = useState<Remote>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const force = useRef(false);

  const key = source.kind === 'github' ? `${source.owner}/${source.repo}`.toLowerCase() : '';

  useEffect(() => {
    if (source.kind !== 'github') return;
    if (!force.current) {
      const hit = readGhCache(key);
      if (hit) {
        setRemote({ kind: 'ready', graph: hit });
        return;
      }
    }
    force.current = false;

    const ctrl = new AbortController();
    setRemote({ kind: 'loading' });
    fetchGitHubGraph(source.owner, source.repo, {
      token: token || undefined,
      apiBase: API_BASE,
      signal: ctrl.signal,
    }).then(
      (graph) => {
        writeGhCache(key, graph);
        setRemote({ kind: 'ready', graph });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof GitHubError) {
          setRemote({ kind: 'error', code: err.code, message: err.message, resetAt: err.resetAt });
        } else {
          setRemote({
            kind: 'error',
            code: 'unknown',
            message: err instanceof Error ? err.message : String(err),
          });
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

  return { remote, refresh };
}

export interface GraphSource {
  state: ViewerState;
  refresh: () => void;
  /** 標題列顯示用 */
  repoName?: { owner: string; name: string };
}

export function useGraphSource(source: Source, token: string): GraphSource {
  const local = useLocalSnapshot(source.kind === 'local');
  const gh = useGitHubGraph(source, token);

  const graph: GraphData | null =
    source.kind === 'local'
      ? local.snap.graph
      : gh.remote.kind === 'ready'
        ? gh.remote.graph
        : null;
  const layout = useMemo(() => (graph ? buildLayout(graph) : null), [graph]);

  let state: ViewerState;
  if (layout) {
    state = { kind: 'ready', layout };
  } else if (source.kind === 'local') {
    // 'local_git' 不在 i18n 錯誤表內，viewer 會直接顯示 message
    state = {
      kind: 'error',
      code: 'local_git',
      message: local.snap.error ?? 'Could not read the local git history.',
    };
  } else if (gh.remote.kind === 'error') {
    state = gh.remote;
  } else {
    state = { kind: 'loading' };
  }

  return {
    state,
    refresh: source.kind === 'local' ? () => void local.refresh() : gh.refresh,
    repoName: graph ? { owner: graph.repo.owner, name: graph.repo.name } : undefined,
  };
}
