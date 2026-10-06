import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLayout } from '@adorable/graph-core';
import type { GraphData } from '@adorable/graph-core';
import type { ViewerState } from '@adorable/graph-ui';
import { sendToBackground } from '../shared/messages';
import type { FetchGraphResponse } from '../shared/messages';
import type { RepoRef } from '../shared/repo';

type Fetched =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message?: string; resetAt?: number }
  | { kind: 'ready'; graph: GraphData };

/** 向 background 取得 repo 的 git 歷史，並轉成 viewer 要用的 state。 */
export function useGraph(repo: RepoRef): { state: ViewerState; refresh: () => void } {
  const [fetched, setFetched] = useState<Fetched>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const hintRef = useRef(repo.branchHint);
  hintRef.current = repo.branchHint;
  const force = useRef(false);

  useEffect(() => {
    let alive = true;
    setFetched({ kind: 'loading' });
    sendToBackground<FetchGraphResponse>({
      type: 'fetch-graph',
      owner: repo.owner,
      repo: repo.repo,
      branchHint: hintRef.current,
      force: force.current,
    })
      .then((res) => {
        if (!alive) return;
        if (res?.ok) setFetched({ kind: 'ready', graph: res.data.graph });
        else setFetched({ kind: 'error', ...(res?.error ?? { code: 'unknown' }) });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // 例如 extension 剛更新、舊 content script 失去 background 連線
        setFetched({
          kind: 'error',
          code: 'unknown',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    force.current = false;
    return () => {
      alive = false;
    };
  }, [repo.owner, repo.repo, nonce]);

  const layout = useMemo(
    () => (fetched.kind === 'ready' ? buildLayout(fetched.graph) : null),
    [fetched],
  );

  const state: ViewerState = layout
    ? { kind: 'ready', layout }
    : fetched.kind === 'ready'
      ? { kind: 'loading' }
      : fetched;

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { state, refresh };
}
