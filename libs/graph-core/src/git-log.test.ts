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
/** `git log -z --format=GIT_LOG_FORMAT` 的輸出：欄位與記錄一律以 NUL 分隔。 */
const rec = (n: number, parents: number[], date: string, msg: string, author = 'amy') =>
  [sha(n), parents.map(sha).join(' '), author, date, msg].join('\0') + '\0';

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

  it('marks remote-tracking branches with their remote (not the stripped remote-only default)', () => {
    const s = selectRefs(all, { currentBranch: 'feat/x' });
    expect(s.refs.map((r) => [r.name, r.remote])).toEqual([
      ['main', undefined],
      ['feat/x', undefined],
      ['origin/diverged', 'origin'],
      ['diverged', undefined],
      ['origin/only-remote', 'origin'],
    ]);
    const onlyRemote = parseForEachRef(`refs/remotes/origin/main\t${sha(1)}\t`);
    expect(selectRefs(onlyRemote, {}).refs[0]).toEqual({
      name: 'main',
      sha: sha(1),
      kind: 'branch',
      isDefault: true,
    });
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

  it('does not list the same branch twice when the default is given remote-qualified', () => {
    for (const spelled of ['origin/main', 'refs/remotes/origin/main']) {
      const s = selectRefs(all, { defaultBranch: spelled });
      const names = s.refs.map((r) => r.name);
      expect(new Set(names).size).toBe(names.length);
      expect(s.refs.filter((r) => r.isDefault).map((r) => r.name)).toEqual(['main']);
      expect(s.logRefs[0]).toBe('refs/heads/main');
    }
  });

  it('keeps names unique when the remote default and a local branch of the same name point at different commits', () => {
    const refs = parseForEachRef(
      [`refs/remotes/origin/main\t${sha(2)}\t`, `refs/heads/main\t${sha(1)}\t`].join('\n'),
    );
    const s = selectRefs(refs, { defaultBranch: 'origin/main' });
    const names = s.refs.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(s.refs.find((r) => r.isDefault)).toMatchObject({ name: 'origin/main', sha: sha(2) });
    expect(names).toContain('main');
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
    rec(3, [2, 9], '2026-01-03T10:00:00+08:00', "Merge branch 'x'") +
    rec(2, [1], '2026-01-02T10:00:00+08:00', 'feat: two', 'bob') +
    rec(9, [1], '2026-01-02T09:00:00+08:00', 'fix: side') +
    rec(1, [], '2026-01-01T10:00:00+08:00', 'chore: root');

  it('splits records and keeps parents order', () => {
    const commits = parseGitLog(log, (s) => `https://example.test/${s.slice(-2)}`);
    expect(commits.map((c) => c.sha)).toEqual([sha(3), sha(2), sha(9), sha(1)]);
    expect(commits[0]).toMatchObject({
      parents: [sha(2), sha(9)],
      message: "Merge branch 'x'",
      authorName: 'amy',
      url: 'https://example.test/03',
    });
    expect(commits[1]!.authorName).toBe('bob');
    expect(commits[3]!.parents).toEqual([]);
  });

  it('cannot be forged by control characters inside a commit subject', () => {
    const forged = `fix: pwn\x1e${sha(77)}\x1f${sha(1)}\x1fLinus Torvalds\x1f2026-01-01T00:00:00+00:00\x1fforged\x1e\n`;
    const commits = parseGitLog(
      rec(5, [1], '2026-01-05T00:00:00Z', forged) + rec(1, [], '2026-01-01T00:00:00Z', 'root'),
    );
    expect(commits.map((c) => c.sha)).toEqual([sha(5), sha(1)]);
    expect(commits[0]!.authorName).toBe('amy');
    expect(commits[0]!.message.startsWith('fix: pwn')).toBe(true);
  });

  it('tolerates leading newlines, garbage and truncated output', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('nonsense\0')).toEqual([]);
    expect(parseGitLog('\n' + rec(1, [], '2026-01-01T00:00:00Z', 'x'))).toHaveLength(1);
    // 前面有一段雜訊（例如 gpg 驗證輸出）時，會讀掉雜訊後重新同步
    const noisy = 'gpg: Signature made ...\0' + rec(1, [], '2026-01-01T00:00:00Z', 'x');
    expect(parseGitLog(noisy).map((c) => c.sha)).toEqual([sha(1)]);
    expect(parseGitLog(rec(1, [], '2026-01-01T00:00:00Z', 'x').slice(0, -10))).toEqual([]);
    expect(GIT_LOG_FORMAT).toBe('%H%x00%P%x00%an%x00%cI%x00%s');
  });

  it('never asks git for emails or message bodies', () => {
    expect(GIT_LOG_FORMAT).not.toMatch(/%a?e\b|%ae|%ce|%B|%b/);
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
    expect(data.repo.currentBranch).toBeUndefined();
  });

  it('carries the checked-out branch through to the layout (HEAD marker)', () => {
    const allRefs = parseForEachRef(
      [`refs/heads/main\t${sha(3)}\t`, `refs/heads/work\t${sha(2)}\t`].join('\n'),
    );
    const data = buildGitGraphData({
      logText: log,
      selected: selectRefs(allRefs, { currentBranch: 'work' }),
      allRefs,
      fallbackName: 'folder',
      currentBranch: 'work',
    });
    expect(data.repo.currentBranch).toBe('work');
    const layout = buildLayout(data);
    expect(layout.nodes.find((n) => n.isCurrent)!.sha).toBe(sha(2));
    expect(layout.branches.find((b) => b.isCurrent)!.name).toBe('work');
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
