import { describe, expect, it } from 'vitest';
import { appendCommits, missingParents } from './history.ts';
import { buildLayout } from './layout.ts';
import type { CommitInput, GraphData } from './types.ts';

const c = (sha: string, parents: string[], hour: number): CommitInput => ({
  sha,
  parents,
  message: `commit ${sha}`,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
});

const data = (commits: CommitInput[], extra: Partial<GraphData> = {}): GraphData => ({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits,
  refs: [{ name: 'main', sha: commits[0]?.sha ?? '', kind: 'branch', isDefault: true }],
  truncated: true,
  ...extra,
});

describe('missingParents', () => {
  it('lists parents outside the loaded range in commit order, de-duplicated', () => {
    // m3 ← m2（m1 沒載入）；f2 ← f1（f0 沒載入）；merge 的第二個 parent 也算
    const g = data([
      c('m4', ['m3', 'f2'], 9),
      c('m3', ['m2'], 8),
      c('f2', ['f1'], 7),
      c('m2', ['m1'], 6),
      c('f1', ['f0'], 5),
      c('x', ['m1'], 4),
    ]);
    expect(missingParents(g)).toEqual(['m1', 'f0']);
  });

  it('is empty when the history reaches its roots', () => {
    expect(missingParents(data([c('b', ['a'], 2), c('a', [], 1)]))).toEqual([]);
    expect(missingParents(data([]))).toEqual([]);
  });
});

describe('appendCommits', () => {
  it('appends older commits after the existing ones, skipping duplicates', () => {
    const g = data([c('c3', ['c2'], 3), c('c2', ['c1'], 2)]);
    const next = appendCommits(g, [c('c2', ['c1'], 2), c('c1', ['c0'], 1), c('c1', ['c0'], 1)]);
    expect(next.commits.map((x) => x.sha)).toEqual(['c3', 'c2', 'c1']);
    expect(next.truncated).toBe(true); // c0 還沒載入
    expect(missingParents(next)).toEqual(['c0']);
    // 原本的物件不被改動
    expect(g.commits).toHaveLength(2);

    const done = appendCommits(next, [c('c0', [], 0)]);
    expect(done.commits.map((x) => x.sha)).toEqual(['c3', 'c2', 'c1', 'c0']);
    expect(done.truncated).toBe(false);
    expect(missingParents(done)).toEqual([]);
    expect(done.repo).toBe(g.repo);
    expect(done.refs).toBe(g.refs);
  });

  it('returns the same object when nothing new arrived', () => {
    const g = data([c('c2', ['c1'], 2)]);
    expect(appendCommits(g, [])).toBe(g);
    expect(appendCommits(g, [c('c2', ['c1'], 2)])).toBe(g);
    // truncated 與實際不符時才更新它
    const wrong = data([c('a', [], 1)], { truncated: true });
    expect(appendCommits(wrong, []).truncated).toBe(false);
  });

  it('keeps the existing rows in place: the layout only grows at the bottom', () => {
    const first = data([c('m5', ['m4'], 50), c('m4', ['m3'], 40), c('m3', ['m2'], 30)], {
      refs: [
        { name: 'main', sha: 'm5', kind: 'branch', isDefault: true },
        { name: 'v0', sha: 'm1', kind: 'tag' },
      ],
    });
    const before = buildLayout(first);
    expect(before.nodes.map((n) => n.sha)).toEqual(['m5', 'm4', 'm3']);
    expect(before.truncated).toBe(true);

    const after = buildLayout(appendCommits(first, [c('m2', ['m1'], 20), c('m1', [], 10)]));
    expect(after.nodes.map((n) => n.sha)).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
    expect(after.truncated).toBe(false);
    // 指向原本沒載入的 commit 的 tag，載入之後出現
    expect(after.nodes[4]!.refs.map((r) => r.name)).toEqual(['v0']);
    expect(before.nodes.every((n) => n.refs.every((r) => r.name !== 'v0'))).toBe(true);
  });
});
