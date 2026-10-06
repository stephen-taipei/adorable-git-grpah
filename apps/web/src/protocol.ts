import type { GraphData } from '@adorable/graph-core';

/** Vite plugin（node 端）與瀏覽器共用的協定。不可 import 任何 node 模組。 */
export interface GitSnapshot {
  graph: GraphData | null;
  /** graph 為 null 時的原因（例如不是 git repo）。 */
  error?: string;
  /** 暫時性的 git 錯誤（例如 gc / fetch 進行中）。已經有好的圖時，dev plugin 會保留舊圖；第一次讀取就失敗時才會帶著這個旗標送出。 */
  transient?: boolean;
  generatedAt: number;
}

export const HMR_EVENT = 'agg:git-snapshot';
export const SNAPSHOT_ENDPOINT = '/__agg/git-snapshot';

/** 比較用：忽略每次讀取都會變的時間戳，只看內容有沒有變。 */
export const snapshotKey = (s: GitSnapshot): string =>
  JSON.stringify({ ...s, generatedAt: 0, graph: s.graph && { ...s.graph, fetchedAt: 0 } });
