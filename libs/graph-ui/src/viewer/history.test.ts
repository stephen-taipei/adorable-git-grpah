import { describe, expect, it } from 'vitest';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import { historyFooterState, isAppendOnly, sameRowNode, shouldAutoLoad } from './history.ts';

const node = (sha: string, row: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  sha,
  shortSha: sha.slice(0, 7),
  row,
  lane: 0,
  colorIndex: 0,
  color: '#ff9ec7',
  kind: 'normal',
  subject: `subject ${sha}`,
  message: `subject ${sha}\n\nbody`,
  authorName: 'Ada',
  date: '2026-01-01T00:00:00.000Z',
  refs: [],
  parents: [],
  children: [],
  isHead: false,
  isCurrent: false,
  hasHiddenParents: false,
  ...extra,
});

const layout = (shas: string[], repo = 'r'): GraphLayout => ({
  repo: { owner: 'o', name: repo, defaultBranch: 'main' },
  nodes: shas.map((s, i) => node(s, i)),
  edges: [],
  branches: [],
  laneCount: 1,
  truncated: false,
});

describe('historyFooterState', () => {
  it('shows the end of history without onLoadMore or when there is nothing more', () => {
    expect(historyFooterState(false, { more: true, loading: false })).toBe('end');
    expect(historyFooterState(true, undefined)).toBe('end');
    expect(historyFooterState(true, { more: false, loading: false })).toBe('end');
    // 沒有更多時，殘留的 loading / error 也不顯示
    expect(historyFooterState(true, { more: false, loading: true, error: 'x' })).toBe('end');
  });
  it('loading wins over a stale error; error blocks the idle state', () => {
    expect(historyFooterState(true, { more: true, loading: false })).toBe('idle');
    expect(historyFooterState(true, { more: true, loading: true })).toBe('loading');
    expect(historyFooterState(true, { more: true, loading: true, error: 'network' })).toBe(
      'loading',
    );
    expect(historyFooterState(true, { more: true, loading: false, error: 'network' })).toBe(
      'error',
    );
    expect(historyFooterState(true, { more: true, loading: false, error: '' })).toBe('idle');
  });
});

describe('shouldAutoLoad', () => {
  const base = { state: 'idle' as const, near: true, key: 'repo#300', lastKey: null };
  it('triggers once when the footer comes near while idle', () => {
    expect(shouldAutoLoad(base)).toBe(true);
    expect(shouldAutoLoad({ ...base, near: false })).toBe(false);
  });
  it('never triggers twice for the same node count (appending nothing must not loop)', () => {
    expect(shouldAutoLoad({ ...base, lastKey: 'repo#300' })).toBe(false);
    expect(shouldAutoLoad({ ...base, key: 'repo#600', lastKey: 'repo#300' })).toBe(true);
  });
  it('does not trigger while loading, after an error or at the end', () => {
    for (const state of ['loading', 'error', 'end'] as const) {
      expect(shouldAutoLoad({ ...base, state })).toBe(false);
    }
  });
});

describe('isAppendOnly', () => {
  it('detects older commits appended after the existing rows', () => {
    expect(isAppendOnly(layout(['c', 'b']), layout(['c', 'b', 'a']))).toBe(true);
  });
  it('rejects anything else', () => {
    const l = layout(['c', 'b']);
    expect(isAppendOnly(l, l)).toBe(false);
    expect(isAppendOnly(null, l)).toBe(false);
    expect(isAppendOnly(l, null)).toBe(false);
    // 新的 commit 插在最上面（剛 commit / 重新整理）
    expect(isAppendOnly(l, layout(['d', 'c', 'b']))).toBe(false);
    // 順序變了、列數沒變多、換了 repo、原本是空的
    expect(isAppendOnly(l, layout(['b', 'c', 'a']))).toBe(false);
    expect(isAppendOnly(l, layout(['c', 'b']))).toBe(false);
    expect(isAppendOnly(l, layout(['c', 'b', 'a'], 'other'))).toBe(false);
    expect(isAppendOnly(layout([]), layout(['a']))).toBe(false);
  });
});

describe('sameRowNode', () => {
  it('treats a re-created node with the same rendered fields as unchanged', () => {
    const a = node('a', 3, { refs: [{ name: 'main', sha: 'a', kind: 'branch', isDefault: true }] });
    const b = node('a', 3, { refs: [{ name: 'main', sha: 'a', kind: 'branch', isDefault: true }] });
    expect(a).not.toBe(b);
    expect(sameRowNode(a, b)).toBe(true);
    // children / hasHiddenParents 不顯示在列上
    expect(sameRowNode(a, { ...b, children: ['x'], hasHiddenParents: true })).toBe(true);
  });
  it('notices every field the row renders', () => {
    const a = node('a', 3, { parents: ['p'] });
    const changes: Partial<GraphNode>[] = [
      { row: 4 },
      { lane: 1 },
      { color: '#000' },
      { kind: 'merge' },
      { subject: 'x' },
      { message: 'x' },
      { authorName: 'x' },
      { authorLogin: 'x' },
      { avatarUrl: 'x' },
      { date: '2027-01-01T00:00:00.000Z' },
      { shortSha: 'zzzzzzz' },
      { parents: ['p', 'q'] },
      { refs: [{ name: 'v1', sha: 'a', kind: 'tag' }] },
    ];
    for (const c of changes) expect(sameRowNode(a, { ...a, ...c }), JSON.stringify(c)).toBe(false);
    const withRef = node('a', 3, { refs: [{ name: 'origin/x', sha: 'a', kind: 'branch' }] });
    expect(
      sameRowNode(withRef, {
        ...withRef,
        refs: [{ name: 'origin/x', sha: 'a', kind: 'branch', remote: 'origin' }],
      }),
    ).toBe(false);
  });
});
