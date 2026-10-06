// End-to-end：啟動真正的 dev server（pnpm start 同一份設定），用 Chromium 驗證：
//   本機 git 快照 → 即時更新（不重新整理）→ GitHub 來源切換 / 輸入驗證 / token → 主題 → 本機 build + preview。
// 資料全部是 e2e 自己建立的暫時 git repo 與 mock GitHub API，不依賴網路。
//   用法：pnpm e2e        （環境變數 CHROME_PATH 可指定 Chrome）
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';
import { SPECS, seen, startMock } from '../../../tools/e2e/mock-github-api.mjs';
import { inkRatio } from '../../../tools/e2e/pixels.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'e2e/.artifacts');
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');

// ───────────────────────── 暫時 git repo ─────────────────────────

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Amy',
  GIT_AUTHOR_EMAIL: 'amy@example.test',
  GIT_COMMITTER_NAME: 'Amy',
  GIT_COMMITTER_EMAIL: 'amy@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
let tick = 0;
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const commit = (cwd, msg) => {
  const date = new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  execFileSync('git', ['commit', '--allow-empty', '-m', msg], {
    cwd,
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};

function makeRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/octo/cat.git');
  commit(dir, 'chore: root');
  commit(dir, 'feat: two');
  git(dir, 'tag', 'v1');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  commit(dir, 'feat: side one');
  commit(dir, 'fix: side two');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'docs: main three');
  const date = new Date(Date.UTC(2026, 0, 1, 0, 5, 0)).toISOString();
  execFileSync('git', ['merge', '--no-ff', 'feat/x', '-m', "Merge branch 'feat/x'"], {
    cwd: dir,
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return dir; // 6 commits, 2 branches, 1 tag
}

// ───────────────────────── helpers ─────────────────────────

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

function startVite(args, env) {
  const proc = spawn(process.execPath, [viteBin, ...args], {
    cwd: root,
    // Nx 會設 FORCE_COLOR：關掉，避免 URL 裡夾 ANSI 跳脫碼
    env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const ready = new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`vite did not start:\n${log}`)), 60_000);
    const poll = setInterval(() => {
      if (/localhost:\d+/.test(log.replace(/\x1b\[[0-9;]*m/g, ''))) {
        clearTimeout(t);
        clearInterval(poll);
        ok();
      }
    }, 100);
    proc.once('exit', (code) => fail(new Error(`vite exited (${code}):\n${log}`)));
  });
  return { proc, ready, log: () => log };
}

const waitUntil = async (cond, timeout = 20_000) => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > timeout) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

const results = [];
const errors = [];
const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  results.push(name);
  console.log(`✔ ${name} (${Date.now() - t}ms)`);
};

// ───────────────────────── main ─────────────────────────

rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });

const repoDir = makeRepo();
const mock = await startMock();
const apiBase = `http://127.0.0.1:${mock.address().port}`;
const port = await freePort();
const env = { AGG_REPO_DIR: repoDir, VITE_GITHUB_API_BASE: apiBase };

const dev = startVite(['--port', String(port), '--strictPort'], env);
let preview;
const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

try {
  await dev.ready;
  const base = `http://localhost:${port}`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('https://github.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<title>fake github</title>' }),
  );
  const decoder = await ctx.newPage();
  await decoder.goto('about:blank');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // 404 / 403 的 mock 回應會被 Chrome 記成 console.error，這是預期的
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console.error: ${m.text()}`);
  });

  const chips = async () => (await page.locator('.agg-chip').allInnerTexts()).join(' | ');
  const replayDone = () =>
    page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });

  await step(
    'local snapshot: title, counts, branches, drawn pixels (no GitHub, no network)',
    async () => {
      await page.goto(base);
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      assert.match(await chips(), /^6 commits? \| 2 branch|^6 個 commit \| 2 條分支/);
      assert.match(await page.title(), /octo\/cat/);
      assert.equal(await page.locator('.agg-branch').count(), 2);
      await replayDone();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(artifacts, '1-local.png') });
      const box = await page.locator('.agg-canvas').boundingBox();
      const png = await page.screenshot({
        clip: { x: box.x, y: box.y + 130, width: box.width, height: box.height - 230 },
      });
      const ratio = await inkRatio(decoder, png);
      console.log('  ink pixel ratio:', ratio.toFixed(4));
      assert.ok(ratio > 0.003, `graph area looks empty (${ratio})`);
      assert.deepEqual(seen.paths, [], 'local mode must not touch the GitHub API');
    },
  );

  await step('legend focuses a branch, hover shows the commit tooltip', async () => {
    await page.locator('.agg-branch', { hasText: 'feat/x' }).click();
    await page.waitForTimeout(1700);
    const box = await page.locator('.agg-canvas').boundingBox();
    await page.mouse.move(box.x + 60, box.y + 260);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await page.locator('.agg-tip').waitFor({ timeout: 5000 });
    assert.match(await page.locator('.agg-tip').innerText(), /fix: side two/);
    await page.screenshot({ path: resolve(artifacts, '2-hover.png') });
  });

  await step(
    'clicking a node opens the GitHub commit page of the remote (url derived from origin)',
    async () => {
      const box = await page.locator('.agg-canvas').boundingBox();
      const [popup] = await Promise.all([
        ctx.waitForEvent('page'),
        page.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
      ]);
      assert.match(popup.url(), /^https:\/\/github\.com\/octo\/cat\/commit\/[0-9a-f]{40}$/);
      await popup.close();
    },
  );

  await step('LIVE: a new git commit appears without reloading the page', async () => {
    await page.evaluate(() => (window.__alive = 'yes'));
    commit(repoDir, 'live: brand new commit');
    await waitUntil(async () => /^7 /.test(await chips()), 20_000);
    assert.equal(await page.evaluate(() => window.__alive), 'yes', 'page must not have reloaded');
    await replayDone();
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(artifacts, '3-live-update.png') });
  });

  await step('LIVE: creating a branch and checking out is reflected too', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'wip/new-idea');
    commit(repoDir, 'feat: idea');
    await waitUntil(async () => /^8 /.test(await chips()) && /3 /.test(await chips()), 20_000);
    assert.equal(await page.locator('.agg-branch', { hasText: 'wip/new-idea' }).count(), 1);
    git(repoDir, 'checkout', '-q', 'main');
  });

  await step('refresh button re-reads the local repository', async () => {
    await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click();
    await page.waitForTimeout(800);
    assert.match(await chips(), /^8 /);
  });

  await step(
    'source switch: GitHub 404 is friendly; invalid input is rejected client-side',
    async () => {
      await page.getByRole('button', { name: /GitHub$/ }).click();
      const input = page.locator('.web-input');
      await input.fill('evil.example/octo/cat');
      await input.press('Enter');
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(new URL(page.url()).search, '', 'invalid input must not navigate');
      assert.deepEqual(seen.paths, [], 'invalid input must not hit the API');

      await input.fill('ghost/missing');
      await input.press('Enter');
      await page.locator('.agg-center[role="alert"]').waitFor();
      assert.equal(new URL(page.url()).search, '?repo=ghost/missing');
      await page.waitForTimeout(700);
      await page.screenshot({ path: resolve(artifacts, '4-github-404.png') });

      // 403 + x-ratelimit-remaining: 0 → 必須被辨識為 rate limit（需要 CORS 有 expose 這些標頭）
      await input.fill('limited/repo');
      await input.press('Enter');
      await page.locator('.agg-center[role="alert"]').getByText(/60/).waitFor();
      assert.match(await page.locator('.agg-center').innerText(), /分鐘|min/);
    },
  );

  await step(
    'source switch: any GitHub repo renders through the same viewer (mock API)',
    async () => {
      const input = page.locator('.web-input');
      await input.fill('https://github.com/demo/adorable-git-graph/tree/main');
      await input.press('Enter');
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor();
      assert.match(await chips(), new RegExp(`^${SPECS.length} `));
      await replayDone();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(artifacts, '5-github.png') });
    },
  );

  await step(
    'token dialog: stored locally, sent only as a Bearer header, never in URL or DOM',
    async () => {
      seen.auth.length = 0;
      await page.getByRole('button', { name: /^(設定|Settings)$/ }).click();
      await page.locator('.web-dialog').waitFor();
      await page.screenshot({ path: resolve(artifacts, '6-token-dialog.png') });
      await page.locator('.web-dialog input[type="password"]').fill('github_pat_web_secret');
      await page.getByRole('button', { name: /^(儲存|Save)$/ }).click();
      await page.locator('.web-dialog').waitFor({ state: 'detached' });
      await waitUntil(() => seen.auth.length > 0);
      assert.ok(seen.auth.every((a) => a === 'Bearer github_pat_web_secret'));
      assert.ok(!page.url().includes('github_pat'), 'token must never appear in the URL');
      assert.ok(
        !(await page.content()).includes('github_pat_web_secret'),
        'token must not be rendered into the DOM',
      );
      assert.ok(seen.paths.every((p) => !p.includes('github_pat')));
      // 清除
      await page.getByRole('button', { name: /^(設定|Settings)$/ }).click();
      await page.getByRole('button', { name: /^(清除|Clear)$/ }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('agg.github-token')), null);
      assert.equal(
        await page.evaluate(
          () => Object.keys(sessionStorage).filter((k) => k.startsWith('agg:gh:')).length,
        ),
        0,
        'clearing the token must purge cached GitHub data',
      );
    },
  );

  await step(
    'browser back/forward follow the source; Local button returns to the git snapshot',
    async () => {
      await page.goBack(); // ghost/missing
      await page.locator('.agg-center[role="alert"]').waitFor();
      await page.getByRole('button', { name: /Local$|本機$/ }).click();
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor();
      assert.equal(new URL(page.url()).search, '');
      assert.match(await chips(), /^8 /);
    },
  );

  await step('theme toggle cycles auto → day → night and persists across reloads', async () => {
    const toggle = page.locator('.web-icon');
    await toggle.click(); // day
    await page.locator('.agg-root[data-theme="day"]').waitFor();
    await toggle.click(); // night
    await page.locator('.agg-root[data-theme="night"]').waitFor();
    await page.reload();
    await page.locator('.agg-root[data-theme="night"]').waitFor();
    await replayDone();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(artifacts, '7-night.png') });
  });

  await step(
    'production build bakes the snapshot in and does not expose the dev endpoint',
    async () => {
      const outDir = resolve(artifacts, 'dist');
      execFileSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: 'pipe',
      });
      const pPort = await freePort();
      preview = startVite(
        [
          'preview',
          '--host',
          'localhost',
          '--port',
          String(pPort),
          '--strictPort',
          '--outDir',
          outDir,
        ],
        env,
      );
      await preview.ready;
      const p2 = await ctx.newPage();
      await p2.goto(`http://localhost:${pPort}/`);
      await p2.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await p2.locator('.agg-chip', { hasText: /^8 / }).first().waitFor();
      const res = await p2.request.get(`http://localhost:${pPort}/__agg/git-snapshot`);
      assert.ok(
        !(res.headers()['content-type'] ?? '').includes('json'),
        'dev endpoint must not exist in a build',
      );
      await p2.close();
    },
  );

  assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join('\n')}`);
  console.log(`\nAll ${results.length} web e2e steps passed. Screenshots → ${artifacts}`);
} catch (err) {
  console.error('\n✘ web e2e failed:', err);
  if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  console.error('\n--- vite log ---\n' + dev.log().slice(-1500));
  process.exitCode = 1;
} finally {
  await browser.close();
  dev.proc.kill();
  preview?.proc.kill();
  mock.close();
  rmSync(repoDir, { recursive: true, force: true });
}
