import { describe, expect, it } from 'vitest';
import {
  GitHubError,
  fetchGitHubCommitsFrom,
  fetchGitHubGraph,
  fetchMoreGitHubHistory,
  resolveBranchHint,
} from './github.ts';
import { missingParents } from './history.ts';
import type { GraphData } from './types.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const apiCommit = (n: number, parent?: number) => ({
  sha: sha(n),
  html_url: `https://github.com/o/r/commit/${sha(n)}`,
  parents: parent ? [{ sha: sha(parent) }] : [],
  commit: {
    message: `commit ${n}`,
    author: { name: 'A', date: '2026-01-01T00:00:00Z' },
    committer: { name: 'A', date: `2026-01-0${n}T00:00:00Z` },
  },
  author: { login: 'a', avatar_url: 'https://avatars.example/a' },
});

function fakeApi(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const hdr = (init?.headers ?? {}) as Record<string, string>;
    expect(hdr['Accept']).toContain('github');
    const key = url.pathname;
    if (overrides[key]) return overrides[key]!();
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (key === '/repos/o/r') {
      return json({
        name: 'r',
        default_branch: 'main',
        html_url: 'https://github.com/o/r',
        owner: { login: 'o' },
      });
    }
    if (key === '/repos/o/r/branches') {
      return json([
        { name: 'main', commit: { sha: sha(4) } },
        { name: 'a-old', commit: { sha: sha(1) } },
        { name: 'feat/x', commit: { sha: sha(3) } },
      ]);
    }
    if (key === '/repos/o/r/pulls') return json([]);
    if (key === '/repos/o/r/tags') return json([{ name: 'v1', commit: { sha: sha(2) } }]);
    if (key === '/repos/o/r/commits') {
      const branch = url.searchParams.get('sha');
      if (branch === 'main')
        return json([apiCommit(4, 3), apiCommit(3, 2), apiCommit(2, 1), apiCommit(1)]);
      if (branch === 'feat/x') return json([apiCommit(3, 2), apiCommit(2, 1), apiCommit(1)]);
      return json([apiCommit(1)]);
    }
    return new Response('{}', { status: 404 });
  };
  return { impl, calls };
}

describe('resolveBranchHint', () => {
  it('prefers the longest existing prefix (branch names may contain slashes)', () => {
    const names = ['main', 'feat', 'feat/x'];
    expect(resolveBranchHint('feat/x/src/index.ts', names)).toBe('feat/x');
    expect(resolveBranchHint('feat/y/readme.md', names)).toBe('feat');
    expect(resolveBranchHint('nope', names)).toBeUndefined();
    expect(resolveBranchHint(undefined, names)).toBeUndefined();
  });
});

describe('fetchGitHubGraph', () => {
  it('builds GraphData from the REST API, de-duplicating shared history', async () => {
    const { impl, calls } = fakeApi();
    const g = await fetchGitHubGraph('o', 'r', {
      fetchImpl: impl,
      maxBranches: 2,
      branchHint: 'feat/x/README.md',
    });
    expect(g.repo).toMatchObject({ owner: 'o', name: 'r', defaultBranch: 'main' });
    expect(g.commits.map((c) => c.sha).sort()).toEqual([1, 2, 3, 4].map(sha));
    expect(g.refs.filter((r) => r.kind === 'branch').map((r) => r.name)).toEqual([
      'main',
      'feat/x',
    ]);
    expect(g.refs.find((r) => r.name === 'v1')).toMatchObject({ kind: 'tag', sha: sha(2) });
    expect(g.truncated).toBe(false);
    // repo + branches + pulls + tags + 2 × commits
    expect(calls).toHaveLength(6);
    expect(g.commits[0]).toMatchObject({ authorLogin: 'a', message: 'commit 4' });
  });

  it('rejects malformed repo names before touching the network', async () => {
    const { impl, calls } = fakeApi();
    await expect(fetchGitHubGraph('o', '../etc', { fetchImpl: impl })).rejects.toMatchObject({
      code: 'invalid_repo',
    });
    await expect(fetchGitHubGraph('o/x', 'r', { fetchImpl: impl })).rejects.toMatchObject({
      code: 'invalid_repo',
    });
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP failures to typed errors', async () => {
    const limited = () =>
      new Response('{}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
      });
    const err = await fetchGitHubGraph('o', 'r', {
      fetchImpl: fakeApi({ '/repos/o/r': limited }).impl,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ code: 'rate_limited', resetAt: 1_800_000_000_000 });

    const nf = await fetchGitHubGraph('o', 'r', {
      fetchImpl: fakeApi({ '/repos/o/r': () => new Response('{}', { status: 404 }) }).impl,
    }).catch((e) => e);
    expect(nf).toMatchObject({ code: 'not_found' });

    const net = await fetchGitHubGraph('o', 'r', {
      fetchImpl: async () => {
        throw new TypeError('boom');
      },
    }).catch((e) => e);
    expect(net).toMatchObject({ code: 'network' });
  });

  it('maps a timeout to a network error but lets a deliberate abort through', async () => {
    const timeout = await fetchGitHubGraph('o', 'r', {
      fetchImpl: async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    }).catch((e) => e);
    expect(timeout).toMatchObject({ code: 'network' });

    const aborted = await fetchGitHubGraph('o', 'r', {
      fetchImpl: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    }).catch((e) => e);
    expect(aborted).not.toBeInstanceOf(GitHubError);
    expect(aborted.name).toBe('AbortError');
  });

  it('also classifies a timeout that fires while the response body is being read', async () => {
    const body = () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        },
      }) as unknown as Response;
    const err = await fetchGitHubGraph('o', 'r', { fetchImpl: async () => body() }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).toMatchObject({ code: 'network' });

    const aborted = await fetchGitHubGraph('o', 'r', {
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => {
            throw new DOMException('aborted', 'AbortError');
          },
        }) as unknown as Response,
    }).catch((e) => e);
    expect(aborted).not.toBeInstanceOf(GitHubError);
    expect(aborted.name).toBe('AbortError');
  });

  it('sends the token only as a Bearer header', async () => {
    let auth: string | undefined;
    const { impl } = fakeApi();
    const spy: typeof fetch = async (input, init) => {
      auth = (init?.headers as Record<string, string>)['Authorization'];
      expect(String(input)).not.toContain('secret');
      return impl(input, init);
    };
    await fetchGitHubGraph('o', 'r', { fetchImpl: spy, token: 'secret', maxBranches: 1 });
    expect(auth).toBe('Bearer secret');
  });
});

describe('fetchGitHubGraph tags', () => {
  it('keeps tags whose commit is not loaded yet (they appear once older history is appended)', async () => {
    const { impl } = fakeApi({
      '/repos/o/r/tags': () =>
        new Response(
          JSON.stringify([
            { name: 'v1', commit: { sha: sha(2) } },
            { name: 'v0-old', commit: { sha: sha(99) } },
          ]),
          { status: 200 },
        ),
    });
    const g = await fetchGitHubGraph('o', 'r', { fetchImpl: impl, maxBranches: 1 });
    expect(g.refs.filter((r) => r.kind === 'tag').map((r) => r.name)).toEqual(['v1', 'v0-old']);
    expect(g.commits.some((c) => c.sha === sha(99))).toBe(false);
  });
});

/** 一條直線的歷史 1 ← 2 ← … ← 30（30 最新），外加從 10 分出去的 b1 ← b2（日期介於 10 與 11 之間）。 */
function historyApi(opts: { status?: (sha: string) => number | undefined } = {}) {
  const calls: string[] = [];
  const auth: Array<string | undefined> = [];
  const commitAt = (n: number) => apiCommit(n, n > 1 ? n - 1 : undefined);
  const branchCommit = (k: number) => ({
    ...apiCommit(100 + k, k === 1 ? 10 : 100 + k - 1),
    commit: {
      message: `branch ${k}`,
      author: { name: 'B', date: '2026-01-01T00:00:00Z' },
      committer: { name: 'B', date: new Date(Date.UTC(2026, 0, 10, k)).toISOString() },
    },
  });
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    auth.push((init?.headers as Record<string, string>)['Authorization']);
    if (url.pathname !== '/repos/o/r/commits') return new Response('{}', { status: 404 });
    const start = url.searchParams.get('sha') ?? '';
    const forced = opts.status?.(start);
    if (forced) return new Response('{"message":"x"}', { status: forced });
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const n = parseInt(start, 16);
    let list: unknown[];
    if (n >= 101 && n <= 102) {
      list = [];
      for (let k = n - 100; k >= 1; k--) list.push(branchCommit(k));
      for (let i = 10; i >= 1; i--) list.push(commitAt(i));
    } else if (n >= 1 && n <= 30) {
      list = [];
      for (let i = n; i >= 1; i--) list.push(commitAt(i));
    } else {
      return new Response('{"message":"No commit found"}', { status: 404 });
    }
    return new Response(JSON.stringify(list.slice(0, per)), { status: 200 });
  };
  return { impl, calls, auth };
}

describe('fetchGitHubCommitsFrom', () => {
  it('fetches one page back from each start (per_page honoured), de-duplicated in start order', async () => {
    const { impl, calls } = historyApi();
    const out = await fetchGitHubCommitsFrom('o', 'r', [sha(20), sha(102)], {
      fetchImpl: impl,
      perPage: 5,
    });
    expect(calls.sort()).toEqual(
      [
        `/repos/o/r/commits?sha=${sha(20)}&per_page=5`,
        `/repos/o/r/commits?sha=${sha(102)}&per_page=5`,
      ].sort(),
    );
    expect(out.map((c) => parseInt(c.sha, 16))).toEqual([20, 19, 18, 17, 16, 102, 101, 10, 9, 8]);
    expect(out[0]).toMatchObject({ message: 'commit 20', parents: [sha(19)], authorLogin: 'a' });
  });

  it('defaults to 60 per page, clamps per_page to 1–100 and limits the number of starts', async () => {
    const { impl, calls } = historyApi();
    await fetchGitHubCommitsFrom('o', 'r', [sha(3)], { fetchImpl: impl });
    expect(calls.at(-1)).toContain('per_page=60');
    await fetchGitHubCommitsFrom('o', 'r', [sha(3)], { fetchImpl: impl, perPage: 1000 });
    expect(calls.at(-1)).toContain('per_page=100');
    await fetchGitHubCommitsFrom('o', 'r', [sha(3)], { fetchImpl: impl, perPage: 0 });
    expect(calls.at(-1)).toContain('per_page=1');

    calls.length = 0;
    const starts = [1, 2, 3, 4, 5, 6, 7].map(sha);
    await fetchGitHubCommitsFrom('o', 'r', [...starts, sha(1)], { fetchImpl: impl });
    expect(calls).toHaveLength(5); // 預設最多 5 個起點
    calls.length = 0;
    await fetchGitHubCommitsFrom('o', 'r', starts, { fetchImpl: impl, maxStarts: 2 });
    expect(calls.map((p) => new URL(p, 'http://x').searchParams.get('sha'))).toEqual([
      sha(1),
      sha(2),
    ]);
    calls.length = 0;
    // 重複的起點只抓一次（大小寫不同也算同一個）
    await fetchGitHubCommitsFrom('o', 'r', [sha(3), sha(3).toUpperCase()], { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(await fetchGitHubCommitsFrom('o', 'r', [], { fetchImpl: impl })).toEqual([]);
  });

  it('validates the repo and every sha before touching the network', async () => {
    const { impl, calls } = historyApi();
    for (const bad of [
      'main',
      'HEAD',
      `${sha(1)}&per_page=100`,
      `../${sha(1)}`,
      sha(1).slice(1),
      '',
    ]) {
      await expect(
        fetchGitHubCommitsFrom('o', 'r', [sha(2), bad], { fetchImpl: impl }),
      ).rejects.toBeInstanceOf(GitHubError);
    }
    await expect(
      fetchGitHubCommitsFrom('o', '../x', [sha(2)], { fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'invalid_repo' });
    expect(calls).toHaveLength(0);
  });

  it('treats a start GitHub no longer knows (404 / 422) as empty, but other errors fail the batch', async () => {
    const gone = historyApi({ status: (s) => (s === sha(5) ? 422 : undefined) });
    const out = await fetchGitHubCommitsFrom('o', 'r', [sha(5), sha(25), sha(77)], {
      fetchImpl: gone.impl,
      perPage: 2,
    });
    expect(out.map((c) => parseInt(c.sha, 16))).toEqual([25, 24]);

    const limited = historyApi({ status: (s) => (s === sha(25) ? 429 : undefined) });
    await expect(
      fetchGitHubCommitsFrom('o', 'r', [sha(5), sha(25)], { fetchImpl: limited.impl }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    const net = await fetchGitHubCommitsFrom('o', 'r', [sha(5)], {
      fetchImpl: async () => {
        throw new TypeError('boom');
      },
    }).catch((e) => e);
    expect(net).toMatchObject({ code: 'network' });
  });

  it('sends the token only as a Bearer header', async () => {
    const { impl, calls, auth } = historyApi();
    await fetchGitHubCommitsFrom('o', 'r', [sha(4)], { fetchImpl: impl, token: 'secret' });
    expect(auth).toEqual(['Bearer secret']);
    expect(calls.every((p) => !p.includes('secret'))).toBe(true);
  });
});

describe('fetchMoreGitHubHistory', () => {
  const page = async (start: number, per: number, impl: typeof fetch) =>
    fetchGitHubCommitsFrom('o', 'r', [sha(start)], { fetchImpl: impl, perPage: per });

  it('pages back from the missing parents until the root, keeping the existing order', async () => {
    const { impl, calls } = historyApi();
    let data: GraphData = {
      repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
      commits: await page(30, 10, impl),
      refs: [],
      truncated: true,
    };
    const first = data.commits.map((c) => c.sha);
    calls.length = 0;
    data = await fetchMoreGitHubHistory('o', 'r', data, { fetchImpl: impl, perPage: 10 });
    expect(calls).toEqual([`/repos/o/r/commits?sha=${sha(20)}&per_page=10`]);
    expect(data.commits.slice(0, 10).map((c) => c.sha)).toEqual(first);
    expect(data.commits).toHaveLength(20);
    expect(data.truncated).toBe(true);
    expect(missingParents(data)).toEqual([sha(10)]);

    data = await fetchMoreGitHubHistory('o', 'r', data, { fetchImpl: impl, perPage: 10 });
    expect(data.commits.map((c) => parseInt(c.sha, 16))).toEqual(
      Array.from({ length: 30 }, (_, i) => 30 - i),
    );
    expect(data.truncated).toBe(false);

    calls.length = 0;
    const same = await fetchMoreGitHubHistory('o', 'r', data, { fetchImpl: impl });
    expect(same).toBe(data);
    expect(calls).toHaveLength(0);
  });
});
