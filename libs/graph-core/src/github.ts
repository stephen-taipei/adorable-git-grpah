import type { CommitInput, GraphData, RefInput } from './types';

export type GitHubErrorCode =
  | 'invalid_repo'
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'empty_repo'
  | 'network'
  | 'unknown';

export class GitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    /** rate limit 重置時間（ms epoch） */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
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

export async function fetchGitHubGraph(
  owner: string,
  repo: string,
  opts: GitHubGraphOptions = {},
): Promise<GraphData> {
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    throw new GitHubError('invalid_repo', `Invalid repository: ${owner}/${repo}`);
  }
  const base = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const perBranch = Math.min(Math.max(opts.maxCommitsPerBranch ?? 60, 1), 100);
  const maxBranches = Math.max(opts.maxBranches ?? 5, 1);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

    let res: Response;
    try {
      res = await doFetch(url.toString(), { headers, signal: opts.signal });
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw err;
      throw new GitHubError('network', `Network error: ${(err as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;

    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 || undefined;
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      throw new GitHubError('rate_limited', 'GitHub API rate limit exceeded', reset);
    }
    if (res.status === 401) throw new GitHubError('unauthorized', 'Bad credentials');
    if (res.status === 404) throw new GitHubError('not_found', 'Repository not found');
    if (res.status === 403) throw new GitHubError('unauthorized', 'Forbidden');
    if (res.status === 409) throw new GitHubError('empty_repo', 'Repository is empty');
    throw new GitHubError('unknown', `GitHub API error ${res.status}`);
  }

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
  for (const t of tags) {
    if (commits.has(t.commit.sha)) refs.push({ name: t.name, sha: t.commit.sha, kind: 'tag' });
  }

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
