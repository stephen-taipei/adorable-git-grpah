/** 與資料來源無關的 git 歷史輸入模型（GitHub API / 本機 git log 皆可轉成這個格式）。 */
export interface CommitInput {
  sha: string;
  /** 依序：第一個為 first-parent，其餘為 merge 進來的 parent。 */
  parents: string[];
  message: string;
  authorName: string;
  authorLogin?: string;
  avatarUrl?: string;
  /** ISO 8601 */
  date: string;
  url?: string;
}

export interface RefInput {
  name: string;
  sha: string;
  kind: 'branch' | 'tag';
  isDefault?: boolean;
}

export interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
  url?: string;
}

export interface GraphData {
  repo: RepoInfo;
  commits: CommitInput[];
  refs: RefInput[];
  /** 歷史是否被截斷（有 parent 不在 commits 內）。 */
  truncated?: boolean;
  /** 資料取得時間（ms epoch），給 cache 判斷用。 */
  fetchedAt?: number;
}

export type CommitKind = 'root' | 'merge' | 'feat' | 'fix' | 'revert' | 'docs' | 'chore' | 'normal';

export interface GraphNode {
  sha: string;
  shortSha: string;
  /** 由舊到新的欄位索引（0 = 最舊）。 */
  x: number;
  lane: number;
  /** lane 的垂直座標（grid unit，main lane = 0）。 */
  y: number;
  colorIndex: number;
  color: string;
  kind: CommitKind;
  subject: string;
  message: string;
  authorName: string;
  authorLogin?: string;
  avatarUrl?: string;
  date: string;
  url?: string;
  refs: RefInput[];
  parents: string[];
  /** 是否為 default branch 的最新 commit。 */
  isHead: boolean;
  /** 有 parent 落在已載入範圍之外（歷史被截斷）。 */
  hasHiddenParents: boolean;
}

export type EdgeKind = 'main' | 'fork' | 'merge';

export interface GraphEdge {
  /** older commit sha */
  from: string;
  /** newer commit sha */
  to: string;
  kind: EdgeKind;
  colorIndex: number;
  color: string;
  /** 由 parent 指向 child 的取樣折線（grid unit）。 */
  points: Array<[number, number]>;
}

export interface GraphBranch {
  name: string;
  sha: string;
  color: string;
  isDefault: boolean;
}

export interface GraphLayout {
  repo: RepoInfo;
  nodes: GraphNode[];
  edges: GraphEdge[];
  branches: GraphBranch[];
  /** 最大 x index */
  maxX: number;
  laneCount: number;
  minY: number;
  maxY: number;
  truncated: boolean;
}

export interface LayoutOptions {
  /** 超過時只保留最新的 N 筆。預設 400。 */
  maxCommits?: number;
}
