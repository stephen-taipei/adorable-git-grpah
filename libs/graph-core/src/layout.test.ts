import { describe, expect, it } from 'vitest';
import { buildLayout, classifyCommit, laneY, routeEdge } from './layout.ts';
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

describe('laneY', () => {
  it('alternates around the center', () => {
    expect([0, 1, 2, 3, 4].map(laneY)).toEqual([0, 1, -1, 2, -2]);
  });
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
  it('puts a linear history on lane 0, oldest on the left', () => {
    const l = buildLayout(
      data([commit('c', ['b'], 3), commit('b', ['a'], 2), commit('a', [], 1)], 'c'),
    );
    expect(l.nodes.map((n) => [n.sha, n.x, n.lane])).toEqual([
      ['a', 0, 0],
      ['b', 1, 0],
      ['c', 2, 0],
    ]);
    expect(l.edges.every((e) => e.kind === 'main')).toBe(true);
    expect(l.edges.every((e) => e.points.length === 2)).toBe(true);
    expect(l.truncated).toBe(false);
    expect(l.nodes[0]!.kind).toBe('root');
    expect(l.nodes[2]!.isHead).toBe(true);
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

  it('never places two nodes on the same lane+x and orders parents before children', () => {
    const l = buildLayout(createDemoData());
    const seen = new Set<string>();
    for (const n of l.nodes) {
      const k = `${n.x}:${n.lane}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    const x = new Map(l.nodes.map((n) => [n.sha, n.x]));
    for (const e of l.edges) expect(x.get(e.from)!).toBeLessThan(x.get(e.to)!);
    expect(l.nodes).toHaveLength(createDemoData().commits.length);
  });

  it('edge polylines start at the parent and end at the child, left → right', () => {
    const l = buildLayout(createDemoData());
    const by = new Map(l.nodes.map((n) => [n.sha, n]));
    for (const e of l.edges) {
      const first = e.points[0]!;
      const last = e.points[e.points.length - 1]!;
      expect(first).toEqual([by.get(e.from)!.x, by.get(e.from)!.y]);
      expect(last[0]).toBeCloseTo(by.get(e.to)!.x);
      expect(last[1]).toBeCloseTo(by.get(e.to)!.y);
      for (let i = 1; i < e.points.length; i++) {
        expect(e.points[i]![0]).toBeGreaterThanOrEqual(e.points[i - 1]![0] - 1e-9);
      }
    }
  });

  it('flags truncated history when parents are outside the loaded range', () => {
    const l = buildLayout(data([commit('c', ['b'], 3), commit('b', ['zzz'], 2)], 'c'));
    expect(l.truncated).toBe(true);
    expect(l.nodes.find((n) => n.sha === 'b')!.hasHiddenParents).toBe(true);
    expect(l.edges).toHaveLength(1);
  });

  it('clips to the newest maxCommits', () => {
    const cs = Array.from({ length: 10 }, (_, i) => commit(`c${i}`, i ? [`c${i - 1}`] : [], i));
    const l = buildLayout(data(cs, 'c9'), { maxCommits: 4 });
    expect(l.nodes.map((n) => n.sha)).toEqual(['c6', 'c7', 'c8', 'c9']);
    expect(l.truncated).toBe(true);
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
    expect(routeEdge({ x: 0, y: 0 }, { x: 5, y: 0 }, 0)).toEqual([
      [0, 0],
      [5, 0],
    ]);
  });
  it('shrinks the curve when parent and child are adjacent', () => {
    const pts = routeEdge({ x: 0, y: 0 }, { x: 1, y: 2 }, 2);
    expect(pts[0]).toEqual([0, 0]);
    const last = pts[pts.length - 1]!;
    expect(last[0]).toBeCloseTo(1);
    expect(last[1]).toBeCloseTo(2);
  });
});
