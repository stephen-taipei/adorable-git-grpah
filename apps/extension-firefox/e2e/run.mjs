// End-to-end：用「真正的 Firefox」載入打包後的 MV3 extension，對 mock GitHub API + 本機假的 github 頁面驗證整條流程，
// 並把截圖輸出到 e2e/.artifacts。
//   用法：pnpm e2e     環境變數：FIREFOX_PATH 指定 Firefox；沒有找到 Firefox 時，一般情況只提示並略過，
//                       設了 CI 或 REQUIRE_FIREFOX 則視為失敗。WebGL 需要 Xvfb（或自行用 xvfb-run 包起來）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GECKO_ID } from '@adorable/extension-core/manifest';
import { startFakeGithub } from '../../../tools/e2e/fake-github-page.mjs';
import { SPECS, seen, startMock } from '../../../tools/e2e/mock-github-api.mjs';
import { inkRatio } from '../../../tools/e2e/pixels.mjs';
import {
  backgroundHandle,
  chromeEval,
  clickExtByText,
  clickToolbarButton,
  fillExt,
  findFirefox,
  launchFirefox,
  newTabFrom,
  openExtensionPage,
  startXvfb,
  waitForTabUrl,
} from './firefox.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'e2e/.artifacts');
const extDir = resolve(artifacts, 'extension');
/** 固定 extension 的內部 uuid（透過 pref），才能直接開 moz-extension://<uuid>/options.html */
const EXT_UUID = '8d6f1c2e-4b7a-4c1e-9a3d-2f5e7b9c0a11';

const firefox = findFirefox();
if (!firefox) {
  const msg = '找不到 Firefox（可用 FIREFOX_PATH 指定）。';
  if (process.env['CI'] || process.env['REQUIRE_FIREFOX']) {
    console.error(`✘ ${msg}`);
    process.exit(1);
  }
  console.warn(`⚠ 略過 Firefox e2e：${msg}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond, timeout = 20_000) => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > timeout) throw new Error('waitUntil timed out');
    await sleep(100);
  }
};
// mock 也會服務頭像 SVG；「有沒有打 GitHub API」只算 /repos 與 /rate_limit
const apiCalls = () =>
  seen.paths.filter((p) => p.startsWith('/repos') || p.startsWith('/rate_limit')).length;
const results = [];
const errors = [];
const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  results.push(name);
  console.log(`✔ ${name} (${Date.now() - t}ms)`);
};
const run = (cmd, args, env) =>
  new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
    p.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
  });

// ───────────────────────── 準備：mock API、假的 github 頁面、建置 ─────────────────────────

rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });

const api = await startMock();
const apiBase = `http://127.0.0.1:${api.address().port}`;
const fake = await startFakeGithub();
const GH = `http://127.0.0.1:${fake.address().port}`;
const REPO = '/demo/adorable-git-graph';
const REPO_URL = `${GH}${REPO}`;

let xvfb;
let browser;
try {
  // 注意：match / host 權限不含埠號（Firefox 對帶埠號的樣式不報錯、卻永遠不會匹配）
  await run('node', ['scripts/build.mjs'], {
    AGG_API_BASE: apiBase,
    AGG_EXTRA_MATCH: 'http://127.0.0.1/*',
    AGG_OUT_DIR: 'e2e/.artifacts/extension',
    AGG_DEV: '1',
  });

  xvfb = await startXvfb();
  ({ browser } = await launchFirefox({
    firefox,
    extDir,
    geckoId: GECKO_ID,
    uuid: EXT_UUID,
    display: xvfb.display,
  }));
  console.log(`Firefox: ${await browser.version()}  (display ${xvfb.display})`);

  let newTabs = 0;
  browser.on('targetcreated', () => newTabs++);

  const decoder = await browser.newPage();
  await decoder.goto('about:blank');
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  // ── Shadow DOM（open）內的查詢 / 操作：content script 的畫面都在 #adorable-git-graph-host 裡 ──
  const root$ = `document.getElementById('adorable-git-graph-host')?.shadowRoot`;
  const shadow = (fn, ...args) =>
    page.evaluate(
      new Function('...args', `const sr = ${root$}; return (${fn.toString()})(sr, ...args);`),
      ...args,
    );
  const exists = (sel) => shadow((sr, s) => Boolean(sr?.querySelector(s)), sel);
  const textOf = (sel) => shadow((sr, s) => sr?.querySelector(s)?.textContent ?? null, sel);
  const chips = () =>
    shadow((sr) =>
      [...(sr?.querySelectorAll('.agg-chip') ?? [])].map((e) => e.textContent).join(' | '),
    );
  const waitFor = (sel, timeout = 20_000) =>
    page.waitForFunction(
      new Function('s', `return Boolean(${root$}?.querySelector(s));`),
      { timeout },
      sel,
    );
  const waitGone = (sel, timeout = 20_000) =>
    page.waitForFunction(
      new Function('s', `return !${root$}?.querySelector(s);`),
      { timeout },
      sel,
    );
  const replayDone = () => waitFor('.agg-canvas[data-replay="done"]', 90_000);
  /** `selector` 中（可再以 textContent 或屬性的 regex 篩選）的元素控制代碼 */
  const find = async (selector, pattern, by = 'textContent') => {
    const h = await page.evaluateHandle(
      new Function(
        's',
        'src',
        'by',
        `const sr = ${root$};
         const re = src ? new RegExp(src) : null;
         return [...(sr?.querySelectorAll(s) ?? [])].find((e) => !re || re.test(by === 'textContent' ? e.textContent ?? '' : e.getAttribute(by) ?? '')) ?? null;`,
      ),
      selector,
      pattern?.source ?? null,
      by,
    );
    const el = h.asElement();
    if (!el) throw new Error(`not found in shadow root: ${selector} ${pattern ?? ''}`);
    return el;
  };
  const click = async (selector, pattern, by) => (await find(selector, pattern, by)).click();
  const button = (label) => click('.agg-btn', label, 'aria-label');
  const canvasBox = async () => (await find('.agg-canvas')).boundingBox();
  const graphInk = async () => {
    const box = await canvasBox();
    const png = Buffer.from(
      await page.screenshot({
        clip: { x: box.x, y: box.y + 120, width: box.width, height: box.height - 220 },
      }),
    );
    return inkRatio(decoder, png);
  };
  const openOverlay = async () => {
    await waitFor('.agg-fab');
    await click('.agg-fab');
    await waitFor('.agg-canvas canvas');
  };
  const gotoRepo = async () => {
    await page.goto(REPO_URL);
    await waitFor('.agg-fab');
  };

  // ───────────────────────── 測試 ─────────────────────────

  await step('FAB appears on a repo page and not on a profile page', async () => {
    await page.goto(`${GH}/demo`);
    await sleep(800);
    assert.equal(await exists('.agg-fab'), false, 'FAB must not render on a user page');
    await gotoRepo();
  });

  await step('opens the overlay and draws the graph under real WebGL', async () => {
    await openOverlay();
    assert.equal(await textOf('.agg-title-text'), 'demo/adorable-git-graph');
    assert.match(await chips(), new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
    await replayDone();
    await sleep(1500);
    await page.screenshot({ path: resolve(artifacts, '1-overview.png') });
  });

  await step(
    'canvas actually painted cartoon outlines (ink pixels in the graph area)',
    async () => {
      const ratio = await graphInk();
      console.log('  ink pixel ratio:', ratio.toFixed(4));
      assert.ok(ratio > 0.003, `graph area looks empty (ink ratio ${ratio}) — is WebGL available?`);
      assert.equal(
        await exists('.agg-center[role="alert"]'),
        false,
        'no WebGL / error panel may be shown',
      );
    },
  );

  await step('legend focuses a branch; hovering the node shows the tooltip', async () => {
    await click('.agg-branch', /feat\/dark-mode/);
    await sleep(1700);
    const box = await canvasBox();
    await page.mouse.move(box.x + 40, box.y + 200);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
    await waitFor('.agg-tip');
    assert.match(await textOf('.agg-tip'), /feat: twinkling stars/);
    await sleep(400);
    await page.screenshot({ path: resolve(artifacts, '2-hover.png') });
  });

  await step('clicking a node opens the commit page in a new tab', async () => {
    const box = await canvasBox();
    const tab = await newTabFrom(browser, () =>
      page.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
    );
    const url = await waitForTabUrl(tab, /\/commit\/[0-9a-f]{40}$/);
    assert.match(url, /^https:\/\/github\.com\/demo\/adorable-git-graph\/commit\/[0-9a-f]{40}$/);
    await tab.close();
    await page.bringToFront();
  });

  await step(
    'mouse wheel zooms and a drag pans — and a drag must NOT open a commit page',
    async () => {
      const before = newTabs;
      const box = await canvasBox();
      await page.mouse.move(box.x + 400, box.y + 400);
      await page.mouse.wheel({ deltaY: -300 });
      await sleep(200);
      await page.mouse.down();
      await page.mouse.move(box.x + 700, box.y + 450, { steps: 8 });
      await page.mouse.up();
      await sleep(500);
      assert.equal(newTabs, before, 'a drag ended on the canvas and opened a tab');
      await page.screenshot({ path: resolve(artifacts, '3-zoom-pan.png') });
      await button(/^(Fit|全景)$/);
      await sleep(1200);
    },
  );

  await step('Escape closes the overlay', async () => {
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');
    await waitFor('.agg-fab');
  });

  await step('second open is served from cache; the refresh button forces a re-fetch', async () => {
    const before = apiCalls();
    await openOverlay();
    await sleep(600);
    assert.equal(apiCalls(), before, 'expected a cache hit (no new API requests)');
    await button(/^(Refresh|重新整理)$/);
    await waitUntil(() => apiCalls() > before);
    await waitFor('.agg-canvas canvas');
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');
  });

  await step('night theme follows GitHub color mode', async () => {
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'dark'));
    await openOverlay();
    await waitFor('.agg-root[data-theme="night"]');
    await replayDone();
    await sleep(1500);
    await page.screenshot({ path: resolve(artifacts, '4-night.png') });
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'light'));
  });

  await step('SPA navigation: error states (404 / rate limit) are friendly', async () => {
    await page.evaluate(() => history.pushState({}, '', '/ghost/missing'));
    await sleep(2000); // Navigation API / 輪詢都要能偵測到
    await waitFor('.agg-fab');
    await click('.agg-fab');
    await waitFor('.agg-center[role="alert"]');
    await sleep(700);
    await page.screenshot({ path: resolve(artifacts, '5-error-404.png') });
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');

    await page.evaluate(() => history.pushState({}, '', '/limited/repo'));
    await sleep(2000);
    await click('.agg-fab');
    await waitFor('.agg-center[role="alert"]');
    assert.match(await textOf('.agg-center'), /60/);
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');

    await page.evaluate((p) => history.pushState({}, '', p), REPO);
    await sleep(2000);
    await waitFor('.agg-fab');
  });

  await step(
    'the real toolbar button toggles the overlay (action.onClicked → tabs.sendMessage)',
    async () => {
      await page.bringToFront();
      await clickToolbarButton(browser, GECKO_ID);
      await waitFor('.agg-panel');
      await clickToolbarButton(browser, GECKO_ID);
      await waitGone('.agg-panel');
      await waitFor('.agg-fab');
    },
  );

  await step(
    'on a page without the content script the toolbar button shows the "!" badge',
    async () => {
      const blank = await browser.newPage();
      await blank.bringToFront();
      await clickToolbarButton(browser, GECKO_ID);
      await sleep(500);
      const opt = await openExtensionPage(browser, EXT_UUID, 'options.html');
      const bg = await backgroundHandle(opt);
      const badges = await bg.evaluate(async (w) => {
        const tabs = await w.chrome.tabs.query({});
        return Promise.all(tabs.map(async (t) => w.chrome.action.getBadgeText({ tabId: t.id })));
      });
      // 只有「沒有 content script 的那一個分頁」有 "!"；GitHub 頁面（剛剛成功 toggle）沒有
      assert.equal(badges.filter((b) => b === '!').length, 1, `badges: ${JSON.stringify(badges)}`);
      await opt.close();
      await blank.close();
      await page.bringToFront();
    },
  );

  await step(
    'the settings button opens the options page; saving a token is sent only as a Bearer header',
    async () => {
      await openOverlay();
      const opt = await newTabFrom(browser, () => button(/^(Settings|設定)$/));
      const url = await waitForTabUrl(opt, /^moz-extension:\/\//);
      assert.equal(url, `moz-extension://${EXT_UUID}/options.html`);
      await opt.waitForFunction(() => document.readyState === 'complete');
      await fillExt(opt, 'input[type="password"]', 'github_pat_e2e_secret');
      await clickExtByText(opt, 'button', /^(Save|儲存)$/);
      await opt.waitForFunction(() =>
        /✓/.test(document.querySelector('output')?.textContent ?? ''),
      );
      // 注意：moz-extension:// 頁面是特權範圍，BiDi 不允許對它截圖（captureScreenshot: unsupported operation）
      await clickExtByText(opt, 'button', /(Test|測試)/);
      await opt.waitForFunction(() =>
        /42/.test(document.querySelector('output')?.textContent ?? ''),
      );
      await opt.close();
      await page.bringToFront();

      seen.auth.length = 0;
      await waitFor('.agg-canvas canvas');
      await button(/^(Refresh|重新整理)$/);
      await waitUntil(() => seen.auth.length > 0);
      assert.ok(seen.auth.every((a) => a === 'Bearer github_pat_e2e_secret'));
      assert.ok(
        !(await page.content()).includes('github_pat_e2e_secret'),
        'token must never reach the page DOM',
      );
      assert.ok(
        seen.paths.every((p) => !p.includes('github_pat')),
        'token must never appear in a URL',
      );
      await page.keyboard.press('Escape');
      await waitGone('.agg-panel');
    },
  );

  await step(
    'the event page still answers after it has been idle past its timeout (suspend → wake)',
    async () => {
      // 本機預設 30 秒就會停掉 event page；縮短到 3 秒，等它真的停掉，再用一個「必須由 background 回應」的操作確認它會被喚醒
      await chromeEval(browser, () =>
        Services.prefs.setIntPref('extensions.background.idle.timeout', 3000),
      );
      try {
        await sleep(7000);
        const before = apiCalls();
        await openOverlay();
        await button(/^(Refresh|重新整理)$/);
        await waitUntil(() => apiCalls() > before);
        await waitFor('.agg-canvas canvas');
        assert.equal(
          await exists('.agg-center[role="alert"]'),
          false,
          'the woken event page must serve the request',
        );
        await page.keyboard.press('Escape');
        await waitGone('.agg-panel');
      } finally {
        await chromeEval(browser, () =>
          Services.prefs.setIntPref('extensions.background.idle.timeout', 600000),
        );
      }
    },
  );

  assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join('\n')}`);
  console.log(`\nAll ${results.length} Firefox e2e steps passed. Screenshots → ${artifacts}`);
} catch (err) {
  console.error('\n✘ Firefox e2e failed:', err);
  if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  xvfb?.stop();
  api.close();
  fake.close();
}
