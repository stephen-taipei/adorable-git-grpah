import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitAction, RepoStatus } from './protocol';
import { fetchRepoStatus, runGitAction } from './git';
import type { ActionOutcome } from './git';
import { progressNotice, resultNotice } from './gitMessages';
import type { Notice } from './gitMessages';

/** 顯示期間多久重新讀一次狀態（在編輯器裡改了檔案、但瀏覽器分頁一直在前景時，變更數也要跟上） */
const POLL_MS = 30_000;

export type GitDialogState =
  | { kind: 'push' }
  | { kind: 'stash' }
  /** `target`：要建立 tag 的 commit（sha）；`head`：從動作列開的（在 HEAD 上） */
  | { kind: 'tag'; target: string; head: boolean }
  /** `base`：新 branch / detached 的起點（sha；省略 = HEAD） */
  | { kind: 'worktree'; base?: string };

export interface GitControl {
  /** 目前顯示的本機 repo（null = 不是本機來源 / 靜態建置） */
  repo: string | null;
  /** null：這個 repo 沒有狀態可看（區網的畫面、靜態建置、不是 git repo…），整個 git UI 都不顯示 */
  status: RepoStatus | null;
  /** 正在執行的動作（一次只跑一個：server 也有同樣的鎖） */
  running: GitAction | null;
  refresh: () => void;
  /** 執行一個動作：結果交給呼叫端顯示；完成後會重新讀狀態（圖由 dev server 的 HMR 推送更新） */
  run: (action: GitAction) => Promise<ActionOutcome | null>;
  /** 執行並把進度 / 結果顯示在動作列下方的狀態列（fetch / pull / push） */
  runInBar: (action: GitAction) => Promise<void>;
  /** 動作列下方的狀態列 */
  notice: Notice | null;
  dismissNotice: () => void;
  dialog: GitDialogState | null;
  openDialog: (d: GitDialogState) => void;
  closeDialog: () => void;
}

/**
 * 本機 repo 的狀態（branch、ahead / behind、變更、stash、worktree）與 git 動作。
 * `graph`：目前的圖（快照）。它換了（新 commit、checkout、fetch…）就重新讀狀態。
 */
export function useGitControl(repo: string | null, graph: unknown): GitControl {
  const [statuses, setStatuses] = useState<Record<string, RepoStatus | null>>({});
  const [running, setRunning] = useState<GitAction | null>(null);
  const [dialog, setDialog] = useState<GitDialogState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const repoRef = useRef(repo);
  repoRef.current = repo;
  const seq = useRef(0);
  const runningRef = useRef(false);

  const load = useCallback(async (id: string) => {
    const mine = ++seq.current;
    const result = await fetchRepoStatus(id);
    // 比較晚發出的請求已經回來了（例如動作完成後的重讀）：舊的不要蓋掉新的
    if (mine !== seq.current) return;
    if (result.kind === 'ok') setStatuses((prev) => ({ ...prev, [id]: result.status }));
    else if (result.kind === 'unavailable') setStatuses((prev) => ({ ...prev, [id]: null }));
    // 'error'（git 忙碌、暫時連不上）：保留上一次的狀態
  }, []);

  const refresh = useCallback(() => {
    if (repoRef.current) void load(repoRef.current);
  }, [load]);

  // 換 repo、快照變了：重讀；回到這個分頁 / 視窗時、顯示期間每 30 秒也重讀
  useEffect(() => {
    if (!repo) return;
    void load(repo);
  }, [repo, graph, load]);

  useEffect(() => {
    if (!repo) return;
    const again = () => {
      if (!document.hidden) void load(repo);
    };
    const timer = setInterval(again, POLL_MS);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [repo, load]);

  // 換 repo：對話框與訊息是針對原本那個 repo 的，收掉
  useEffect(() => {
    setDialog(null);
    setNotice(null);
  }, [repo]);

  const run = useCallback(
    async (action: GitAction): Promise<ActionOutcome | null> => {
      const id = repoRef.current;
      if (!id || runningRef.current) return null;
      runningRef.current = true;
      setRunning(action);
      try {
        const result = await runGitAction(id, action);
        await load(id);
        // 執行期間換到別的 repo：結果是舊 repo 的，不要顯示在新的畫面上
        return repoRef.current === id ? result : null;
      } finally {
        runningRef.current = false;
        setRunning(null);
      }
    },
    [load],
  );

  const statusRef = useRef<RepoStatus | null>(null);
  statusRef.current = repo ? (statuses[repo] ?? null) : null;

  const runInBar = useCallback(
    async (action: GitAction) => {
      if (runningRef.current) return;
      const before = statusRef.current;
      setNotice(progressNotice(action));
      const result = await run(action);
      // null：沒有執行（另一個動作還在跑）或已經換了 repo（訊息在換 repo 時已經清掉）
      if (result) setNotice(resultNotice(action, result, before));
    },
    [run],
  );
  const dismissNotice = useCallback(() => setNotice(null), []);

  const openDialog = useCallback((d: GitDialogState) => setDialog(d), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  return {
    repo,
    status: statusRef.current,
    running,
    refresh,
    run,
    runInBar,
    notice,
    dismissNotice,
    dialog,
    openDialog,
    closeDialog,
  };
}
