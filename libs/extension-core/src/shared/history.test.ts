import { describe, expect, it } from 'vitest';
import type { CommitInput, GraphData } from '@adorable/graph-core';
import { mergeOlder, nextStarts, parseFetchMore } from './history';
import { FETCH_MORE_MAX_STARTS, HISTORY_LIMIT } from './messages';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const commit = (n: number, parents: number[]): CommitInput => ({
  sha: sha(n),
  parents: parents.map(sha),
  message: `c${n}`,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
});
const graph = (commits: CommitInput[]): GraphData => ({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits,
  refs: [],
  truncated: true,
});

describe('parseFetchMore', () => {
  const ok = { type: 'fetch-more', owner: 'o', repo: 'r', shas: [sha(1), sha(2).toUpperCase()] };

  it('accepts a well-formed request and returns a clean copy', () => {
    const parsed = parseFetchMore({ ...ok, extra: 'x' });
    expect(parsed).toEqual(ok);
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed?.shas).not.toBe(ok.shas);
  });

  it('rejects bad repos, bad shas and too many starts', () => {
    const bad = [
      null,
      'fetch-more',
      { ...ok, type: 'fetch-graph' },
      { ...ok, owner: '../x' },
      { ...ok, repo: 'a/b' },
      { ...ok, owner: 1 },
      { ...ok, shas: [] },
      { ...ok, shas: 'abc' },
      { ...ok, shas: ['main'] },
      { ...ok, shas: [`${sha(1)}&per_page=100`] },
      { ...ok, shas: [sha(1).slice(1)] },
      { ...ok, shas: [42] },
      { ...ok, shas: Array.from({ length: FETCH_MORE_MAX_STARTS + 1 }, (_, i) => sha(i + 1)) },
    ];
    for (const raw of bad) expect(parseFetchMore(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('nextStarts', () => {
  it('returns the missing parents minus the dead ones, capped', () => {
    // 10 ← 9（8 沒載入）；merge 20 的第二個 parent 15 也沒載入
    const g = graph([commit(20, [10, 15]), commit(10, [9]), commit(9, [8])]);
    expect(nextStarts(g, new Set())).toEqual([sha(15), sha(8)]);
    expect(nextStarts(g, new Set([sha(15)]))).toEqual([sha(8)]);
    expect(nextStarts(g, new Set([sha(15), sha(8)]))).toEqual([]);

    const wide = graph(Array.from({ length: 9 }, (_, i) => commit(100 + i, [i + 1])));
    expect(nextStarts(wide, new Set())).toHaveLength(FETCH_MORE_MAX_STARTS);
  });

  it('stops at the history limit and at the root', () => {
    expect(nextStarts(graph([commit(2, [1]), commit(1, [])]), new Set())).toEqual([]);
    const many = graph(Array.from({ length: HISTORY_LIMIT }, (_, i) => commit(i + 2, [i + 1])));
    expect(nextStarts(many, new Set())).toEqual([]);
  });
});

describe('mergeOlder', () => {
  it('appends the older commits and remembers starts that never came back', () => {
    const g = graph([commit(20, [10, 15]), commit(10, [9])]);
    // 9 的那一頁回來了，15 的沒有（GitHub 已經不認得）
    const r = mergeOlder(g, new Set(), [sha(9), sha(15)], [commit(9, [8]), commit(8, [])]);
    expect(r.graph.commits.map((c) => c.sha)).toEqual([20, 10, 9, 8].map(sha));
    expect([...r.dead]).toEqual([sha(15)]);
    expect(nextStarts(r.graph, r.dead)).toEqual([]);
    expect(r.graph.truncated).toBe(true); // 15 仍然缺：歷史確實是被截斷的
  });

  it('returns the same objects when nothing changed', () => {
    const g = graph([commit(10, [9])]);
    const dead = new Set([sha(9)]);
    const r = mergeOlder(g, dead, [sha(9)], []);
    expect(r.graph).toBe(g);
    expect(r.dead).toBe(dead);
  });
});
