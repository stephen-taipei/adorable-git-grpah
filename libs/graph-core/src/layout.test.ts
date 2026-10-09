import { describe, expect, it } from 'vitest';
import { buildLayout, classifyCommit, routeEdge } from './layout.ts';
import { createDemoData } from './demo.ts';
import type { CommitInput, GraphData } from './types.ts';

const commit = (sha: string, parents: string[], hour: number, message = sha): CommitInput => ({
  sha,
  parents,
  message,
  authorName: 'a',
  date: new Date(Date.UTC(2026, 0, 1) + hour * 3600_000).toISOString(),
});

const data = (commits: CommitInput[], head: string): GraphData => ({
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  commits,
  refs: [{ name: 'main', sha: head, kind: 'branch', isDefault: true }],
});

describe('classifyCommit', () => {
  it.each([
    ['feat: a', 1, 'feat'],
    ['fix(core)!: a', 1, 'fix'],
    ['Revert "x"', 1, 'revert'],
    ['whatever', 1, 'normal'],
    ['feat: a', 2, 'merge'],
    ['init', 0, 'root'],
  ])('%s (%i parents) → %s', (msg, n, kind) => {
    expect(classifyCommit(msg, n)).toBe(kind);
  });
});

describe('buildLayout', () => {
  it('puts a linear history on lane 0, newest on the first row', () => {
    const l = buildLayout(
      data([commit('c', ['b'], 3), commit('b', ['a'], 2), commit('a', [], 1)], 'c'),
    );
    expect(l.nodes.map((n) => [n.sha, n.row, n.lane])).toEqual([
      ['c', 0, 0],
      ['b', 1, 0],
      ['a', 2, 0],
    ]);
    expect(l.edges.every((e) => e.kind === 'main')).toBe(true);
    expect(l.edges.every((e) => e.points.length === 2)).toBe(true);
    expect(l.truncated).toBe(false);
    expect(l.laneCount).toBe(1);
    expect(l.nodes[2]!.kind).toBe('root');
    expect(l.nodes[0]!.isHead).toBe(true);
    expect(l.nodes.map((n) => n.children)).toEqual([[], ['c'], ['b']]);
  });

  it('keeps the default branch on lane 0 and moves side branches off it', () => {
    //  a - b - m(merge)
    //   \     /
    //    f1 - f2
    const l = buildLayout(
      data(
        [
          commit('m', ['b', 'f2'], 6),
          commit('f2', ['f1'], 5),
          commit('b', ['a'], 4),
          commit('f1', ['a'], 3),
          commit('a', [], 1),
        ],
        'm',
      ),
    );
    const by = Object.fromEntries(l.nodes.map((n) => [n.sha, n]));
    expect([by.a, by.b, by.m].map((n) => n!.lane)).toEqual([0, 0, 0]);
    expect(by.f1!.lane).toBe(by.f2!.lane);
    expect(by.f1!.lane).not.toBe(0);
    expect(by.m!.kind).toBe('merge');
    expect(by.f1!.colorIndex).not.toBe(by.a!.colorIndex);

    const kinds = Object.fromEntries(l.edges.map((e) => [`${e.from}>${e.to}`, e.kind]));
    expect(kinds['a>f1']).toBe('fork');
    expect(kinds['f2>m']).toBe('merge');
    expect(kinds['a>b']).toBe('main');
  });

  it('gives every node its own row (row === index) and lists children before parents', () => {
    const l = buildLayout(createDemoData());
    l.nodes.forEach((n, i) => expect(n.row).toBe(i));
    const row = new Map(l.nodes.map((n) => [n.sha, n.row]));
    for (const e of l.edges) expect(row.get(e.to)!).toBeLessThan(row.get(e.from)!);
    expect(l.nodes).toHaveLength(createDemoData().commits.length);
    expect(l.laneCount).toBe(Math.max(...l.nodes.map((n) => n.lane)) + 1);
  });

  it('edge polylines start at the child (top) and end at the parent (bottom), top → bottom', () => {
    const l = buildLayout(createDemoData());
    const by = new Map(l.nodes.map((n) => [n.sha, n]));
    for (const e of l.edges) {
      const first = e.points[0]!;
      const last = e.points[e.points.length - 1]!;
      expect(first).toEqual([by.get(e.to)!.lane, by.get(e.to)!.row]);
      expect(last[0]).toBeCloseTo(by.get(e.from)!.lane);
      expect(last[1]).toBeCloseTo(by.get(e.from)!.row);
      for (let i = 1; i < e.points.length; i++) {
        expect(e.points[i]![1]).toBeGreaterThanOrEqual(e.points[i - 1]![1] - 1e-9);
      }
    }
  });

  it('records children and the checked-out branch tip (local sources)', () => {
    //  a - b - m(merge, main)
    //   \     /
    //    f1 - f2   (current branch: feat)
    const cs = [
      commit('m', ['b', 'f2'], 6),
      commit('f2', ['f1'], 5),
      commit('b', ['a'], 4),
      commit('f1', ['a'], 3),
      commit('a', [], 1),
    ];
    const l = buildLayout({
      repo: { owner: 'o', name: 'r', defaultBranch: 'main', currentBranch: 'feat' },
      commits: cs,
      refs: [
        { name: 'main', sha: 'm', kind: 'branch', isDefault: true },
        { name: 'feat', sha: 'f2', kind: 'branch' },
        { name: 'origin/feat', sha: 'f1', kind: 'branch', remote: 'origin' },
      ],
    });
    const by = Object.fromEntries(l.nodes.map((n) => [n.sha, n]));
    expect(by.a!.children.sort()).toEqual(['b', 'f1']);
    expect(by.m!.isCurrent).toBe(false);
    expect(by.f2!.isCurrent).toBe(true);
    expect(by.f2!.isHead).toBe(false);
    // 圖例：default → 目前 → 其他本機 → remote
    expect(l.branches.map((b) => [b.name, b.isCurrent, b.remote])).toEqual([
      ['main', false, undefined],
      ['feat', true, undefined],
      ['origin/feat', false, 'origin'],
    ]);
  });

  it('flags truncated history when parents are outside the loaded range', () => {
    const l = buildLayout(data([commit('c', ['b'], 3), commit('b', ['zzz'], 2)], 'c'));
    expect(l.truncated).toBe(true);
    expect(l.nodes.find((n) => n.sha === 'b')!.hasHiddenParents).toBe(true);
    expect(l.edges).toHaveLength(1);
  });

  it('survives broken / forged histories: self-parent and cycles never crash the layout', () => {
    const l = buildLayout(
      data(
        [
          commit('c', ['f1', 'b'], 5),
          commit('b', ['a'], 3),
          commit('a', [], 1),
          commit('f1', ['f1'], 4), // 自己是自己的 parent
          commit('x', ['y'], 2),
          commit('y', ['x'], 2), // 互相為 parent 的環
        ],
        'c',
      ),
    );
    expect(l.nodes.map((n) => n.sha).sort()).toEqual(['a', 'b', 'c']);
    for (const e of l.edges) {
      expect(l.nodes.some((n) => n.sha === e.from)).toBe(true);
      expect(l.nodes.some((n) => n.sha === e.to)).toBe(true);
    }
  });

  it('clips to the newest maxCommits', () => {
    const cs = Array.from({ length: 10 }, (_, i) => commit(`c${i}`, i ? [`c${i - 1}`] : [], i));
    const l = buildLayout(data(cs, 'c9'), { maxCommits: 4 });
    expect(l.nodes.map((n) => n.sha)).toEqual(['c9', 'c8', 'c7', 'c6']);
    expect(l.truncated).toBe(true);
  });

  it('keeps the default branch tip (and its recent history) when other branches are much newer', () => {
    // main の tip は 5 本目の古い commit。別 branch が新しい commit を大量に持っていても、clip で main が消えない
    const main = Array.from({ length: 5 }, (_, i) => commit(`m${i}`, i ? [`m${i - 1}`] : [], i));
    const side = Array.from({ length: 30 }, (_, i) =>
      commit(`s${i}`, i ? [`s${i - 1}`] : ['m0'], 100 + i),
    );
    const l = buildLayout(
      {
        repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
        commits: [...main, ...side],
        refs: [
          { name: 'main', sha: 'm4', kind: 'branch', isDefault: true },
          { name: 'feat', sha: 's29', kind: 'branch' },
        ],
      },
      { maxCommits: 10 },
    );
    expect(l.truncated).toBe(true);
    expect(l.nodes.length).toBe(10);
    const head = l.nodes.find((n) => n.isHead);
    expect(head?.sha).toBe('m4');
    expect(head?.lane).toBe(0);
    expect(l.branches.map((b) => b.name)).toContain('main');
  });

  it('survives an empty repo and duplicate commits', () => {
    expect(buildLayout(data([], 'x')).nodes).toEqual([]);
    const c = commit('a', [], 1);
    expect(buildLayout(data([c, c], 'a')).nodes).toHaveLength(1);
  });

  it('lists branches in the legend with the default first and colors from the tip', () => {
    const l = buildLayout(createDemoData());
    expect(l.branches[0]).toMatchObject({ name: 'main', isDefault: true });
    expect(l.branches.map((b) => b.name)).toEqual(['main', 'feat/dark-mode', 'release/v0.1']);
    const head = l.nodes.find((n) => n.isHead)!;
    expect(l.branches[0]!.color).toBe(head.color);
  });
});

describe('routeEdge', () => {
  it('returns a straight segment on the same lane', () => {
    expect(routeEdge({ lane: 0, row: 0 }, { lane: 0, row: 5 }, 0)).toEqual([
      [0, 0],
      [0, 5],
    ]);
  });
  it('runs vertically on the via lane and only bends near the end', () => {
    const pts = routeEdge({ lane: 2, row: 0 }, { lane: 0, row: 6 }, 2);
    expect(pts[0]).toEqual([2, 0]);
    expect(pts[1]).toEqual([2, 5]);
    const last = pts[pts.length - 1]!;
    expect(last[0]).toBeCloseTo(0);
    expect(last[1]).toBeCloseTo(6);
    for (const [lane] of pts) expect(lane).toBeLessThanOrEqual(2 + 1e-9);
  });
  it('shrinks the curve when parent and child are on adjacent rows', () => {
    const pts = routeEdge({ lane: 0, row: 0 }, { lane: 2, row: 1 }, 0);
    expect(pts[0]).toEqual([0, 0]);
    const last = pts[pts.length - 1]!;
    expect(last[0]).toBeCloseTo(2);
    expect(last[1]).toBeCloseTo(1);
    for (const [, row] of pts) {
      expect(row).toBeGreaterThanOrEqual(-1e-9);
      expect(row).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('bends at both ends when the via lane differs from both', () => {
    const pts = routeEdge({ lane: 0, row: 0 }, { lane: 1, row: 10 }, 3);
    const lanes = pts.map(([l]) => l);
    expect(Math.max(...lanes)).toBeCloseTo(3);
    expect(lanes[0]).toBe(0);
    expect(lanes[lanes.length - 1]).toBeCloseTo(1);
  });
});
