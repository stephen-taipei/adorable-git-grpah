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
  const [refreshing, setRefreshing] = useState(false);
  const hintRef = useRef(repo.branchHint);
  hintRef.current = repo.branchHint;
  const force = useRef(false);

  useEffect(() => {
    let alive = true;
    // 使用者按「重新整理」且已經有這個 repo 的圖：留著舊圖（捲動位置、選取、詳情都不動），背景重抓；
    // 換 repo 或第一次載入才回到 loading（絕不顯示別的 repo 的舊圖）。
    const forced = force.current;
    force.current = false;
    setFetched((prev) => (forced && prev.kind === 'ready' ? prev : { kind: 'loading' }));
    setRefreshing(forced);
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
        if (res?.ok) setFetched({ kind: 'ready', graph: res.data.graph });
        else setFetched({ kind: 'error', ...(res?.error ?? { code: 'unknown' }) });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setRefreshing(false);
        // 例如 extension 剛更新、舊 content script 失去 background 連線
        setFetched({
          kind: 'error',
          code: 'unknown',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      alive = false;
    };
  }, [repo.owner, repo.repo, nonce]);

  const layout = useMemo(
    () => (fetched.kind === 'ready' ? buildLayout(fetched.graph) : null),
    [fetched],
  );

  const state: ViewerState = layout
    ? { kind: 'ready', layout, refreshing }
    : fetched.kind === 'ready'
      ? { kind: 'loading' }
      : fetched;

  const refresh = useCallback(() => {
    force.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { state, refresh };
}
