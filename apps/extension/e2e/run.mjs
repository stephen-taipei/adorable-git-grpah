// End-to-end：以真實 Chromium 載入「已打包的 extension」，
// 用 mock GitHub API + 假的 github.com 頁面驗證整條流程，並輸出截圖到 e2e/.artifacts。
// 用法：pnpm e2e        （環境變數 CHROME_PATH 可指定 Chrome）
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';
import { SPECS, seen, startMock } from '../../../tools/e2e/mock-github-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'e2e/.artifacts');
const extDir = resolve(artifacts, 'extension');
const profileDir = resolve(artifacts, 'profile');

// ───────────────────────── helpers ─────────────────────────

function run(cmd, args, env) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
    p.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
  });
}

const fakeGithubPage = (title) => `<!doctype html>
<html lang="en" data-color-mode="light" data-light-theme="light" data-dark-theme="dark">
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;font:14px -apple-system,Segoe UI,sans-serif;color:#1f2328;background:#fff}
  header{height:64px;background:#f6f8fa;border-bottom:1px solid #d0d7de;display:flex;align-items:center;padding:0 24px;font-weight:600}
  main{max-width:1000px;margin:24px auto;padding:0 24px}
  .row{height:36px;border-bottom:1px solid #d8dee4;display:flex;align-items:center;gap:12px}
</style></head>
<body><header>${title}</header>
<main><h1>${title}</h1>${'<div class="row">📄 some-file.ts <span style="color:#656d76">fix: something</span></div>'.repeat(12)}</main></body></html>`;

const errors = [];
const results = [];
const waitUntil = async (cond, timeout = 15_000) => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > timeout) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};
const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  results.push(`✔ ${name} (${Date.now() - t}ms)`);
  console.log(results.at(-1));
};

// ───────────────────────── main ─────────────────────────

await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const mock = await startMock();
const apiBase = `http://127.0.0.1:${mock.address().port}`;

await run('node', ['scripts/build.mjs'], {
  AGG_API_BASE: apiBase,
  AGG_OUT_DIR: extDir,
  AGG_DEV: '1',
});

const ctx = await chromium.launchPersistentContext(profileDir, {
  executablePath: findChrome(),
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    '--headless=new',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

await ctx.route('https://github.com/**', (route) => {
  const u = new URL(route.request().url());
  route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: fakeGithubPage(u.pathname.slice(1) || 'github'),
  });
});
await ctx.route('https://avatars.githubusercontent.com/**', (route) => route.abort());

const watchErrors = (page, label) => {
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] console.error: ${m.text()}`);
  });
};

try {
  let sw = ctx.serviceWorkers()[0];
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  const REPO_URL = 'https://github.com/demo/adorable-git-graph';
  const decoder = await ctx.newPage();
  await decoder.goto('about:blank');
  const page = await ctx.newPage();
  watchErrors(page, 'page');

  await step('FAB appears on a repo page and not on a profile page', async () => {
    await page.goto(`https://github.com/demo`);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.agg-fab').count(), 0, 'FAB must not render on user page');
    await page.goto(REPO_URL);
    await page.locator('.agg-fab').waitFor({ timeout: 10_000 });
  });

  await step('opens overlay and draws the graph (zh/en agnostic)', async () => {
    await page.locator('.agg-fab').click();
    await page.locator('.agg-panel').waitFor();
    await page.locator('.agg-canvas canvas').waitFor();
    assert.equal(await page.locator('.agg-title-text').innerText(), 'demo/adorable-git-graph');
    const chips = await page.locator('.agg-chip').allInnerTexts();
    assert.match(chips[0], new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(artifacts, '1-replay-start.png') });
    const t = Date.now();
    for (const [i, ms] of [3000, 4000, 4000].entries()) {
      await page.waitForTimeout(ms);
      await page.screenshot({ path: resolve(artifacts, `1-replay-${i + 1}.png`) });
    }
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });
    console.log(`  replay finished after ${Date.now() - t}ms (software GL)`);
    await page.waitForTimeout(1500); // 讓鏡頭停穩
    await page.screenshot({ path: resolve(artifacts, '2-overview.png') });
  });

  await step(
    'canvas actually painted cartoon outlines (ink pixels in the graph area)',
    async () => {
      const box = await page.locator('.agg-canvas').boundingBox();
      const png = await page.screenshot({
        clip: { x: box.x, y: box.y + 120, width: box.width, height: box.height - 220 },
      });
      const ratio = await decoder.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const { data } = g.getImageData(0, 0, c.width, c.height);
        let ink = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i] < 90 && data[i + 1] < 80 && data[i + 2] < 110) ink++;
        return ink / (c.width * c.height);
      }, png.toString('base64'));
      console.log('  ink pixel ratio:', ratio.toFixed(4));
      assert.ok(ratio > 0.003, `graph area looks empty (ink ratio ${ratio})`);
    },
  );

  await step('legend focuses a branch; hovering the node shows the tooltip', async () => {
    const chip = page.locator('.agg-branch', { hasText: 'feat/dark-mode' });
    await chip.waitFor();
    await chip.click();
    await page.waitForTimeout(1600);
    const box = await page.locator('.agg-canvas').boundingBox();
    // 先隨便移動一下，再移到畫面中心（flyTo 後 node 會在中心）
    await page.mouse.move(box.x + 40, box.y + 200);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await page.locator('.agg-tip').waitFor({ timeout: 4000 });
    const tip = await page.locator('.agg-tip').innerText();
    assert.match(tip, /feat: twinkling stars/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(artifacts, '3-hover.png') });
  });

  await step('clicking a node opens the commit page in a new tab', async () => {
    const box = await page.locator('.agg-canvas').boundingBox();
    const [popup] = await Promise.all([
      ctx.waitForEvent('page'),
      page.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
    ]);
    assert.match(popup.url(), /github\.com\/demo\/adorable-git-graph\/commit\/[0-9a-f]{40}/);
    await popup.close();
  });

  await step('mouse wheel zooms and drag pans without throwing', async () => {
    const box = await page.locator('.agg-canvas').boundingBox();
    await page.mouse.move(box.x + 400, box.y + 400);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.mouse.move(box.x + 700, box.y + 450, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(artifacts, '4-zoom-pan.png') });
    await page.getByRole('button', { name: /^(全景|Fit)$/ }).click();
    await page.waitForTimeout(1200);
  });

  await step('Escape closes the overlay', async () => {
    await page.keyboard.press('Escape');
    await page.locator('.agg-panel').waitFor({ state: 'detached' });
    await page.locator('.agg-fab').waitFor();
  });

  await step('second open is served from cache; refresh button forces a re-fetch', async () => {
    const before = seen.paths.length;
    await page.locator('.agg-fab').click();
    await page.locator('.agg-canvas canvas').waitFor();
    await page.waitForTimeout(500);
    assert.equal(seen.paths.length, before, 'expected a cache hit (no new API requests)');
    await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click();
    await waitUntil(() => seen.paths.length > before);
    await page.locator('.agg-canvas canvas').waitFor();
    await page.keyboard.press('Escape');
  });

  await step('night theme follows GitHub color mode', async () => {
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'dark'));
    await page.locator('.agg-fab').click();
    await page.locator('.agg-root[data-theme="night"]').waitFor();
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: resolve(artifacts, '5-night.png') });
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'light'));
  });

  await step('SPA navigation: error states (404 / rate limit) are friendly', async () => {
    await page.evaluate(() => history.pushState({}, '', '/ghost/missing'));
    await page.waitForTimeout(2000); // repoStore polling
    await page.locator('.agg-fab').click();
    await page.locator('.agg-center[role="alert"]').waitFor();
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(artifacts, '6-error-404.png') });
    await page.keyboard.press('Escape');

    await page.evaluate(() => history.pushState({}, '', '/limited/repo'));
    await page.waitForTimeout(2000);
    await page.locator('.agg-fab').click();
    await page.locator('.agg-center[role="alert"]').waitFor();
    const text = await page.locator('.agg-center').innerText();
    assert.match(text, /60/);
    await page.keyboard.press('Escape');
  });

  await step('content script toggles on the toolbar-icon message', async () => {
    await page.evaluate((u) => history.pushState({}, '', new URL(u).pathname), REPO_URL);
    await page.waitForTimeout(2000);
    await page.bringToFront();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    });
    await page.locator('.agg-panel').waitFor();
    await page.keyboard.press('Escape');
  });

  await step(
    'options page saves a token; background sends it only as a Bearer header to the API',
    async () => {
      const opt = await ctx.newPage();
      watchErrors(opt, 'options');
      await opt.goto(`chrome-extension://${extId}/options.html`);
      await opt.locator('input[type="password"]').fill('github_pat_e2e_secret');
      await opt.getByRole('button', { name: /^(儲存|Save)$/ }).click();
      await opt.locator('output', { hasText: /✓/ }).waitFor();
      await opt.screenshot({ path: resolve(artifacts, '7-options.png') });
      await opt.getByRole('button', { name: /(測試|Test)/ }).click();
      await opt.locator('output', { hasText: /42/ }).waitFor();
      await opt.close();

      seen.auth.length = 0;
      await page.evaluate((u) => history.pushState({}, '', new URL(u).pathname), REPO_URL);
      await page.waitForTimeout(2000);
      await page.locator('.agg-fab').click();
      await page.locator('.agg-canvas canvas').waitFor();
      assert.ok(seen.auth.length > 0, 'expected authorised requests');
      assert.ok(seen.auth.every((a) => a === 'Bearer github_pat_e2e_secret'));
      const html = await page.content();
      assert.ok(!html.includes('github_pat_e2e_secret'), 'token must never reach the page DOM');
      assert.ok(
        seen.paths.every((p) => !p.includes('github_pat')),
        'token must never appear in a URL',
      );
    },
  );

  assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join('\n')}`);
  console.log(`\nAll ${results.length} e2e steps passed. Screenshots → ${artifacts}`);
} catch (err) {
  console.error('\n✘ e2e failed:', err);
  if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await ctx.close();
  mock.close();
}
