// End-to-end：啟動真正的 dev server（pnpm start 同一份設定），用 Chromium 驗證：
//   本機 git 快照 → 即時更新（連續多次、不重新整理、保留鏡頭）→ GitHub 來源切換 / 輸入驗證 / token / 快取
//   → 安全性（cross-origin 讀不到 dev endpoint）→ 主題 → 本機 build + preview。
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

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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
    // 所有結束路徑都要清掉計時器，否則失敗後行程會一直掛著
    let timeout;
    let poll;
    const done = (fn) => (arg) => {
      clearTimeout(timeout);
      clearInterval(poll);
      fn(arg);
    };
    timeout = setTimeout(done(fail), 60_000, new Error(`vite did not start:\n${log}`));
    poll = setInterval(() => {
      if (/localhost:\d+/.test(stripAnsi(log))) done(ok)();
    }, 100);
    proc.once('exit', (code) => done(fail)(new Error(`vite exited (${code}):\n${log}`)));
  });
  return { proc, ready, log: () => log };
}

// mock 也會服務頭像 SVG；「有沒有打 GitHub API」只算 /repos 與 /rate_limit
const apiCalls = () =>
  seen.paths.filter((p) => p.startsWith('/repos') || p.startsWith('/rate_limit'));

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

let dev;
let preview;
let browser;

try {
  dev = startVite(['--port', String(port), '--strictPort'], env);
  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
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
    // 404 / 403 的 mock 回應與被 CORS 擋下的請求，Chrome 會記成 console.error：這是預期的
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`console.error: ${m.text()}`);
  });

  const chips = async () => (await page.locator('.agg-chip').allInnerTexts()).join(' | ');
  const commitCount = async () => Number(/^(\d+)/.exec(await chips())?.[1] ?? NaN);
  const replayDone = () =>
    page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });
  const graphInk = async () => {
    const box = await page.locator('.agg-canvas').boundingBox();
    const png = await page.screenshot({
      clip: { x: box.x, y: box.y + 130, width: box.width, height: box.height - 230 },
    });
    return inkRatio(decoder, png);
  };
  const waitForCommits = (n) => waitUntil(async () => (await commitCount()) === n, 25_000);
  let expected = 6;

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
      const ratio = await graphInk();
      console.log('  ink pixel ratio:', ratio.toFixed(4));
      assert.ok(ratio > 0.003, `graph area looks empty (${ratio})`);
      assert.deepEqual(apiCalls(), [], 'local mode must not touch the GitHub API');
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
    // 提示只含第一行：commit 本文與 email 不會出現在畫面上
    assert.doesNotMatch(await page.locator('.agg-tip').innerText(), /@/);
    await page.screenshot({ path: resolve(artifacts, '2-hover.png') });
    await page.getByRole('button', { name: /^(全景|Fit)$/ }).click();
    await page.waitForTimeout(1500);
  });

  await step(
    'clicking a node opens the GitHub commit page of the remote (url derived from origin)',
    async () => {
      const box = await page.locator('.agg-canvas').boundingBox();
      await page.locator('.agg-branch', { hasText: 'feat/x' }).click();
      await page.waitForTimeout(1700);
      const [popup] = await Promise.all([
        ctx.waitForEvent('page'),
        page.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
      ]);
      assert.match(popup.url(), /^https:\/\/github\.com\/octo\/cat\/commit\/[0-9a-f]{40}$/);
      await popup.close();
      await page.getByRole('button', { name: /^(全景|Fit)$/ }).click();
      await page.waitForTimeout(1500);
    },
  );

  await step(
    'LIVE: EVERY consecutive commit shows up without reloading (not just the first)',
    async () => {
      await page.evaluate(() => (window.__alive = 'yes'));
      for (const msg of ['live: first', 'live: second', 'live: third', 'live: fourth']) {
        commit(repoDir, msg);
        expected++;
        await waitForCommits(expected);
        assert.equal(
          await page.evaluate(() => window.__alive),
          'yes',
          'page must not have reloaded',
        );
      }
      await replayDone();
      await page.waitForTimeout(800);
      await page.screenshot({ path: resolve(artifacts, '3-live-update.png') });
    },
  );

  await step('LIVE: new branch, commit on it, switch back and forth — all reflected', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'wip/new-idea');
    commit(repoDir, 'feat: idea');
    expected++;
    await waitForCommits(expected);
    assert.equal(await page.locator('.agg-branch', { hasText: 'wip/new-idea' }).count(), 1);
    git(repoDir, 'checkout', '-q', 'main');
    commit(repoDir, 'docs: back on main'); // 切回 main 之後的 commit 也要收得到
    expected++;
    await waitForCommits(expected);
    git(repoDir, 'checkout', '-q', 'wip/new-idea');
    commit(repoDir, 'feat: idea two');
    expected++;
    await waitForCommits(expected);
    git(repoDir, 'checkout', '-q', 'main');
  });

  await step(
    'LIVE: an update keeps the user’s camera and only animates the new commit',
    async () => {
      await page.getByRole('button', { name: /^(全景|Fit)$/ }).click();
      await page.waitForTimeout(1500);
      const fit = await graphInk();
      // 在左側放大並停在那裡（遠離最新的 commit，所以鏡頭不會被帶去 HEAD）
      const box = await page.locator('.agg-canvas').boundingBox();
      await page.mouse.move(box.x + 160, box.y + box.height / 2);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(120);
      }
      await page.mouse.move(box.x + box.width - 60, box.y + 140);
      await page.waitForTimeout(900);
      const before = await graphInk();
      console.log(`  ink ratio fit=${fit.toFixed(4)} zoomed=${before.toFixed(4)}`);
      assert.ok(before > fit * 1.4, 'the zoom step should visibly change the picture');

      commit(repoDir, 'live: while zoomed');
      expected++;
      await waitForCommits(expected);
      await replayDone();
      await page.waitForTimeout(1200);
      const after = await graphInk();
      console.log(`  ink ratio after the update=${after.toFixed(4)}`);
      assert.ok(
        Math.abs(after - before) / before < 0.4,
        `camera was reset by a live update (${before} → ${after})`,
      );
      await page.screenshot({ path: resolve(artifacts, '3b-camera-kept.png') });
      await page.getByRole('button', { name: /^(全景|Fit)$/ }).click();
      await page.waitForTimeout(1200);
    },
  );

  await step('refresh button re-reads the local repository through the dev endpoint', async () => {
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/__agg/git-snapshot')),
      page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click(),
    ]);
    assert.equal(req.method(), 'GET');
    await page.waitForTimeout(500);
    assert.equal(await commitCount(), expected);
  });

  await step(
    'token dialog keeps keyboard focus while the app re-renders underneath (live update)',
    async () => {
      await page.getByRole('button', { name: /^(設定|Settings)$/ }).click();
      await page.locator('.web-dialog').waitFor();
      const cancel = page.getByRole('button', { name: /^(取消|Cancel)$/ });
      await cancel.focus();
      // 背景來一筆新 commit → App 重新 render。若 effect 依賴 onClose 的身分，焦點會被搶回密碼欄
      commit(repoDir, 'live: while the dialog is open');
      expected++;
      await waitForCommits(expected);
      await page.waitForTimeout(300);
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
        (await cancel.innerText()).trim(),
      );
      await page.keyboard.press('Escape');
      await page.locator('.web-dialog').waitFor({ state: 'detached' });
    },
  );

  await step('SECURITY: other origins cannot read the dev snapshot endpoint', async () => {
    const other = await ctx.newPage();
    await other.goto(`${apiBase}/avatar/x.svg`); // 不同 origin（127.0.0.1:<另一個埠>）
    const outcome = await other.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        return `readable:${res.status}`;
      } catch {
        return 'blocked';
      }
    }, `${base}/__agg/git-snapshot`);
    assert.equal(
      outcome,
      'blocked',
      'cross-origin pages must not be able to read local commit data',
    );
    await other.close();
    // 同源（頁面自己）仍然可以
    const same = await page.evaluate(async () => (await fetch('/__agg/git-snapshot')).status);
    assert.equal(same, 200);
  });

  await step(
    'source switch: GitHub 404 / rate limit are friendly; invalid input is rejected client-side',
    async () => {
      await page.getByRole('button', { name: /GitHub$/ }).click();
      const input = page.locator('.web-input');
      await input.fill('evil.example/octo/cat');
      await input.press('Enter');
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(new URL(page.url()).search, '', 'invalid input must not navigate');
      assert.deepEqual(apiCalls(), [], 'invalid input must not hit the API');

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

      // 相同網址再送一次不應多疊一筆歷史
      const before = await page.evaluate(() => history.length);
      await input.press('Enter');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => history.length), before);
    },
  );

  await step(
    'LIVE: a commit made while viewing GitHub is there when you come back to Local',
    async () => {
      commit(repoDir, 'live: made while on GitHub');
      expected++;
      // 沒有在看本機圖的期間，推送也必須被收下
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: /Local$|本機$/ }).click();
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await waitForCommits(expected);
      await page.getByRole('button', { name: /GitHub$/ }).click();
    },
  );

  await step(
    'source switch: any GitHub repo renders through the same viewer; deep link + cache',
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

      // deep link 重新整理：第二次要走 sessionStorage 快取，不再打 API
      const requests = apiCalls().length;
      await page.goto(`${base}/?repo=demo/adorable-git-graph`);
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor();
      await page.waitForTimeout(500);
      assert.equal(apiCalls().length, requests, 'the second load must be served from the cache');
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
      await page.locator('.agg-canvas canvas').waitFor();

      // 帶 token 抓到的快取，token 移除後不可再被拿來顯示
      const cacheEntries = () =>
        page.evaluate(() =>
          Object.keys(sessionStorage)
            .filter((k) => k.startsWith('agg:gh:'))
            .map((k) => JSON.parse(sessionStorage.getItem(k)).authed),
        );
      await waitUntil(async () => (await cacheEntries()).includes(true));
      // 另一個 repo 的「帶 token」快取（mock 只提供一個 repo，所以直接塞進去）：移除 token 後必須一併消失
      await page.evaluate(() =>
        sessionStorage.setItem(
          'agg:gh:private/secret-repo',
          JSON.stringify({
            savedAt: Date.now(),
            graph: { repo: {}, commits: [], refs: [] },
            authed: true,
          }),
        ),
      );
      await page.getByRole('button', { name: /^(設定|Settings)$/ }).click();
      await page.getByRole('button', { name: /^(清除|Clear)$/ }).click();
      assert.equal(
        await page.evaluate(() => sessionStorage.getItem('agg:gh:private/secret-repo')),
        null,
        'clearing the token must purge every cached GitHub graph',
      );
      assert.equal(await page.evaluate(() => localStorage.getItem('agg.github-token')), null);
      await page.locator('.agg-canvas canvas').waitFor();
      await page.waitForTimeout(500);
      assert.ok(
        !(await cacheEntries()).includes(true),
        'authenticated cache entries must not survive clearing the token',
      );
    },
  );

  await step(
    'browser back/forward drive the viewer (not just the URL); Local button returns to the git snapshot',
    async () => {
      const pressed = () =>
        page.locator('.web-seg button[aria-pressed="true"]').first().innerText();
      await page.getByRole('button', { name: /Local$|本機$/ }).click(); // push "/"
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await waitForCommits(expected);
      await page.getByRole('button', { name: /GitHub$/ }).click();
      const input = page.locator('.web-input');
      await input.fill('demo/adorable-git-graph');
      await input.press('Enter'); // push "?repo=demo/adorable-git-graph"
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();

      await page.goBack(); // → Local：畫面本身也必須跟著回去
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      assert.equal(new URL(page.url()).search, '');
      assert.match(await pressed(), /Local|本機/);
      await waitForCommits(expected);

      await page.goForward(); // → GitHub
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();
      assert.equal(new URL(page.url()).search, '?repo=demo/adorable-git-graph');
      assert.match(await pressed(), /GitHub/);

      await page.getByRole('button', { name: /Local$|本機$/ }).click();
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor();
      assert.equal(new URL(page.url()).search, '');
      await waitForCommits(expected);
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
    'production build bakes the snapshot in, hides Refresh, and has no dev endpoint',
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
      await p2
        .locator('.agg-chip', { hasText: new RegExp(`^${expected} `) })
        .first()
        .waitFor();
      assert.equal(
        await p2.getByRole('button', { name: /^(重新整理|Refresh)$/ }).count(),
        0,
        'a static build cannot re-read git',
      );
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
  if (dev) console.error('\n--- vite log ---\n' + dev.log().slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close();
  dev?.proc.kill();
  preview?.proc.kill();
  mock.close();
  rmSync(repoDir, { recursive: true, force: true });
}
