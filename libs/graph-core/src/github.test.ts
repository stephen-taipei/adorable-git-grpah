import { describe, expect, it } from 'vitest';
import { GitHubError, fetchGitHubGraph, resolveBranchHint } from './github.ts';

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
