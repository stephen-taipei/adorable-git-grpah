import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLayout } from '@adorable/graph-core';
import { gitSnapshot, readGitSnapshot, snapshotKey, watchGitRefs } from './git-snapshot.ts';

const tmps: string[] = [];
const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
};

const baseEnv = {
  GIT_AUTHOR_NAME: 'Amy',
  GIT_AUTHOR_EMAIL: 'amy@example.test',
  GIT_COMMITTER_NAME: 'Amy',
  GIT_COMMITTER_EMAIL: 'amy@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
// plugin 以 process.env 執行 git：測試期間固定成乾淨的設定，不受執行者的 ~/.gitconfig 影響
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(baseEnv)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// beforeAll で baseEnv は process.env に入っている。テストが GIT_CONFIG_GLOBAL を差し替えたらそれを尊重する
const env = () => ({ ...process.env });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim();
let tick = 0;
const commit = (cwd: string, msg: string, ...extra: string[]) => {
  // 固定、遞增的時間，讓 --date-order 可預期
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  execFileSync('git', ['commit', '--allow-empty', ...extra, '-m', msg], {
    cwd,
    env: { ...env(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean, timeout = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > timeout) throw new Error('waitFor timed out');
    await sleep(25);
  }
};

let root: string;
beforeAll(() => {
  root = tmp('agg-git-');
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
  const date = new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString();
  execFileSync('git', ['merge', '--no-ff', 'feat/x', '-m', "Merge branch 'feat/x'"], {
    cwd: root,
    env: { ...env(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
});

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

  it('never leaks remote credentials, author emails, or message bodies / trailers', async () => {
    const dir = tmp('agg-trailer-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/octo/cat.git');
    commit(
      dir,
      'feat: subject line\n\nlong body that must stay local\n\nSigned-off-by: Bob <bob.private@corp.example>\nCo-authored-by: Cy <cy.private@corp.example>',
    );
    const json = JSON.stringify(await readGitSnapshot(dir));
    for (const secret of [
      'SECRET',
      'x-access-token',
      'amy@example.test',
      'bob.private',
      'cy.private',
      'long body',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(json).toContain('feat: subject line');
  });

  it('cannot be forged or broken by control characters inside a commit subject', async () => {
    const dir = tmp('agg-forge-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'chore: root');
    const fake = 'a'.repeat(40);
    commit(
      dir,
      `fix: pwn\x1e${fake}\x1f${fake}\x1fLinus Torvalds\x1f2026-01-01T00:00:00+00:00\x1fforged`,
    );
    const g = (await readGitSnapshot(dir)).graph!;
    expect(g.commits).toHaveLength(2);
    expect(g.commits.every((c) => c.authorName === 'Amy')).toBe(true);
    expect(g.commits.some((c) => c.sha === fake)).toBe(false);
    expect(() => buildLayout(g)).not.toThrow();
  });

  it('ignores log.showSignature from the user config (signed commits stay in the graph)', async () => {
    const dir = tmp('agg-signed-');
    const fakeGpg = join(dir, 'fakegpg.sh');
    writeFileSync(
      fakeGpg,
      `#!/bin/sh
case "$*" in
  *--verify*)
    echo "gpg: Signature made Thu 01 Jan 2026 00:00:00 UTC" >&2
    echo "gpg: Can't check signature: No public key" >&2
    echo "[GNUPG:] ERRSIG 0 1 8 00 0 9 - 0000" ;;
  *)
    cat >/dev/null
    echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0000" >&2
    printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n' ;;
esac
`,
    );
    chmodSync(fakeGpg, 0o755);
    const cfg = join(dir, 'gitconfig');
    writeFileSync(cfg, `[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${fakeGpg}\n`);

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const prev = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    try {
      git(repo, 'init', '-q', '-b', 'main');
      commit(repo, 'one');
      commit(repo, 'signed two', '-S');
      commit(repo, 'three');
      const g = (await readGitSnapshot(repo)).graph!;
      expect(g.commits.map((c) => c.message).sort()).toEqual(['one', 'signed two', 'three']);
      expect(g.refs.find((r) => r.name === 'main')).toBeTruthy();
    } finally {
      process.env['GIT_CONFIG_GLOBAL'] = prev;
    }
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

  it('honours the AGG_* environment variables', async () => {
    const keys = ['AGG_MAX_COMMITS', 'AGG_MAX_BRANCHES', 'AGG_DEFAULT_BRANCH'] as const;
    try {
      process.env['AGG_MAX_COMMITS'] = '2';
      expect((await readGitSnapshot(root)).graph!.commits).toHaveLength(2);
      delete process.env['AGG_MAX_COMMITS'];

      process.env['AGG_MAX_BRANCHES'] = '1';
      expect(
        (await readGitSnapshot(root)).graph!.refs.filter((r) => r.kind === 'branch'),
      ).toHaveLength(1);
      delete process.env['AGG_MAX_BRANCHES'];

      process.env['AGG_DEFAULT_BRANCH'] = 'feat/x';
      const g = (await readGitSnapshot(root)).graph!;
      expect(g.repo.defaultBranch).toBe('feat/x');
      expect(g.refs.find((r) => r.isDefault)!.name).toBe('feat/x');
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });

  it('snapshotKey ignores timestamps but notices a new commit', async () => {
    const dir = tmp('agg-key-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'a');
    const a = await readGitSnapshot(dir);
    await sleep(5);
    const b = await readGitSnapshot(dir);
    expect(snapshotKey(a)).toBe(snapshotKey(b));
    commit(dir, 'b');
    expect(snapshotKey(await readGitSnapshot(dir))).not.toBe(snapshotKey(a));
  });

  it('falls back to HEAD when there is no branch at all (detached HEAD, e.g. CI checkouts)', async () => {
    const dir = tmp('agg-detached-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'chore: one');
    commit(dir, 'chore: two');
    git(dir, 'checkout', '-q', '--detach');
    git(dir, 'branch', '-q', '-D', 'main');
    const snap = await readGitSnapshot(dir);
    expect(snap.graph!.commits).toHaveLength(2);
    expect(snap.graph!.refs.filter((r) => r.kind === 'branch')).toEqual([]);
    expect(buildLayout(snap.graph!).nodes).toHaveLength(2);
  });

  it('handles an empty repository', async () => {
    const empty = tmp('agg-empty-');
    git(empty, 'init', '-q', '-b', 'main');
    const snap = await readGitSnapshot(empty);
    expect(snap.graph!.commits).toEqual([]);
    expect(buildLayout(snap.graph!).nodes).toEqual([]);
  });

  it('reads bare repositories (name comes from the folder)', async () => {
    const dir = tmp('agg-bare-');
    const bare = join(dir, 'project.git');
    git(dir, 'clone', '-q', '--bare', root, bare);
    const g = (await readGitSnapshot(bare)).graph!;
    expect(g.commits).toHaveLength(6);
    expect(g.repo.name).toBe('project');
  });

  it('flags shallow clones as truncated', async () => {
    const dir = tmp('agg-shallow-');
    const clone = join(dir, 'clone');
    git(dir, 'clone', '-q', '--depth', '2', `file://${root}`, clone);
    const g = (await readGitSnapshot(clone)).graph!;
    expect(g.truncated).toBe(true);
    expect(g.commits.length).toBeGreaterThan(0);
  });

  it('reports friendly errors that never contain local paths', async () => {
    const plain = tmp('agg-plain-');
    mkdirSync(join(plain, 'sub'));
    writeFileSync(join(plain, 'sub', 'a.txt'), 'x');
    const missing = join(plain, 'does-not-exist');

    for (const dir of [join(plain, 'sub'), missing]) {
      const snap = await readGitSnapshot(dir);
      expect(snap.graph).toBeNull();
      expect(snap.error).toMatch(/not inside a git repository|does not exist/);
      expect(snap.error).not.toContain(tmpdir());
    }
  });

  it('returns a transient error snapshot (and warns) instead of throwing when git itself fails', async () => {
    const dir = tmp('agg-broken-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'ok');
    // ref 指到不存在的 object：`git for-each-ref` 以 128 結束（fatal: missing object）
    writeFileSync(join(dir, '.git/refs/heads/bad'), `${'1'.repeat(40)}\n`);
    const warnings: string[] = [];
    const snap = await readGitSnapshot(dir, { onWarn: (m) => warnings.push(m) });
    expect(snap.graph).toBeNull();
    expect(snap.transient).toBe(true);
    expect(snap.error).toMatch(/git reported an error/);
    expect(snap.error).not.toContain(tmpdir());
    expect(warnings.join('\n')).toMatch(/missing object/); // 細節只走 onWarn（終端機），不進快照
  });

  it('is not fooled by a non-UTF-8 i18n.logOutputEncoding in the user config', async () => {
    const dir = tmp('agg-enc-');
    const cfg = join(dir, 'gitconfig');
    writeFileSync(cfg, '[i18n]\n\tlogOutputEncoding = latin1\n');
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const prev = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfg;
    try {
      git(repo, 'init', '-q', '-b', 'main');
      commit(repo, 'feat: café 日本語 ✓');
      const g = (await readGitSnapshot(repo)).graph!;
      expect(g.commits[0]!.message).toBe('feat: café 日本語 ✓');
    } finally {
      process.env['GIT_CONFIG_GLOBAL'] = prev;
    }
  });

  it('always loads the default branch tip, even when other branches have newer commits than the cap', async () => {
    const dir = tmp('agg-default-tip-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'main: old tip');
    git(dir, 'checkout', '-q', '-b', 'busy');
    for (let i = 0; i < 6; i++) commit(dir, `busy ${i}`);
    const g = (await readGitSnapshot(dir, { maxCommits: 3 })).graph!;
    expect(g.refs.find((r) => r.isDefault)?.name).toBe('main');
    expect(g.commits.some((c) => c.message === 'main: old tip')).toBe(true);
    expect(buildLayout(g).nodes.find((n) => n.isHead)?.subject).toBe('main: old tip');
  });
});

describe('watchGitRefs (regression: live updates must keep working after the first change)', () => {
  it('fires for EVERY consecutive commit, branch switch and ref update — not just the first', async () => {
    const dir = tmp('agg-watch-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const gitDir = join(dir, '.git');

    let calls = 0;
    const stop = watchGitRefs([gitDir], () => calls++);
    try {
      const expectEvent = async (label: string, action: () => void) => {
        const before = calls;
        action();
        await waitFor(() => calls > before, 4000).catch(() => {
          throw new Error(`no event after: ${label}`);
        });
        await sleep(150);
      };
      // Node 在 Linux 的遞迴 fs.watch 會在第 2 次之後就不再通知；這裡連續做很多次
      for (let i = 2; i <= 6; i++) await expectEvent(`commit #${i}`, () => commit(dir, `c${i}`));
      await expectEvent('checkout -b other', () => git(dir, 'checkout', '-q', '-b', 'other'));
      await expectEvent('checkout main', () => git(dir, 'checkout', '-q', 'main'));
      await expectEvent('checkout other again', () => git(dir, 'checkout', '-q', 'other'));
      await expectEvent('tag', () => git(dir, 'tag', 'v1'));
      await expectEvent('new nested branch dir', () => git(dir, 'branch', 'feat/deep/er'));
      await expectEvent('checkout into it', () => git(dir, 'checkout', '-q', 'feat/deep/er'));
      // 這一步只改動「新建出來的巢狀目錄」裡的 ref 檔：目錄若沒被補上監看，就收不到事件
      await expectEvent('commit inside the nested ref directory', () => commit(dir, 'nested'));
    } finally {
      stop();
    }
  });

  it('keeps watching a ref directory that is deleted and re-created (branch delete, git gc, pack-refs)', async () => {
    const dir = tmp('agg-watch-recreate-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    git(dir, 'branch', 'feat/a');
    const gitDir = join(dir, '.git');

    let calls = 0;
    const stop = watchGitRefs([gitDir], () => calls++);
    try {
      const expectEvent = async (label: string, action: () => void) => {
        const before = calls;
        action();
        await waitFor(() => calls > before, 4000).catch(() => {
          throw new Error(`no event after: ${label}`);
        });
        await sleep(200);
      };
      // refs/heads/feat 被刪掉（最後一個 feat/* 刪除）再重建，之後只改動裡面的 ref 檔
      await expectEvent('delete the only nested branch (removes refs/heads/feat)', () =>
        git(dir, 'branch', '-q', '-D', 'feat/a'),
      );
      await expectEvent('re-create a nested branch (re-creates refs/heads/feat)', () =>
        git(dir, 'branch', 'feat/b'),
      );
      await expectEvent('move ONLY the ref file inside the re-created directory', () =>
        git(dir, 'update-ref', 'refs/heads/feat/b', git(dir, 'rev-parse', 'HEAD')),
      );
      await expectEvent('second change inside it', () => {
        commit(dir, 'two');
        git(dir, 'update-ref', 'refs/heads/feat/b', git(dir, 'rev-parse', 'HEAD'));
      });
      // pack-refs --prune 會刪掉所有鬆散 ref 與空目錄，之後的更新又會重建它們
      await expectEvent('git pack-refs --all --prune', () =>
        git(dir, 'pack-refs', '--all', '--prune'),
      );
      await expectEvent('ref update after pack-refs', () => git(dir, 'branch', 'feat/c'));
      await expectEvent('only the ref inside after pack-refs', () =>
        git(dir, 'update-ref', 'refs/heads/feat/c', git(dir, 'rev-parse', 'HEAD~1')),
      );
    } finally {
      stop();
    }
  });

  it('stops notifying after being closed', async () => {
    const dir = tmp('agg-watch-close-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    let calls = 0;
    const stop = watchGitRefs([join(dir, '.git')], () => calls++);
    stop();
    commit(dir, 'two');
    await sleep(400);
    expect(calls).toBe(0);
  });
});

describe('gitSnapshot plugin (dev server behaviour)', () => {
  interface Sent {
    type: string;
    event: string;
    data: { graph: { commits: unknown[] } | null };
  }

  async function startPlugin(repoDir: string, pollMs = 300) {
    const plugin = gitSnapshot({ repoDir, pollMs }) as unknown as {
      configResolved(c: unknown): void;
      configureServer(s: unknown): Promise<void>;
      load(id: string): Promise<string | undefined>;
    };
    const sent: Sent[] = [];
    let handler: ((req: unknown, res: unknown) => void) | undefined;
    let invalidated = 0;
    const server = {
      middlewares: { use: (_path: string, h: typeof handler) => (handler = h) },
      moduleGraph: { getModuleById: () => ({}), invalidateModule: () => invalidated++ },
      ws: { send: (m: Sent) => sent.push(m) },
      httpServer: null,
      close: async () => {},
    };
    const warnings: string[] = [];
    plugin.configResolved({ root: repoDir, logger: { warn: (m: string) => warnings.push(m) } });
    // gitSnapshot 在 vitest 下會刻意略過 configureServer；這裡要真的跑，所以暫時拿掉旗標
    const flag = process.env['VITEST'];
    delete process.env['VITEST'];
    try {
      await plugin.configureServer(server);
    } finally {
      process.env['VITEST'] = flag;
    }
    const request = (headers: Record<string, string> = {}, method = 'GET') =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const res = {
          statusCode: 200,
          setHeader() {},
          end(body = '') {
            resolve({ status: this.statusCode, body });
          },
        };
        handler!({ method, headers }, res);
      });
    return {
      plugin,
      sent,
      warnings,
      request,
      invalidated: () => invalidated,
      close: () => server.close(),
    };
  }

  it('pushes an HMR update for each consecutive commit — through the WATCHER alone (poll disabled)', async () => {
    const dir = tmp('agg-plugin-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    // pollMs: 0 → 安全網關掉。若監看失靈，這個測試必須失敗（否則輪詢會把問題蓋住）
    const p = await startPlugin(dir, 0);
    try {
      for (let i = 2; i <= 5; i++) {
        commit(dir, `c${i}`);
        await waitFor(() => p.sent.length >= i - 1, 8000);
        expect(p.sent.at(-1)!.data.graph!.commits).toHaveLength(i);
      }
      expect(p.invalidated()).toBeGreaterThanOrEqual(4); // 重新整理頁面時要拿到新的 module，而不是舊快取
    } finally {
      await p.close();
    }
  });

  it('the 2s-style poll catches changes the watcher could miss (watchers cannot be the only path)', async () => {
    const dir = tmp('agg-poll-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir, 200);
    try {
      commit(dir, 'two');
      await waitFor(() => p.sent.length >= 1, 8000);
      expect(p.sent.at(-1)!.data.graph!.commits).toHaveLength(2);
    } finally {
      await p.close();
    }
  });

  it('serves the snapshot only to same-origin / direct requests', async () => {
    const dir = tmp('agg-endpoint-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir);
    try {
      const ok = await p.request({ 'sec-fetch-site': 'same-origin' });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).graph.commits).toHaveLength(1);
      expect((await p.request({})).status).toBe(200); // 沒有 fetch metadata（curl 等）
      expect((await p.request({ 'sec-fetch-site': 'none' })).status).toBe(200);
      expect((await p.request({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await p.request({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await p.request({}, 'POST')).status).toBe(405);
    } finally {
      await p.close();
    }
  });

  it('keeps the last good snapshot (and warns once) when git fails transiently', async () => {
    const dir = tmp('agg-keep-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir, 0);
    try {
      expect(JSON.parse((await p.request({})).body).graph.commits).toHaveLength(1);
      writeFileSync(join(dir, '.git/refs/heads/bad'), `${'1'.repeat(40)}\n`); // git 以 128 結束
      const during = JSON.parse((await p.request({})).body);
      expect(during.graph.commits).toHaveLength(1);
      expect(during.error).toBeUndefined();
      expect(p.warnings.filter((w) => /keeping the last good snapshot/.test(w))).toHaveLength(1);
      await p.request({});
      expect(p.warnings.filter((w) => /keeping the last good snapshot/.test(w))).toHaveLength(1);
      rmSync(join(dir, '.git/refs/heads/bad')); // 恢復後立刻回到正常
      expect(JSON.parse((await p.request({})).body).graph.commits).toHaveLength(1);
    } finally {
      await p.close();
    }
  });

  it('does NOT mask a permanent failure (repository gone) behind the stale snapshot', async () => {
    const dir = tmp('agg-gone-');
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'one');
    const p = await startPlugin(dir, 0);
    try {
      expect(JSON.parse((await p.request({})).body).graph.commits).toHaveLength(1);
      rmSync(join(dir, '.git'), { recursive: true, force: true });
      const body = JSON.parse((await p.request({})).body);
      expect(body.graph).toBeNull();
      expect(body.error).toMatch(/not inside a git repository/);
      expect(body.error).not.toContain(tmpdir());
      await waitFor(() => p.sent.some((m) => m.data.graph === null), 4000); // 也會推送給畫面
    } finally {
      await p.close();
    }
  });
});
