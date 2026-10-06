import type { GraphData } from '@adorable/graph-core';

/** Vite plugin（node 端）與瀏覽器共用的協定。不可 import 任何 node 模組。 */
export interface GitSnapshot {
  graph: GraphData | null;
  /** graph 為 null 時的原因（例如不是 git repo）。 */
  error?: string;
  generatedAt: number;
}

export const HMR_EVENT = 'agg:git-snapshot';
export const SNAPSHOT_ENDPOINT = '/__agg/git-snapshot';
