import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availability,
  branchNameProblem,
  canStashSave,
  changeCount,
  defaultRemote,
  fetchRepoStatus,
  isRepoStatus,
  outputTail,
  pushTarget,
  refNameProblem,
  resultKind,
  runGitAction,
  suggestWorktreePath,
  tagRemote,
} from './git';
import type { RepoStatus } from './protocol';

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  branch: 'main',
  head: 'a'.repeat(40),
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  remotes: ['origin'],
  stashes: [],
  worktrees: [],
  operation: null,
  bare: false,
  ...over,
});

describe('availability', () => {
  it('enables everything on a normal branch with an upstream it is ahead of', () => {
    const s = status({ ahead: 2 });
    for (const a of ['fetch', 'pull', 'push', 'stash', 'tag', 'worktree'] as const)
      expect(availability(s, a, false)).toEqual({ enabled: true });
  });

  it('disables everything while another action runs', () => {
    expect(availability(status(), 'fetch', true)).toEqual({ enabled: false, reason: 'busy' });
    expect(availability(status(), 'worktree', true)).toEqual({ enabled: false, reason: 'busy' });
  });

  it('needs a remote to fetch / push', () => {
    const s = status({ remotes: [], upstream: null });
    expect(availability(s, 'fetch', false).reason).toBe('noRemote');
    expect(availability(s, 'push', false).reason).toBe('noRemote');
  });

  it('pull: needs a branch with an upstream and no merge / rebase in progress', () => {
    expect(availability(status({ branch: null }), 'pull', false).reason).toBe('detached');
    expect(availability(status({ upstream: null }), 'pull', false).reason).toBe('noUpstream');
    expect(availability(status({ operation: 'rebase' }), 'pull', false).reason).toBe('operation');
    // bisect 不擋 pull
    expect(availability(status({ operation: 'bisect' }), 'pull', false).enabled).toBe(true);
    expect(availability(status({ bare: true }), 'pull', false).reason).toBe('bare');
  });

  it('push: detached / unborn / nothing to push are refused; no upstream still allowed (set-upstream)', () => {
    expect(availability(status({ branch: null, ahead: 1 }), 'push', false).reason).toBe('detached');
    expect(availability(status({ head: null }), 'push', false).reason).toBe('unborn');
    expect(availability(status({ ahead: 0 }), 'push', false).reason).toBe('upToDate');
    expect(availability(status({ upstream: null }), 'push', false).enabled).toBe(true);
  });

  it('stash / tag need a commit', () => {
    expect(availability(status({ head: null }), 'stash', false).reason).toBe('unborn');
    expect(availability(status({ head: null }), 'tag', false).reason).toBe('unborn');
  });
});

describe('canStashSave', () => {
  it('needs changes and no merge / rebase', () => {
    expect(canStashSave(status(), false).reason).toBe('clean');
    const dirty = status({ changes: { staged: 1, unstaged: 0, untracked: 2, conflicted: 0 } });
    expect(changeCount(dirty)).toBe(3);
    expect(canStashSave(dirty, false)).toEqual({ enabled: true });
    expect(canStashSave({ ...dirty, operation: 'merge' }, false).reason).toBe('operation');
    expect(canStashSave(dirty, true).reason).toBe('busy');
  });
});

describe('pushTarget / remotes', () => {
  it('pushes to the upstream, or asks for a remote when there is none', () => {
    expect(pushTarget(status())).toEqual({ mode: 'upstream', upstream: 'origin/main' });
    expect(pushTarget(status({ upstream: null, remotes: ['up', 'origin'] }))).toEqual({
      mode: 'set-upstream',
      remotes: ['up', 'origin'],
    });
    expect(pushTarget(status({ branch: null }))).toBeNull();
    expect(pushTarget(status({ remotes: [] }))).toBeNull();
  });

  it('prefers origin', () => {
    expect(defaultRemote(['up', 'origin'])).toBe('origin');
    expect(defaultRemote(['up'])).toBe('up');
  });

  it('pushes tags to the upstream remote, else origin', () => {
    expect(tagRemote(status({ upstream: 'up/main', remotes: ['origin', 'up'] }))).toBe('up');
    expect(tagRemote(status({ upstream: null, remotes: ['origin'] }))).toBe('origin');
    expect(tagRemote(status({ upstream: null, remotes: ['up'] }))).toBeNull();
  });
});

describe('refNameProblem', () => {
  it.each(['v1.0.0', 'release/2026-10', 'feat/x_y', 'a.b'])('accepts %s', (name) => {
    expect(refNameProblem(name)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['-x', 'dash'],
    ['bad name', 'chars'],
    ['a~b', 'chars'],
    ['a:b', 'chars'],
    ['a\\b', 'chars'],
    ['a..b', 'format'],
    ['a@{b', 'format'],
    ['/a', 'format'],
    ['a/', 'format'],
    ['a.', 'format'],
    ['.a', 'format'],
    ['a/.b', 'format'],
    ['a.lock', 'format'],
    ['a//b', 'format'],
    ['@', 'format'],
    ['x'.repeat(256), 'long'],
  ])('rejects %j (%s)', (name, problem) => {
    expect(refNameProblem(name)).toBe(problem);
  });

  it('branches cannot be called HEAD', () => {
    expect(refNameProblem('HEAD')).toBeNull();
    expect(branchNameProblem('HEAD')).toBe('format');
  });
});

describe('suggestWorktreePath', () => {
  it('derives a sibling folder from the branch name', () => {
    expect(suggestWorktreePath('repo', 'feat/login page')).toBe('repo-feat-login-page');
    expect(suggestWorktreePath('repo', '')).toBe('');
    expect(suggestWorktreePath('repo', '../..')).toBe('');
  });
});

describe('resultKind / outputTail', () => {
  it('maps results to message kinds', () => {
    expect(resultKind({ type: 'fetch' }, { ok: true, output: '' })).toEqual({
      tone: 'ok',
      key: 'fetch',
    });
    expect(resultKind({ type: 'pull' }, { ok: true, output: '', code: 'nothing' })).toEqual({
      tone: 'info',
      key: 'nothing',
    });
    expect(resultKind({ type: 'pull' }, { ok: false, output: '', code: 'not_ff' })).toEqual({
      tone: 'error',
      key: 'not_ff',
    });
    expect(
      resultKind(
        { type: 'fetch' },
        { ok: false, output: '', code: 'failed', transport: 'offline' },
      ),
    ).toEqual({ tone: 'error', key: 'offline' });
    expect(resultKind({ type: 'fetch' }, { ok: false, output: '' })).toEqual({
      tone: 'error',
      key: 'failed',
    });
  });

  it('keeps the last non-empty lines', () => {
    expect(outputTail('a\n\nb\nc\n\nd\n', 2)).toBe('c\nd');
  });
});

describe('endpoints', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('status: hides the UI when the server says no, keeps it on transient errors', async () => {
    vi.stubGlobal('fetch', respond(200, status()));
    expect(await fetchRepoStatus('default')).toEqual({ kind: 'ok', status: status() });
    for (const code of [403, 404, 405, 422]) {
      vi.stubGlobal('fetch', respond(code, { error: 'x' }));
      expect(await fetchRepoStatus('default')).toEqual({ kind: 'unavailable' });
    }
    vi.stubGlobal('fetch', respond(503, { error: 'git_error' }));
    expect(await fetchRepoStatus('default')).toEqual({ kind: 'error' });
    vi.stubGlobal('fetch', respond(200, { nope: true }));
    expect(await fetchRepoStatus('default')).toEqual({ kind: 'unavailable' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await fetchRepoStatus('default')).toEqual({ kind: 'error' });
  });

  it('status: encodes the repo id', async () => {
    const f = respond(200, status());
    vi.stubGlobal('fetch', f);
    await fetchRepoStatus('0123456789ab');
    expect((f.mock.calls[0] as unknown[])[0]).toBe('/__agg/status?repo=0123456789ab');
  });

  it('action: posts JSON and maps the HTTP outcome', async () => {
    const f = respond(200, { ok: true, output: 'done', code: 'nothing' });
    vi.stubGlobal('fetch', f);
    expect(await runGitAction('default', { type: 'fetch' })).toEqual({
      ok: true,
      output: 'done',
      code: 'nothing',
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/__agg/git');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ repo: 'default', action: { type: 'fetch' } });

    vi.stubGlobal('fetch', respond(409, { ok: false, output: '', code: 'busy', error: 'busy' }));
    expect(await runGitAction('default', { type: 'fetch' })).toEqual({
      ok: false,
      output: '',
      code: 'busy',
    });
    vi.stubGlobal('fetch', respond(403, { ok: false, output: '', error: 'local_only' }));
    expect((await runGitAction('default', { type: 'fetch' })).transport).toBe('forbidden');
    vi.stubGlobal('fetch', respond(200, { ok: false, output: 'x', code: 'weird' }));
    expect(await runGitAction('default', { type: 'fetch' })).toEqual({ ok: false, output: 'x' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect((await runGitAction('default', { type: 'fetch' })).transport).toBe('offline');
  });

  it('isRepoStatus checks the shape', () => {
    expect(isRepoStatus(status())).toBe(true);
    expect(isRepoStatus({ ...status(), changes: null })).toBe(false);
    expect(isRepoStatus(null)).toBe(false);
  });
});
