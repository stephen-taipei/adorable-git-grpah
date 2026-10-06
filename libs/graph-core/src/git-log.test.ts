import { describe, expect, it } from 'vitest';
import {
  GIT_LOG_FORMAT,
  buildGitGraphData,
  parseForEachRef,
  parseGitHubRemote,
  parseGitLog,
  selectRefs,
} from './git-log.ts';
import { buildLayout } from './layout.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const rec = (n: number, parents: number[], date: string, msg: string, author = 'amy') =>
  [sha(n), parents.map(sha).join(' '), author, date, msg].join('\x1f') + '\x1e\n';

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r', { owner: 'o', repo: 'r' }],
    ['git@github.com:o/r.git', { owner: 'o', repo: 'r' }],
    ['ssh://git@github.com/o/r', { owner: 'o', repo: 'r' }],
    ['https://x-access-token:SECRET@github.com/o/r.git', { owner: 'o', repo: 'r' }],
    ['https://github.com/o/r/', { owner: 'o', repo: 'r' }],
  ])('%s', (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected);
  });

  it('rejects other hosts, lookalikes and garbage', () => {
    for (const u of [
      'https://gitlab.com/o/r.git',
      'https://github.com.evil.example/o/r',
      'https://evil.example/github.com/o/r',
      'http://127.0.0.1:1234/git/o/r',
      '',
      undefined,
      '../relative/path',
    ]) {
      expect(parseGitHubRemote(u)).toBeNull();
    }
  });
});

describe('parseForEachRef', () => {
  const text = [
    `refs/heads/main\t${sha(9)}\t`,
    `refs/heads/feat/x\t${sha(7)}\t`,
    `refs/remotes/origin/main\t${sha(9)}\t`,
    `refs/remotes/origin/HEAD\t${sha(9)}\t`,
    `refs/remotes/origin/only-remote\t${sha(5)}\t`,
    `refs/tags/v1\t${sha(100)}\t${sha(3)}`,
    `refs/tags/light\t${sha(4)}\t`,
    `refs/stash\t${sha(1)}\t`,
    '',
  ].join('\n');

  it('parses branches, remote branches and (peeled) tags; ignores origin/HEAD and stash', () => {
    const refs = parseForEachRef(text);
    expect(refs.map((r) => [r.kind, r.name, r.sha])).toEqual([
      ['branch', 'main', sha(9)],
      ['branch', 'feat/x', sha(7)],
      ['branch', 'origin/main', sha(9)],
      ['branch', 'origin/only-remote', sha(5)],
      ['tag', 'v1', sha(3)],
      ['tag', 'light', sha(4)],
    ]);
  });
});

describe('selectRefs', () => {
  const all = parseForEachRef(
    [
      `refs/heads/feat/x\t${sha(7)}\t`,
      `refs/heads/main\t${sha(9)}\t`,
      `refs/remotes/origin/main\t${sha(9)}\t`,
      `refs/remotes/origin/diverged\t${sha(6)}\t`,
      `refs/heads/diverged\t${sha(5)}\t`,
      `refs/remotes/origin/only-remote\t${sha(4)}\t`,
    ].join('\n'),
  );

  it('puts default first, then the current branch, and drops remote twins', () => {
    const s = selectRefs(all, { currentBranch: 'feat/x' });
    expect(s.defaultBranch).toBe('main');
    expect(s.refs.map((r) => r.name)).toEqual([
      'main',
      'feat/x',
      'origin/diverged', // 本機與 remote 指向不同 commit → 兩個都保留，順序沿用輸入（committerdate）
      'diverged',
      'origin/only-remote',
    ]);
    expect(s.refs[0]).toMatchObject({ isDefault: true });
    expect(s.logRefs[0]).toBe('refs/heads/main');
  });

  it('uses a remote-only default branch under its bare name', () => {
    const onlyRemote = parseForEachRef(
      [`refs/heads/work\t${sha(2)}\t`, `refs/remotes/origin/main\t${sha(1)}\t`].join('\n'),
    );
    const s = selectRefs(onlyRemote, { originHead: 'origin/main', currentBranch: 'work' });
    expect(s.defaultBranch).toBe('main');
    expect(s.refs.map((r) => [r.name, r.isDefault])).toEqual([
      ['main', true],
      ['work', false],
    ]);
    expect(s.logRefs).toEqual(['refs/remotes/origin/main', 'refs/heads/work']);
  });

  it('honours an explicit default and the branch cap', () => {
    const s = selectRefs(all, { defaultBranch: 'diverged', maxBranches: 2 });
    expect(s.refs.map((r) => r.name)).toEqual(['diverged', 'feat/x']);
    expect(s.defaultBranch).toBe('diverged');
  });

  it('falls back to the current branch, then the first branch', () => {
    const refs = parseForEachRef(
      [`refs/heads/dev\t${sha(1)}\t`, `refs/heads/zzz\t${sha(2)}\t`].join('\n'),
    );
    expect(selectRefs(refs, { currentBranch: 'zzz' }).defaultBranch).toBe('zzz');
    expect(selectRefs(refs).defaultBranch).toBe('dev');
    expect(selectRefs([]).refs).toEqual([]);
  });
});

describe('parseGitLog / buildGitGraphData', () => {
  const log =
    rec(3, [2, 9], '2026-01-03T10:00:00+08:00', "Merge branch 'x'\n\nbody line") +
    rec(2, [1], '2026-01-02T10:00:00+08:00', 'feat: two', 'bob') +
    rec(9, [1], '2026-01-02T09:00:00+08:00', 'fix: side') +
    rec(1, [], '2026-01-01T10:00:00+08:00', 'chore: root');

  it('splits records, keeps multi-line messages and parents order', () => {
    const commits = parseGitLog(log, (s) => `https://example.test/${s.slice(-2)}`);
    expect(commits.map((c) => c.sha)).toEqual([sha(3), sha(2), sha(9), sha(1)]);
    expect(commits[0]).toMatchObject({
      parents: [sha(2), sha(9)],
      message: "Merge branch 'x'\n\nbody line",
      authorName: 'amy',
      url: 'https://example.test/03',
    });
    expect(commits[1]!.authorName).toBe('bob');
    expect(commits[3]!.parents).toEqual([]);
  });

  it('ignores garbage records and is robust to the exported format string', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('nonsense\x1e')).toEqual([]);
    expect(GIT_LOG_FORMAT).toContain('%x1e');
  });

  it('produces GraphData that lays out correctly; tags only when their commit is loaded', () => {
    const allRefs = parseForEachRef(
      [
        `refs/heads/main\t${sha(3)}\t`,
        `refs/tags/v1\t${sha(1)}\t`,
        `refs/tags/gone\t${sha(77)}\t`,
      ].join('\n'),
    );
    const selected = selectRefs(allRefs, {});
    const data = buildGitGraphData({
      logText: log,
      selected,
      allRefs,
      remoteUrl: 'https://token@github.com/octo/cat.git',
      fallbackName: 'folder',
    });
    expect(data.repo).toMatchObject({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    expect(data.repo.url).toBe('https://github.com/octo/cat');
    expect(JSON.stringify(data)).not.toContain('token');
    expect(data.commits[0]!.url).toBe(`https://github.com/octo/cat/commit/${sha(3)}`);
    expect(data.refs.map((r) => `${r.kind}:${r.name}`)).toEqual(['branch:main', 'tag:v1']);
    expect(data.truncated).toBe(false);

    const layout = buildLayout(data);
    expect(layout.nodes).toHaveLength(4);
    expect(layout.nodes.find((n) => n.isHead)!.sha).toBe(sha(3));
  });

  it('falls back to the folder name and flags truncated history without a GitHub remote', () => {
    const data = buildGitGraphData({
      logText: rec(2, [1], '2026-01-02T00:00:00Z', 'x'),
      selected: { logRefs: [], refs: [], defaultBranch: undefined },
      allRefs: [],
      fallbackName: 'my-folder',
    });
    expect(data.repo).toMatchObject({ owner: 'local', name: 'my-folder', defaultBranch: 'main' });
    expect(data.repo.url).toBeUndefined();
    expect(data.commits[0]!.url).toBeUndefined();
    expect(data.truncated).toBe(true);
  });
});
