import type { GraphData } from '@adorable/graph-core';

/** Vite plugin（node 端）與瀏覽器共用的協定。不可 import 任何 node 模組。 */
export interface GitSnapshot {
  graph: GraphData | null;
  /** graph 為 null 時的原因（例如不是 git repo）。 */
  error?: string;
  /** error 的種類：畫面依此顯示在地化的說明（不認得的種類就直接顯示 error）。 */
  code?: SnapshotErrorCode;
  /** 暫時性的 git 錯誤（例如 gc / fetch 進行中）。已經有好的圖時，dev plugin 會保留舊圖；第一次讀取就失敗時才會帶著這個旗標送出。 */
  transient?: boolean;
  generatedAt: number;
}

export type SnapshotErrorCode = 'missing_dir' | 'not_git' | 'no_git' | 'unsafe_repo' | 'git_error';

export const HMR_EVENT = 'agg:git-snapshot';
/** `GET ?repo=<id>`：某個本機 repo 的快照（省略 repo = 預設 repo）。只有 dev server 有。 */
export const SNAPSHOT_ENDPOINT = '/__agg/git-snapshot';
/** `GET`：dev server 掃描到、可以選擇的本機 repo 清單。只有 dev server 有。 */
export const REPOS_ENDPOINT = '/__agg/repos';

/** 啟動時指定的 repo（AGG_REPO_DIR，否則是執行 vite 的目錄）。 */
export const DEFAULT_REPO = 'default';

/** 其他 repo 的 id 是 dev server 對其路徑算出的短雜湊：瀏覽器只能從清單裡挑，永遠不會送出路徑。 */
export const isRepoId = (s: string): boolean => s === DEFAULT_REPO || /^[0-9a-f]{12}$/.test(s);

export interface LocalRepo {
  id: string;
  /** 資料夾名稱 */
  name: string;
  /** 顯示用的位置（家目錄縮寫成 ~） */
  label: string;
  isDefault: boolean;
}

export interface ReposResponse {
  repos: LocalRepo[];
  /** 掃描到上限而停止（清單不完整） */
  truncated: boolean;
}

/**
 * HMR 推送：哪個 repo 有了新快照。HMR 會廣播給所有連線（`vite --host` 時含區網裡的裝置），
 * 所以只有預設 repo（內容本來就在 bundle 裡）帶 snapshot；其他 repo 只通知，畫面再向只回應本機的 endpoint 拿。
 */
export interface SnapshotEvent {
  repo: string;
  snapshot?: GitSnapshot;
}

/** 比較用：忽略每次讀取都會變的時間戳，只看內容有沒有變。 */
export const snapshotKey = (s: GitSnapshot): string =>
  JSON.stringify({ ...s, generatedAt: 0, graph: s.graph && { ...s.graph, fetchedAt: 0 } });

// ───────────────────────── 本機 repo 的狀態與 git 動作（只有 dev server、只回應本機） ─────────────────────────

/** `GET ?repo=<id>`：某個本機 repo 的狀態（branch、ahead / behind、變更、stash、worktree…）。只回應本機的同源請求。 */
export const STATUS_ENDPOINT = '/__agg/status';
/** `POST { repo, action }`（JSON）：執行一個 git 動作。只接受本機同源頁面送來的 JSON。 */
export const GIT_ENDPOINT = '/__agg/git';
/** 一次最多讀幾筆 commit（infinite scroll 的上限）。 */
export const MAX_DEPTH = 5000;

export interface WorktreeInfo {
  /** 與 LocalRepo.id 同一個 id 空間：可以用 `?local=<id>` 開啟（啟動時的預設 repo 是 `default`） */
  id: string;
  /** 顯示用的位置（家目錄縮寫成 ~）；只會送給本機 */
  label: string;
  /** null = detached HEAD（bare repo 的主 worktree 也是 null） */
  branch: string | null;
  /** HEAD 的 sha（bare / 還沒有 commit 時是空字串） */
  head: string;
  /** 就是正在看的這個 repo */
  current: boolean;
  /** 主 worktree（不能移除） */
  main: boolean;
  locked: boolean;
  /** 資料夾已經不在了（`git worktree prune` 會清掉） */
  prunable: boolean;
}

export interface RepoStatus {
  /** null = detached HEAD */
  branch: string | null;
  /** null = 還沒有任何 commit */
  head: string | null;
  /** 例如 'origin/main'；沒有設定 upstream 時是 null */
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: { staged: number; unstaged: number; untracked: number; conflicted: number };
  remotes: string[];
  /** index 就是 `stash@{index}`；date 是 ISO 8601 */
  stashes: { index: number; message: string; date: string }[];
  worktrees: WorktreeInfo[];
  /** 進行中的操作（`git am` 也算 'rebase'） */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  bare: boolean;
}

/**
 * 畫面能要求的 git 動作。server 端會重新驗證每個欄位，而且只組固定的參數（不會 force、pull 只做 fast-forward）。
 * 會丟掉資料或改到遠端的動作（push、stash-drop、tag-delete、worktree-remove）必須帶 `confirm: true`。
 */
export type GitAction =
  | { type: 'fetch' }
  | { type: 'pull' }
  | { type: 'push'; confirm: true; setUpstream?: { remote: string } }
  | { type: 'stash-save'; message?: string; includeUntracked?: boolean }
  | { type: 'stash-apply'; index: number }
  | { type: 'stash-pop'; index: number }
  | { type: 'stash-drop'; index: number; confirm: true }
  | { type: 'tag-create'; name: string; target: string; message?: string; push?: boolean }
  | { type: 'tag-delete'; name: string; confirm: true }
  | { type: 'tag-push'; name: string }
  | { type: 'worktree-add'; path: string; branch?: string; newBranch?: string; base?: string }
  | { type: 'worktree-remove'; id: string; confirm: true };

export type GitActionErrorCode =
  | 'invalid'
  | 'busy'
  | 'not_ff'
  | 'no_upstream'
  | 'no_branch'
  | 'conflict'
  | 'rejected'
  | 'auth'
  | 'dirty'
  | 'exists'
  | 'not_found'
  | 'timeout'
  | 'operation_in_progress'
  | 'nothing'
  | 'failed';

export interface GitActionResult {
  ok: boolean;
  /** 整理過的 git 輸出（去掉 ANSI、遮掉網址裡的帳密、只留最後 4 KB）；可能是空字串 */
  output: string;
  /** !ok 時一定有；ok 但什麼都沒做（例如沒有東西可以 stash）時是 'nothing' */
  code?: GitActionErrorCode;
  /** worktree-add：新的 worktree（可以用 `?local=<id>` 開啟） */
  repo?: LocalRepo;
}
