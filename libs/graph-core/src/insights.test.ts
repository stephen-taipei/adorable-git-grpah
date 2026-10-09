import { describe, expect, it } from 'vitest';
import { buildLayout } from './layout.ts';
import {
  aheadCount,
  branchesContaining,
  buildReachability,
  computeStats,
  matchesQuery,
  reachableFrom,
} from './insights.ts';
import { createDemoData } from './demo.ts';
import type { CommitInput, GraphData } from './types.ts';

const commit = (
  sha: string,
  parents: string[],
  hour: number,
  message = sha,
  author = 'amy',
): CommitInput => ({
  sha,
  parents,
  message,
  authorName: author,
  authorLogin: author,
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});

describe('insights', () => {
  const demo = buildLayout(createDemoData());

  it('summarises commits, merges, branches, tags, authors and the time span', () => {
    const s = computeStats(demo);
    expect(s.commits).toBe(createDemoData().commits.length);
    expect(s.merges).toBe(2);
    expect(s.branches).toBe(3);
    expect(s.tags).toBe(2);
    expect(s.authors.map((a) => [a.name, a.commits]).slice(0, 1)).toEqual([['amy', 13]]);
    expect(s.authors.reduce((n, a) => n + a.commits, 0)).toBe(s.commits);
    expect(Date.parse(s.lastDate!)).toBeGreaterThan(Date.parse(s.firstDate!));
  });

  it('computes what each branch can reach and which branches contain a commit', () => {
    const reach = buildReachability(demo);
    const tip = (name: string) => demo.branches.find((b) => b.name === name)!.sha;
    // main の tip から届くのは、main に merge 済みの commit だけ
    const main = reach.get('main')!;
    expect(main.has(tip('main'))).toBe(true);
    expect(main.has(tip('feat/dark-mode'))).toBe(false); // まだ merge されていない
    expect(main.has(tip('release/v0.1'))).toBe(false);
    expect(reachableFrom(demo, tip('feat/dark-mode')).has(tip('main'))).toBe(false);

    const initial = demo.nodes[demo.nodes.length - 1]!;
    expect(branchesContaining(demo, reach, initial.sha).map((b) => b.name)).toEqual([
      'main',
      'feat/dark-mode',
      'release/v0.1',
    ]);
    expect(branchesContaining(demo, reach, demo.nodes[0]!.sha).map((b) => b.name)).toEqual([
      'main',
    ]);
  });

  it('counts how far a branch is ahead of another (rev-list base..branch --count)', () => {
    const reach = buildReachability(demo);
    expect(aheadCount(reach, 'main', 'main')).toBe(0);
    expect(aheadCount(reach, 'feat/dark-mode', 'main')).toBe(2); // y1, y2
    expect(aheadCount(reach, 'release/v0.1', 'main')).toBe(2); // r1, r2
    expect(aheadCount(reach, 'missing', 'main')).toBe(0);
    expect(aheadCount(reach, 'main', 'missing')).toBe(reach.get('main')!.size);
  });

  it('survives cycles and parents outside the loaded range', () => {
    const data: GraphData = {
      repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
      commits: [commit('c', ['b'], 3), commit('b', ['zzz'], 2)],
      refs: [{ name: 'main', sha: 'c', kind: 'branch', isDefault: true }],
    };
    const l = buildLayout(data);
    expect([...reachableFrom(l, 'c')].sort()).toEqual(['b', 'c']);
    expect(reachableFrom(l, 'nope').size).toBe(0);
  });

  it('matches every whitespace-separated term against message, author, sha and refs', () => {
    const node = demo.nodes.find((n) => n.refs.some((r) => r.name === 'v0.1.0'))!;
    expect(matchesQuery(node, '')).toBe(true);
    expect(matchesQuery(node, '   ')).toBe(true);
    expect(matchesQuery(node, 'MANIFEST')).toBe(true); // 不分大小寫
    expect(matchesQuery(node, 'manifest ben')).toBe(true); // AND
    expect(matchesQuery(node, 'manifest amy')).toBe(false);
    expect(matchesQuery(node, 'v0.1.0')).toBe(true); // tag 名稱
    expect(matchesQuery(node, 'release/v0.1')).toBe(true); // branch 名稱
    expect(matchesQuery(node, node.sha.slice(0, 7))).toBe(true);
    expect(matchesQuery(node, 'does-not-exist')).toBe(false);
  });
});
