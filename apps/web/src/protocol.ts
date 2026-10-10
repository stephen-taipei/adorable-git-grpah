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
