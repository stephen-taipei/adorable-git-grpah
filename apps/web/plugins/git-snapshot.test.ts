import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLayout } from '@adorable/graph-core';
import { readGitSnapshot, snapshotKey } from './git-snapshot';

let root: string;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Amy',
  GIT_AUTHOR_EMAIL: 'amy@example.test',
  GIT_COMMITTER_NAME: 'Amy',
  GIT_COMMITTER_EMAIL: 'amy@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
let tick = 0;
const commit = (cwd: string, msg: string) => {
  // 固定、遞增的時間，讓 --date-order 可預期
  const date = `2026-01-01T00:00:${String(tick++).padStart(2, '0')}Z`;
  execFileSync('git', ['commit', '--allow-empty', '-m', msg], {
    cwd,
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agg-git-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/octo/cat.git');
  commit(root, 'chore: root');
  commit(root, 'feat: two');
  git(root, 'tag', 'v1');
  git(root, 'checkout', '-q', '-b', 'feat/x');
  commit(root, 'feat: side 1');
  commit(root, 'fix: side 2');
  git(root, 'checkout', '-q', 'main');
  commit(root, 'docs: main three');
  const date = '2026-01-01T00:01:00Z';
  execFileSync('git', ['merge', '--no-ff', 'feat/x', '-m', "Merge branch 'feat/x'"], {
    cwd: root,
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readGitSnapshot', () => {
  it('reads commits, branches and tags from a real repository', async () => {
    const snap = await readGitSnapshot(root);
    expect(snap.error).toBeUndefined();
    const g = snap.graph!;
    expect(g.commits).toHaveLength(6);
    expect(g.repo).toMatchObject({ owner: 'octo', name: 'cat', defaultBranch: 'main' });
    expect(
      g.refs
        .filter((r) => r.kind === 'branch')
        .map((r) => r.name)
        .sort(),
    ).toEqual(['feat/x', 'main']);
    expect(g.refs.find((r) => r.kind === 'tag')).toMatchObject({ name: 'v1' });
    expect(g.refs.find((r) => r.name === 'main')).toMatchObject({ isDefault: true });
    expect(g.commits.every((c) => c.url?.startsWith('https://github.com/octo/cat/commit/'))).toBe(
      true,
    );
    expect(g.commits.find((c) => c.message.startsWith('Merge'))!.parents).toHaveLength(2);
    expect(g.truncated).toBe(false);
  });

  it('never leaks credentials from the remote URL or author emails', async () => {
    const json = JSON.stringify(await readGitSnapshot(root));
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('x-access-token');
    expect(json).not.toContain('amy@example.test');
  });

  it('produces a layout with the merge on the main lane and a side branch lane', async () => {
    const layout = buildLayout((await readGitSnapshot(root)).graph!);
    const merge = layout.nodes.find((n) => n.kind === 'merge')!;
    expect(merge.lane).toBe(0);
    expect(merge.isHead).toBe(true);
    expect(layout.nodes.find((n) => n.subject === 'fix: side 2')!.lane).not.toBe(0);
  });

  it('respects maxCommits and flags the truncation', async () => {
    const snap = await readGitSnapshot(root, { maxCommits: 3 });
    expect(snap.graph!.commits).toHaveLength(3);
    expect(snap.graph!.truncated).toBe(true);
  });

  it('snapshotKey ignores timestamps but notices a new commit', async () => {
    const a = await readGitSnapshot(root);
    await new Promise((r) => setTimeout(r, 5));
    const b = await readGitSnapshot(root);
    expect(snapshotKey(a)).toBe(snapshotKey(b));
    commit(root, 'chore: extra');
    expect(snapshotKey(await readGitSnapshot(root))).not.toBe(snapshotKey(a));
  });

  it('falls back to HEAD when there is no branch at all (detached HEAD, e.g. CI checkouts)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agg-detached-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      commit(dir, 'chore: one');
      commit(dir, 'chore: two');
      git(dir, 'checkout', '-q', '--detach');
      git(dir, 'branch', '-q', '-D', 'main');
      const snap = await readGitSnapshot(dir);
      expect(snap.graph!.commits).toHaveLength(2);
      expect(snap.graph!.refs.filter((r) => r.kind === 'branch')).toEqual([]);
      expect(buildLayout(snap.graph!).nodes).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles an empty repository', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'agg-empty-'));
    try {
      git(empty, 'init', '-q', '-b', 'main');
      const snap = await readGitSnapshot(empty);
      expect(snap.graph!.commits).toEqual([]);
      expect(buildLayout(snap.graph!).nodes).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports a friendly error outside a git repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'agg-plain-'));
    try {
      mkdirSync(join(plain, 'sub'));
      writeFileSync(join(plain, 'sub', 'a.txt'), 'x');
      const snap = await readGitSnapshot(join(plain, 'sub'));
      expect(snap.graph).toBeNull();
      expect(snap.error).toMatch(/not inside a git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
