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
  /** remote-tracking branch 才有：remote 名稱（例如 `origin`；此時 `name` 為 `origin/feat/x`）。 */
  remote?: string;
}

export interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
  url?: string;
  /** 本機目前 checkout 的 branch（只有本機 git 來源知道；GitHub API 沒有這個概念）。 */
  currentBranch?: string;
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
  /** 由新到舊的列索引（0 = 最新，畫在最上面）。`layout.nodes[i].row === i`。 */
  row: number;
  /** 欄位（lane）索引：0 = default branch，往右依序展開。 */
  lane: number;
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
  /** 在已載入範圍內，以此 commit 為 parent 的 commit（新→舊）。 */
  children: string[];
  /** 是否為 default branch 的最新 commit。 */
  isHead: boolean;
  /** 是否為「目前 checkout 的 branch」的最新 commit（只有本機來源）。 */
  isCurrent: boolean;
  /** 有 parent 落在已載入範圍之外（歷史被截斷）。 */
  hasHiddenParents: boolean;
}

export type EdgeKind = 'main' | 'fork' | 'merge';

export interface GraphEdge {
  /** older commit sha（parent） */
  from: string;
  /** newer commit sha（child） */
  to: string;
  kind: EdgeKind;
  colorIndex: number;
  color: string;
  /** 由 child（上）指向 parent（下）的取樣折線，座標為 [lane, row]（皆為 grid unit，row 向下遞增）。 */
  points: Array<[number, number]>;
}

export interface GraphBranch {
  name: string;
  sha: string;
  color: string;
  isDefault: boolean;
  /** remote-tracking branch 的 remote 名稱。 */
  remote?: string;
  /** 是否為目前 checkout 的 branch。 */
  isCurrent: boolean;
}

export interface GraphLayout {
  repo: RepoInfo;
  /** 由新到舊（列順序）。 */
  nodes: GraphNode[];
  edges: GraphEdge[];
  branches: GraphBranch[];
  /** 使用到的欄位數（最大 lane + 1）。 */
  laneCount: number;
  truncated: boolean;
}

export interface LayoutOptions {
  /** 超過時只保留最新的 N 筆。預設 400。 */
  maxCommits?: number;
}
