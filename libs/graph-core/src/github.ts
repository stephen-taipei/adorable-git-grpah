import { appendCommits, missingParents } from './history.ts';
import type { CommitInput, GraphData, RefInput } from './types.ts';

export type GitHubErrorCode =
  | 'invalid_repo'
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'empty_repo'
  | 'network'
  | 'unknown';

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  /** rate limit 重置時間（ms epoch） */
  readonly resetAt?: number;
  /** GitHub 回應的 HTTP 狀態碼（網路錯誤、輸入驗證失敗時沒有） */
  readonly status?: number;

  constructor(code: GitHubErrorCode, message: string, resetAt?: number, status?: number) {
    super(message);
    this.name = 'GitHubError';
    this.code = code;
    this.resetAt = resetAt;
    this.status = status;
  }
}

export interface GitHubGraphOptions {
  token?: string;
  /** 預設 https://api.github.com */
  apiBase?: string;
  /** 每條 branch 最多抓幾筆 commit。預設 60（上限 100）。 */
  maxCommitsPerBranch?: number;
  /** 最多追蹤幾條 branch（含 default）。預設 5。 */
  maxBranches?: number;
  /** 使用者正在瀏覽的 branch（或 `/tree/` 之後的路徑），優先納入。 */
  branchHint?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function isValidRepoSegment(s: string): boolean {
  return NAME_RE.test(s) && s !== '.' && s !== '..';
}

/** `/tree/<a>/<b>/file` 中 branch 名可能含 `/`：取最長且存在於 branch 清單的前綴。 */
export function resolveBranchHint(
  hintPath: string | undefined,
  branchNames: readonly string[],
): string | undefined {
  if (!hintPath) return undefined;
  const parts = hintPath.split('/').filter(Boolean);
  const names = new Set(branchNames);
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('/');
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

interface ApiCommit {
  sha: string;
  html_url?: string;
  parents?: Array<{ sha: string }>;
  commit: {
    message?: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
  author?: { login?: string; avatar_url?: string } | null;
}

interface ApiBranch {
  name: string;
  commit: { sha: string };
}

interface ApiPull {
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
}

interface ApiTag {
  name: string;
  commit: { sha: string };
}

interface ApiRepo {
  name: string;
  default_branch: string;
  html_url?: string;
  owner?: { login?: string };
}

export function mapApiCommit(c: ApiCommit): CommitInput {
  return {
    sha: c.sha,
    parents: (c.parents ?? []).map((p) => p.sha),
    message: c.commit.message ?? '',
    authorName: c.commit.author?.name ?? c.author?.login ?? 'unknown',
    authorLogin: c.author?.login,
    avatarUrl: c.author?.avatar_url,
    date: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
    url: c.html_url,
  };
}

/** 呼叫 GitHub REST API 的共用設定（fetchGitHubGraph / fetchGitHubCommitsFrom 共用）。 */
interface RequestOptions {
  token?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** `/repos/<owner>/<repo>`；名稱不合法時在碰網路之前就丟 invalid_repo。 */
function repoPathOf(owner: string, repo: string): string {
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    throw new GitHubError('invalid_repo', `Invalid repository: ${owner}/${repo}`);
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** 每頁筆數：預設 60，限制在 1–100（GitHub 的 per_page 上限）。 */
function clampPerPage(n: number | undefined): number {
  const v = Math.floor(n ?? 60);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), 100) : 60;
}

/** GET 一個 API 路徑並解析 JSON；HTTP / 網路失敗一律轉成 GitHubError（呼叫端主動 abort 除外）。 */
function githubGetter(opts: RequestOptions) {
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return async function get<T>(
    path: string,
    query: Record<string, string | number> = {},
  ): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    // 逾時（TimeoutError）/ 連線中斷 → network；呼叫端主動 abort（AbortError）原樣往外丟。fetch 與讀 body 兩段都可能發生
    const asNetworkError = (err: unknown): unknown =>
      (err as { name?: string }).name === 'AbortError'
        ? err
        : new GitHubError('network', `Network error: ${(err as Error).message}`);

    let res: Response;
    try {
      res = await doFetch(url.toString(), { headers, signal: opts.signal });
    } catch (err) {
      throw asNetworkError(err);
    }
    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw asNetworkError(err);
      }
    }

    const status = res.status;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || undefined;
    if (status === 429 || (status === 403 && remaining === '0')) {
      throw new GitHubError('rate_limited', 'GitHub API rate limit exceeded', reset, status);
    }
    if (status === 401) throw new GitHubError('unauthorized', 'Bad credentials', undefined, status);
    if (status === 404) {
      throw new GitHubError('not_found', 'Repository not found', undefined, status);
    }
    if (status === 403) throw new GitHubError('unauthorized', 'Forbidden', undefined, status);
    if (status === 409) {
      throw new GitHubError('empty_repo', 'Repository is empty', undefined, status);
    }
    throw new GitHubError('unknown', `GitHub API error ${status}`, undefined, status);
  };
}

export async function fetchGitHubGraph(
  owner: string,
  repo: string,
  opts: GitHubGraphOptions = {},
): Promise<GraphData> {
  const repoPath = repoPathOf(owner, repo);
  const get = githubGetter(opts);
  const perBranch = clampPerPage(opts.maxCommitsPerBranch);
  const maxBranches = Math.max(opts.maxBranches ?? 5, 1);

  const repoInfo = await get<ApiRepo>(repoPath);
  const defaultBranch = repoInfo.default_branch;

  // tags 失敗不致命
  const [branches, pulls, tags] = await Promise.all([
    get<ApiBranch[]>(`${repoPath}/branches`, { per_page: 100 }),
    get<ApiPull[]>(`${repoPath}/pulls`, {
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    }).catch(() => [] as ApiPull[]),
    get<ApiTag[]>(`${repoPath}/tags`, { per_page: 30 }).catch(() => [] as ApiTag[]),
  ]);

  const headBySha = new Map(branches.map((b) => [b.name, b.commit.sha]));
  const hint = resolveBranchHint(opts.branchHint, [...headBySha.keys()]);
  const fullName = `${owner}/${repo}`.toLowerCase();
  const prBranches = pulls
    .filter((p) => p.head.repo?.full_name?.toLowerCase() === fullName)
    .map((p) => p.head.ref);

  const picked: string[] = [];
  for (const name of [defaultBranch, hint, ...prBranches, ...headBySha.keys()]) {
    if (name && headBySha.has(name) && !picked.includes(name)) picked.push(name);
    if (picked.length >= maxBranches) break;
  }

  const results = await Promise.all(
    picked.map((name) =>
      get<ApiCommit[]>(`${repoPath}/commits`, { sha: name, per_page: perBranch }),
    ),
  );

  const commits = new Map<string, CommitInput>();
  for (const list of results) {
    for (const c of list) if (!commits.has(c.sha)) commits.set(c.sha, mapApiCommit(c));
  }

  const refs: RefInput[] = picked.map((name) => ({
    name,
    sha: headBySha.get(name)!,
    kind: 'branch',
    isDefault: name === defaultBranch,
  }));
  // tag 全部留著：指向還沒載入的 commit 的 tag，等 infinite scroll 把那段歷史載入之後就會出現（layout 只畫載入範圍內的 ref）
  for (const t of tags) refs.push({ name: t.name, sha: t.commit.sha, kind: 'tag' });

  const truncated = [...commits.values()].some((c) => c.parents.some((p) => !commits.has(p)));

  return {
    repo: {
      owner: repoInfo.owner?.login ?? owner,
      name: repoInfo.name ?? repo,
      defaultBranch,
      url: repoInfo.html_url ?? `https://github.com/${owner}/${repo}`,
    },
    commits: [...commits.values()],
    refs,
    truncated,
    fetchedAt: Date.now(),
  };
}

export interface GitHubMoreOptions {
  token?: string;
  /** 預設 https://api.github.com */
  apiBase?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** 每個起點抓幾筆（一頁）。預設 60（上限 100）。 */
  perPage?: number;
  /** 最多從幾個起點往回抓（每個起點一個請求）。預設 5。 */
  maxStarts?: number;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * 從每個 missing parent 往回抓一頁（最多 maxStarts 個起點，平行請求）：`GET /commits?sha=<sha>&per_page=<n>`。
 * 回傳各頁 commit 的聯集（sha 去重，依起點順序）。sha 必須是 40 位 hex，否則在碰網路之前就丟錯。
 * GitHub 已經不認得的起點（404 / 422，例如 force push 之後被回收的 commit）視為「這個起點沒有更早的」，不讓整批失敗；
 * 其他錯誤（rate limit、網路、token…）照常丟出 GitHubError。
 */
export async function fetchGitHubCommitsFrom(
  owner: string,
  repo: string,
  shas: readonly string[],
  opts: GitHubMoreOptions = {},
): Promise<CommitInput[]> {
  const repoPath = repoPathOf(owner, repo);
  const bad = shas.find((s) => typeof s !== 'string' || !SHA_RE.test(s));
  if (bad !== undefined) throw new GitHubError('unknown', `Invalid commit SHA: ${String(bad)}`);
  const perPage = clampPerPage(opts.perPage);
  const maxStarts = Math.max(1, Math.floor(opts.maxStarts ?? 5) || 1);
  const starts = [...new Set(shas.map((s) => s.toLowerCase()))].slice(0, maxStarts);
  if (starts.length === 0) return [];

  const get = githubGetter(opts);
  const pages = await Promise.all(
    starts.map((sha) =>
      get<ApiCommit[]>(`${repoPath}/commits`, { sha, per_page: perPage }).catch((err: unknown) => {
        if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return [];
        throw err;
      }),
    ),
  );

  const out = new Map<string, CommitInput>();
  for (const page of pages) {
    for (const c of page) if (!out.has(c.sha)) out.set(c.sha, mapApiCommit(c));
  }
  return [...out.values()];
}

/** missingParents → fetchGitHubCommitsFrom → appendCommits。沒有缺的 parent 就原樣回傳。 */
export async function fetchMoreGitHubHistory(
  owner: string,
  repo: string,
  data: GraphData,
  opts: GitHubMoreOptions = {},
): Promise<GraphData> {
  const missing = missingParents(data);
  if (missing.length === 0) return data;
  const older = await fetchGitHubCommitsFrom(owner, repo, missing, opts);
  return appendCommits(data, older);
}
