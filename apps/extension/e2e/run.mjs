// End-to-end：以真實 Chromium 載入「已打包的 extension」，
// 用 mock GitHub API + 假的 github.com 頁面驗證整條流程，並輸出截圖到 e2e/.artifacts。
// 用法：pnpm e2e        （環境變數 CHROME_PATH 可指定 Chrome）
//
// viewer 是「垂直捲動的 git log 清單」：每一列是一個 commit（.agg-commit），WebGL 線圖是一張貼在捲動內容裡的 canvas
// （.agg-log > .agg-canvas，只畫可視範圍加上下緩衝的視窗，會跟著捲動重新定位）。涵蓋：
//   - FAB / overlay / 真的有畫出 WebGL（graph 欄位的深色描邊像素）/ 夜間主題 / 404 與 rate limit 錯誤畫面 / 快取與強制重抓 / 設定頁與 token 不外洩
//   - 列的 git 資訊：順序、短 sha、作者、日期、branch / tag 徽章、merge 標籤、conventional type 標籤、統計 chips
//   - 捲動與線圖同步：捲到多個位置後截圖，在每一列 node 中心取樣像素（要明顯異於卡片底色）、每一列的 graph 欄位不能是空白，
//     短視窗下捲動距離超過 canvas 緩衝時視窗（data-win-top）必須重新置中
//   - 鍵盤（j/k/方向鍵/Home/End、/）、搜尋（淡化、計數、Enter 逐筆跳、IME 不觸發）、branch 聚焦
//   - 詳情面板（內容、上一個 / 下一個 / parent 連結、在 GitHub 開啟的新分頁、複製 SHA、關閉後鍵盤焦點）
//   - RWD：wide / medium / narrow（無橫向溢位、窄螢幕底部面板不蓋住選取列、寬螢幕詳情不壓到列表、欄位標題對齊）
//   - 重新整理會保留捲動 / 選取（同一個 scroller 不被重建）、Esc 一次收一層、overlay 開著時背後頁面不能捲動、
//     鍵盤事件不會漏給 GitHub 頁面（shadow host 擋下）、點背景關閉
//   - 更早的歷史（infinite scroll，demo/long-history、每條 branch 一頁 25 筆）：捲到底就從 missing parent 往回載入下一批
//     （sha=<40 位 hex> 的請求）、列只接在後面、畫面不跳、場景不重播、線圖保持同步、頁尾的 載入中 / 失敗→再試一次 / 歷史起點
// 注意：WebGL 走 SwiftShader 軟體繪圖，CPU 吃緊時很慢，所以全部以「等狀態」為主、timeout 開得很寬。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';
import { fakeGithubPage } from '../../../tools/e2e/fake-github-page.mjs';
import { colorDistance, inkRatio, samplePixels } from '../../../tools/e2e/pixels.mjs';
import {
  LONG,
  SPECS,
  faults,
  gate,
  latency,
  releaseHeld,
  seen,
  sha,
  startMock,
} from '../../../tools/e2e/mock-github-api.mjs';

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

const errors = [];
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond, timeout = 15_000, what = 'condition') => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > timeout) throw new Error(`waitUntil timed out: ${what}`);
    await sleep(100);
  }
};
/** 反覆讀取 `read()` 直到等於 expected（deepStrictEqual）；逾時就丟出「預期 / 實際」。 */
const eventually = async (read, expected, label, timeout = 12_000) => {
  const t = Date.now();
  for (;;) {
    const v = await read();
    try {
      assert.deepStrictEqual(v, expected);
      return;
    } catch {
      if (Date.now() - t > timeout) {
        assert.fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(v)}`);
      }
    }
    await sleep(100);
  }
};
const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  results.push(`✔ ${name} (${Date.now() - t}ms)`);
  console.log(results.at(-1));
};
const shot = (page, name) => page.screenshot({ path: resolve(artifacts, name) });

// 軟體 WebGL 很慢：replay 在 CPU 吃緊時可能超過 1 分鐘
const REPLAY_TIMEOUT = 150_000;
const REPO_URL = 'https://github.com/demo/adorable-git-graph';
const HOST_ID = 'adorable-git-graph-host';

// 介面文字（zh-TW / en 都認）
const L = {
  refresh: /^(重新整理|Refresh)$/,
  close: /^(關閉|Close)$/,
  replay: /^(重播|Replay)$/,
  latest: /^(回到最新|Jump to latest)$/,
  settings: /^(設定|Settings)$/,
  fit: /^(全景|Fit)$/,
  prev: /^(上一個（較新）|Previous \(newer\))$/,
  next: /^(下一個（較舊）|Next \(older\))$/,
  closeDetail: /^(關閉詳情|Close details)$/,
  nextMatch: /^(下一筆符合|Next match)$/,
  prevMatch: /^(上一筆符合|Previous match)$/,
  clearSearch: /^(清除搜尋|Clear search)$/,
  copySha: /^(複製 SHA|Copy SHA)$/,
  copied: /(已複製|Copied)/,
  openCommit: /(在 GitHub 開啟|Open on GitHub)/,
  noMatches: /(沒有符合的 commit|No matching commits)/,
  initialCommit: /(最初的 commit|Initial commit)/,
  retry: /^(再試一次|Try again)$/,
  loadingMore: /(正在載入更早的歷史|Loading older history)/,
  loadedMore: /(已載入 \d+ 個更早的 commit|Loaded \d+ older commits?)/,
  loadMoreFailed: /(更早的歷史載入失敗|Could not load older history)/,
  startOfHistory: /(最初的 commit 在這裡|the first commit lives here)/,
};

// ───────────────────────── mock 資料的預期值 ─────────────────────────
// （HEADS / TAGS 與 tools/e2e/mock-github-api.mjs 保持一致；SPECS 是直接 import 的）

const HEADS = { main: 'm13', 'feat/dark-mode': 'y2', 'release/v0.1': 'r2', 'a-old': 'm1' };
const TAGS = { 'v0.1.0': 'r2', 'v0.0.1': 'm3' };
const T0 = Date.UTC(2026, 0, 1);
const specs = SPECS.map(([id, parents, msg, author, hours]) => ({
  id,
  parents,
  msg,
  author,
  hours,
  sha: sha(id),
  date: new Date(T0 + hours * 3600_000).toISOString(),
}));
const specById = new Map(specs.map((s) => [s.id, s]));
/** 畫面上由上（最新）到下（最舊）的 commit。 */
const ROWS = [...specs].sort((a, b) => b.hours - a.hours);
const rowOf = (id) => ROWS.findIndex((s) => s.id === id);
const LAST = ROWS.length - 1;
const reach = (id) => {
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const c = stack.pop();
    if (out.has(c)) continue;
    out.add(c);
    specById.get(c).parents.forEach((p) => stack.push(p));
  }
  return out;
};
const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert):\s+/i;
const refsAt = (id) =>
  [
    ...Object.entries(HEADS)
      .filter(([, v]) => v === id)
      .map(([n]) => `branch:${n}`),
    ...Object.entries(TAGS)
      .filter(([, v]) => v === id)
      .map(([n]) => `tag:${n}`),
  ].sort();

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

// 之後開出來的每一個分頁（decoder、commit 分頁、設定頁…）都一律收集 pageerror / console.error
let tabs = 0;
const watchErrors = (page, label) => {
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] console.error: ${m.text()}`);
  });
};
ctx.on('page', (p) => watchErrors(p, `tab#${++tabs}`));

/** 假 github 頁面（content script 所在的分頁）。 */
let page;
/** 空白分頁：用來解碼截圖（WebGL canvas 無法直接讀回，只能看截圖）。 */
let decoder;

// 在 viewer 內執行：callback 的第一個參數是 .agg-root（shadow DOM 裡），window / document 是頁面的。
const ui = (fn, arg) => page.locator('.agg-root').evaluate(fn, arg);

try {
  let sw = ctx.serviceWorkers()[0];
  sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  decoder = await ctx.newPage();
  await decoder.goto('about:blank');
  page = await ctx.newPage();

  // ───────────── 共用操作 ─────────────

  const panelSettled = () =>
    page
      .locator('.agg-panel')
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));

  const detailSettled = () =>
    page
      .locator('.agg-detail')
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));

  /** 等兩個 frame + 一小段時間，並把滑鼠停到背景（避免列的 hover 底色 / node 放大干擾像素）。 */
  const settle = async (ms = 200) => {
    await page.mouse.move(4, 4);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await sleep(ms);
  };

  async function openOverlay({ replay = false } = {}) {
    await page.bringToFront();
    if ((await page.locator('.agg-panel').count()) === 0) await page.locator('.agg-fab').click();
    await page.locator('.agg-panel').waitFor();
    await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
    await page.locator('.agg-canvas canvas').waitFor();
    await panelSettled();
    if (replay) {
      await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: REPLAY_TIMEOUT });
    }
  }

  const layerState = () =>
    ui((r) => ({
      detail: r.querySelector('.agg-detail') !== null,
      query: (r.querySelector('.agg-search input')?.value ?? '') !== '',
      branch: r.querySelector('.agg-branch[aria-pressed="true"]') !== null,
    }));

  /** 用 Esc 一層一層收掉詳情 / 搜尋 / branch 聚焦（只有真的有東西才按，否則 Esc 會關掉 overlay）。 */
  async function clearLayers() {
    for (let i = 0; i < 5; i++) {
      const s = await layerState();
      if (!s.detail && !s.query && !s.branch) return;
      await page.keyboard.press('Escape');
      await sleep(120);
    }
    assert.fail(`layers did not clear: ${JSON.stringify(await layerState())}`);
  }

  /** 讓鍵盤焦點回到 viewer（點標題；不會選取任何 commit）。 */
  const focusViewer = () => page.locator('.agg-title-text').click();
  const scrollTo = (top) =>
    ui((r, t) => {
      r.querySelector('.agg-scroll').scrollTop = t;
    }, top);
  const scrollTopNow = () => ui((r) => r.querySelector('.agg-scroll').scrollTop);
  async function scrollSettled() {
    let last = Number.NaN;
    let same = 0;
    for (let i = 0; i < 80; i++) {
      const t = await scrollTopNow();
      same = t === last ? same + 1 : 0;
      if (same >= 3) return t;
      last = t;
      await sleep(80);
    }
    assert.fail('the list never stopped scrolling');
  }
  /** 回到乾淨的初始狀態：沒有詳情 / 搜尋 / branch 聚焦、捲到最上面、焦點在 viewer。 */
  async function resetView() {
    await clearLayers();
    await scrollTo(0);
    await focusViewer();
    await settle(50);
  }
  async function closeOverlay() {
    if ((await page.locator('.agg-panel').count()) === 0) return;
    await clearLayers();
    await page.keyboard.press('Escape');
    await page.locator('.agg-panel').waitFor({ state: 'detached' });
    await page.locator('.agg-fab').waitFor();
  }

  const rowLoc = (id) => page.locator(`.agg-commit[data-sha="${sha(id)}"]`);
  const selectedRow = () =>
    ui((r) => {
      const el = r.querySelector('.agg-commit[data-selected]');
      return el ? Number(el.dataset.row) : null;
    });
  const rowStates = () =>
    ui((r) =>
      [...r.querySelectorAll('.agg-commit')].map((el) => ({
        sha: el.dataset.sha,
        dim: el.hasAttribute('data-dim'),
        selected: el.hasAttribute('data-selected'),
      })),
    );
  /** 沒有被淡化的 commit（以 ROWS 的 id 表示，依畫面順序）。 */
  const litIds = async () =>
    (await rowStates()).filter((s) => !s.dim).map((s) => specs.find((c) => c.sha === s.sha).id);
  const rowInView = (row) =>
    ui((r, n) => {
      const sc = r.querySelector('.agg-scroll').getBoundingClientRect();
      const b = r.querySelector(`.agg-commit[data-row="${n}"]`).getBoundingClientRect();
      return b.top >= sc.top - 1 && b.bottom <= sc.bottom + 1;
    }, row);
  const clickRow = (id) => rowLoc(id).locator('.agg-subject').click();
  /** mock API 的請求數量連續 `ms` 毫秒沒有增加（背景的抓取已經結束）。 */
  const quiet = async (ms) => {
    let last = -1;
    let since = Date.now();
    for (;;) {
      if (seen.paths.length !== last) {
        last = seen.paths.length;
        since = Date.now();
      } else if (Date.now() - since >= ms) return;
      await sleep(100);
    }
  };
  const searchInput = () => page.locator('.agg-search input');
  const searchCount = () => page.locator('.agg-search-count').innerText();
  const detailSubject = () => page.locator('.agg-detail-subject').innerText();
  const readClipboard = () =>
    page.evaluate(() => navigator.clipboard.readText()).catch((e) => `unreadable: ${e.message}`);

  // ───────────── 幾何 + 像素 ─────────────

  const geom = () =>
    ui((r) => {
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
      };
      const sc = r.querySelector('.agg-scroll');
      const log = r.querySelector('.agg-log');
      const cv = r.querySelector('.agg-canvas');
      const d = cv.dataset;
      return {
        dpr: window.devicePixelRatio,
        sc: box(sc),
        log: box(log),
        cv: box(cv),
        scrollTop: sc.scrollTop,
        maxScroll: sc.scrollHeight - sc.clientHeight,
        padLeft: Number(d.padLeft),
        pitch: Number(d.lanePitch),
        rowH: Number(d.rowH),
        topPad: Number(d.topPad),
        winTop: Number(d.winTop),
        graphW: log.querySelector('.agg-c-g').getBoundingClientRect().width,
        cardBg: getComputedStyle(r.querySelector('.agg-main')).backgroundColor,
        rows: [...log.querySelectorAll('.agg-commit')].map((el) => ({
          ...box(el),
          row: Number(el.dataset.row),
          lane: Number(el.dataset.lane),
          selected: el.hasAttribute('data-selected'),
        })),
      };
    });

  /** 每一列 graph 欄位（x0..x1 × y0..y1，截圖像素）裡「和底色明顯不同」的像素數。 */
  const bandCounts = (png, bands) =>
    decoder.evaluate(
      async ({ b64, bands }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        return bands.map(({ x0, y0, x1, y1, bg }) => {
          const { data } = g.getImageData(x0, y0, x1 - x0, y1 - y0);
          let n = 0;
          for (let i = 0; i < data.length; i += 4) {
            const d =
              Math.abs(data[i] - bg[0]) +
              Math.abs(data[i + 1] - bg[1]) +
              Math.abs(data[i + 2] - bg[2]);
            if (d > 60) n++;
          }
          return n;
        });
      },
      { b64: png.toString('base64'), bands },
    );

  const parseRgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);

  /**
   * 捲動 / 線圖同步：截下目前畫面，在「每一個可見列」的 node 中心取樣（座標由 canvas 的 data-* 與 .agg-log 的位置算出），
   * 顏色必須和同一列 graph 欄位最右邊（沒有 node / 邊的地方）的卡片底色明顯不同；每一個完整可見列的 graph 欄位也不能是空白。
   * 回傳幾何資料給呼叫端做額外檢查。
   */
  async function assertGraphSync(label) {
    await settle();
    const g = await geom();
    const png = await page.screenshot();
    const s = g.dpr;
    // canvas 視窗要蓋住整個可視範圍，不然捲到那裡就是一片空白
    assert.ok(
      g.cv.t <= g.sc.t + 1 && g.cv.b >= g.sc.b - 1,
      `${label}: canvas window [${g.cv.t}, ${g.cv.b}] does not cover the list viewport [${g.sc.t}, ${g.sc.b}]`,
    );
    const centreY = (row) => g.log.t + g.topPad + (row + 0.5) * g.rowH;
    const shown = g.rows.filter((r) => {
      const mid = (r.t + r.b) / 2;
      return mid > g.sc.t + 2 && mid < g.sc.b - 2;
    });
    assert.ok(shown.length >= 3, `${label}: expected several visible rows, got ${shown.length}`);
    // data-row-h / data-top-pad（給 canvas 用的公式）要和 DOM 實際的列位置一致
    for (const r of shown) {
      assert.ok(
        Math.abs(centreY(r.row) - (r.t + r.b) / 2) <= 1.5,
        `${label}: row ${r.row} DOM centre ${(r.t + r.b) / 2} != canvas formula ${centreY(r.row)}`,
      );
    }
    const nodePts = shown.map((r) => [
      (g.log.l + g.padLeft + r.lane * g.pitch) * s,
      centreY(r.row) * s,
    ]);
    const bgPts = shown.map((r) => [(g.log.l + g.graphW - 1) * s, centreY(r.row) * s]);
    const px = await samplePixels(decoder, png, [...nodePts, ...bgPts]);
    const cards = parseRgb(g.cardBg);
    shown.forEach((r, i) => {
      const node = px[i];
      const bg = px[shown.length + i];
      // （被選取的那一列底色有黃色高亮，不拿它和卡片底色比）
      assert.ok(
        r.selected || colorDistance(bg, cards) < 40,
        `${label}: row ${r.row}: sampled "background" ${bg} is not the card colour ${cards} (sampling the wrong spot?)`,
      );
      const dist = colorDistance(node, bg);
      assert.ok(
        dist > 90,
        `${label}: row ${r.row} (lane ${r.lane}): no node at its centre (pixel ${node} vs background ${bg}, distance ${dist})`,
      );
    });
    // 完整可見的列：graph 欄位不能是空白
    const full = shown.filter((r) => r.t >= g.sc.t - 0.5 && r.b <= g.sc.b + 0.5);
    const bands = full.map((r, i) => ({
      x0: Math.round((g.log.l + 1) * s),
      x1: Math.round((g.log.l + g.graphW - 1) * s),
      y0: Math.round((r.t + 1) * s),
      y1: Math.round((r.b - 1) * s),
      bg: px[shown.length + shown.indexOf(r)],
    }));
    const counts = await bandCounts(png, bands);
    counts.forEach((n, i) =>
      assert.ok(n >= 80, `${label}: row ${full[i].row} graph band is blank (${n} painted px)`),
    );
    return { g, png, shown: shown.length };
  }

  // ───────────────────────── steps ─────────────────────────

  await step('FAB appears on a repo page and not on a profile page', async () => {
    await page.goto(`https://github.com/demo`);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.agg-fab').count(), 0, 'FAB must not render on user page');
    await page.goto(REPO_URL);
    await page.locator('.agg-fab').waitFor({ timeout: 10_000 });
  });

  await step('opens overlay and the replay finishes (zh/en agnostic)', async () => {
    await page.locator('.agg-fab').click();
    await page.locator('.agg-panel').waitFor();
    await page.locator('.agg-canvas canvas').waitFor();
    assert.equal(await page.locator('.agg-title-text').innerText(), 'demo/adorable-git-graph');
    const chips = await page.locator('.agg-stats .agg-chip').allInnerTexts();
    assert.match(chips[0], new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
    assert.equal(
      await page.locator('.agg-fab').count(),
      0,
      'the FAB is replaced by the overlay while it is open',
    );
    await panelSettled();
    await shot(page, '1-replay-start.png');
    const t = Date.now();
    for (const i of [1, 2, 3]) {
      await sleep(1500);
      await shot(page, `1-replay-${i}.png`);
    }
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: REPLAY_TIMEOUT });
    console.log(`  replay finished after ${Date.now() - t + 4500}ms (software GL)`);
    await settle(1000);
    await shot(page, '2-overview.png');
  });

  await step(
    'WebGL really painted: ink pixels in the graph column of the visible rows',
    async () => {
      await resetView();
      await settle(400);
      const g = await geom();
      const clip = { x: g.log.l, y: g.sc.t, width: g.graphW, height: g.sc.b - g.sc.t };
      const png = await page.screenshot({ clip });
      // graph 欄位（.agg-c-g）在 DOM 裡是空的，所以裡面的深色描邊像素只可能來自 WebGL canvas
      const ratio = await inkRatio(decoder, png);
      console.log('  ink pixel ratio in the graph column:', ratio.toFixed(4));
      assert.ok(ratio > 0.01, `graph column looks empty (ink ratio ${ratio})`);
      // 沒有任何 DOM 東西畫在 graph 欄位：右邊緣一條沒有 node 的帶子應該完全沒有墨水
      const edge = await page.screenshot({
        clip: { x: g.log.l + g.graphW - 6, y: g.sc.t, width: 5, height: g.sc.b - g.sc.t },
      });
      assert.equal(await inkRatio(decoder, edge), 0, 'unexpected ink right of the last lane');
    },
  );

  await step(
    'rows show git info: order, short sha, author, date, refs, merge pills, type chips',
    async () => {
      await resetView();
      const rows = await page.locator('.agg-commit').evaluateAll((els) =>
        els.map((el) => ({
          sha: el.dataset.sha,
          row: Number(el.dataset.row),
          kind: el.dataset.kind,
          role: el.getAttribute('role'),
          short: el.querySelector('.agg-sha code')?.textContent,
          author: el.querySelector('.agg-author-name')?.textContent,
          dateAttr: el.querySelector('time')?.getAttribute('datetime'),
          dateTitle: el.querySelector('.agg-c-date')?.getAttribute('title'),
          dateText: el.querySelector('.agg-date-abs')?.textContent,
          subjectTitle: el.querySelector('.agg-subject')?.getAttribute('title'),
          type: el.querySelector('.agg-type')?.textContent ?? null,
          merge: el.querySelector('.agg-merge') !== null,
          refs: [...el.querySelectorAll('.agg-ref:not(.agg-ref--more)')]
            .map(
              (b) =>
                `${b.classList.contains('agg-ref--tag') ? 'tag' : 'branch'}:${b.querySelector('.agg-ref-name').textContent}`,
            )
            .sort(),
          isDefault: el.querySelector('.agg-ref--default .agg-ref-name')?.textContent ?? null,
        })),
      );
      assert.equal(rows.length, SPECS.length, 'one row per commit');
      assert.deepStrictEqual(
        rows.map((r) => r.sha),
        ROWS.map((s) => s.sha),
        'rows must be newest first',
      );
      assert.equal(rows[0].sha, sha('m13'), 'first row is the newest commit');
      rows.forEach((r, i) => {
        const exp = ROWS[i];
        assert.equal(r.row, i, `data-row of row ${i}`);
        assert.equal(r.role, 'option');
        assert.match(r.short, /^[0-9a-f]{7}$/, `short sha of ${exp.id}`);
        assert.equal(r.short, exp.sha.slice(0, 7));
        assert.equal(r.author, exp.author, `author of ${exp.id}`);
        assert.equal(r.dateAttr, exp.date, `datetime of ${exp.id}`);
        assert.ok(
          r.dateText && /\d/.test(r.dateText),
          `a readable date on ${exp.id}: ${r.dateText}`,
        );
        assert.match(r.dateTitle, / · /, `date tooltip is "absolute · relative" on ${exp.id}`);
        assert.equal(r.subjectTitle, exp.msg);
        // conventional commit 的前綴變成標籤，其他（merge / Revert …）沒有
        const m = CONVENTIONAL.exec(exp.msg);
        assert.equal(r.type, m ? m[1].toLowerCase() : null, `type chip of "${exp.msg}"`);
        // merge 標籤只出現在有兩個 parent 的 commit
        const isMerge = new Set(exp.parents).size > 1;
        assert.equal(r.merge, isMerge, `merge pill of ${exp.id}`);
        assert.equal(r.kind === 'merge', isMerge, `data-kind of ${exp.id}`);
        // branch / tag 徽章只在指向它們的 commit 上
        assert.deepStrictEqual(r.refs, refsAt(exp.id), `ref badges of ${exp.id}`);
      });
      assert.equal(rows.filter((r) => r.merge).length, 2, 'two merge commits');
      assert.equal(rows[rowOf('m13')].isDefault, 'main', 'the default branch badge is marked');
      // 統計 chips 與 branch 圖例
      const chips = await page.locator('.agg-stats .agg-chip').allInnerTexts();
      assert.match(chips[0], new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
      assert.match(
        chips[1],
        new RegExp(`^${Object.keys(HEADS).length} branch|^${Object.keys(HEADS).length} 條`),
      );
      assert.match(chips.join('|'), /2 tags?|2 個 tag|2 個標籤/i);
      assert.match(chips.join('|'), /3 authors?|3 位/i);
      assert.match(chips.join('|'), /2 merges?|2 個合併|2 次合併|2 個 merge/i);
      assert.equal(
        await page.locator('.agg-chip--filter').count(),
        0,
        'no filter chip without a filter',
      );
      const names = await page.locator('.agg-branch .agg-branch-name').allInnerTexts();
      assert.deepStrictEqual([...names].sort(), Object.keys(HEADS).sort());
      // 列表本身是 listbox，footer 在最後
      assert.equal(await page.locator('.agg-scroll').getAttribute('role'), 'listbox');
      assert.equal(await page.locator('.agg-footer').count(), 1);
      // 這一版沒有 Fit 按鈕、也沒有 tooltip
      assert.equal(await page.getByRole('button', { name: L.fit }).count(), 0, 'no Fit button');
      assert.equal(await page.locator('.agg-tip').count(), 0, 'no tooltip element');
    },
  );

  await step('scroll keeps the WebGL graph in sync with the rows (tall viewport)', async () => {
    await resetView();
    const { g } = await assertGraphSync('scrollTop 0');
    assert.ok(g.maxScroll > 150, `the list must be scrollable (max ${g.maxScroll})`);
    await shot(page, '3-scroll-0.png');
    for (const off of [123, Math.round(g.maxScroll / 2), g.maxScroll]) {
      await scrollTo(off);
      const r = await assertGraphSync(`scrollTop ${off}`);
      assert.ok(Math.abs(r.g.scrollTop - off) <= 1, `scrolled to ${off}, got ${r.g.scrollTop}`);
    }
    // 真的用滾輪（捲動鏈接 / overscroll 設定不能讓滾輪沒作用）
    await scrollTo(0);
    await settle();
    const box = await page.locator('.agg-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await eventually(async () => (await scrollSettled()) > 100, true, 'wheel scrolls the list');
    await assertGraphSync('after wheel');
    await shot(page, '3-scroll-wheel.png');
  });

  await step(
    'short viewport: the canvas window re-centres on a big scroll and stays in sync',
    async () => {
      await page.setViewportSize({ width: 1440, height: 600 });
      try {
        await eventually(() => ui((r) => r.dataset.size), 'wide', 'size class');
        await scrollTo(0);
        const first = await assertGraphSync('short: scrollTop 0');
        // 前提：canvas 視窗比整條 track 矮，捲到後面才需要重新置中（高視窗時整條 track 都在 canvas 裡）
        assert.ok(
          first.g.cv.h < first.g.log.h - 200,
          `short viewport must need re-centring (canvas ${first.g.cv.h}px of a ${first.g.log.h}px track)`,
        );
        const wins = [first.g.winTop];
        for (const off of [123, 300, 600, 0, first.g.maxScroll]) {
          await scrollTo(off);
          const r = await assertGraphSync(`short: scrollTop ${off}`);
          wins.push(r.g.winTop);
          if (off === 600) await shot(page, '3-scroll-short-600.png');
        }
        // 0 → 123 不會動；跳到 300 / 600 超過緩衝，視窗必須移動；跳回 0 要回到 0
        assert.equal(wins[1], wins[0], 'a small scroll must not move the canvas window');
        assert.notEqual(
          wins[3],
          wins[0],
          `canvas window did not re-centre after a big scroll: ${wins}`,
        );
        assert.ok(
          wins[3] > wins[0] && wins[2] > wins[1],
          `win-top should grow while scrolling down: ${wins}`,
        );
        assert.equal(wins[4], wins[0], `canvas window must come back to the top: ${wins}`);
        assert.ok(wins[5] > 0, `window must follow the list to the end: ${wins}`);
        console.log('  data-win-top while scrolling:', wins.join(' → '));
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
        await eventually(
          async () => {
            const g = await geom();
            return g.sc.b - g.sc.t > 500;
          },
          true,
          'viewport restored',
        );
      }
    },
  );

  await step('header buttons: Replay replays, Jump to latest scrolls up (no Fit)', async () => {
    await resetView();
    await scrollTo(300);
    await settle();
    await page.getByRole('button', { name: L.latest }).click();
    await eventually(scrollSettled, 0, 'Jump to latest scrolls to the top');
    await page.getByRole('button', { name: L.replay }).click();
    await waitUntil(
      async () => (await page.locator('.agg-canvas').getAttribute('data-replay')) === 'playing',
      8_000,
      'replay starts',
    );
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: REPLAY_TIMEOUT });
    for (const name of [L.refresh, L.settings, L.close]) {
      assert.equal(await page.getByRole('button', { name }).count(), 1, `header button ${name}`);
    }
    assert.equal(await page.getByRole('button', { name: L.fit }).count(), 0);
  });

  await step('keyboard: j/k/arrows/Home/End move the selection, "/" focuses search', async () => {
    await resetView();
    assert.equal(await selectedRow(), null);
    const key = async (k, expectRow, label) => {
      await page.keyboard.press(k);
      await eventually(selectedRow, expectRow, `${label} (${k})`);
    };
    await key('ArrowDown', 0, 'first ArrowDown selects the first visible row');
    await key('ArrowDown', 1, 'next row');
    await key('j', 2, 'j moves down');
    await key('j', 3, 'j moves down');
    await key('k', 2, 'k moves up');
    await key('ArrowUp', 1, 'ArrowUp moves up');
    await key('ArrowUp', 0, 'ArrowUp to the top');
    await key('ArrowUp', 0, 'ArrowUp stays on the first row');
    await key('End', LAST, 'End selects the last row');
    await waitUntil(() => rowInView(LAST), 10_000, 'the last row is scrolled into view');
    await key('ArrowDown', LAST, 'ArrowDown stays on the last row');
    await key('Home', 0, 'Home selects the first row');
    await waitUntil(async () => (await scrollTopNow()) === 0, 10_000, 'Home scrolls to the top');
    // 選取同步到 DOM / aria
    const aria = await ui((r) => {
      const el = r.querySelector('.agg-commit[data-selected]');
      return {
        selected: el.getAttribute('aria-selected'),
        active: r.querySelector('.agg-scroll').getAttribute('aria-activedescendant'),
        id: el.id,
        others: r.querySelectorAll('.agg-commit[aria-selected="true"]').length,
      };
    });
    assert.equal(aria.selected, 'true');
    assert.equal(aria.active, aria.id);
    assert.equal(aria.others, 1);
    // 選取會開詳情
    assert.equal(await page.locator('.agg-detail').count(), 1, 'selecting a row opens the detail');
    // 輸入法選字中的按鍵不是快捷鍵
    await ui((r) => {
      for (const key of ['j', 'ArrowDown', 'End'])
        r.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            composed: true,
          }),
        );
    });
    await sleep(300);
    assert.equal(await selectedRow(), 0, 'IME composition keys must not move the selection');

    // "/" 聚焦搜尋；在搜尋框裡打 j / k / / 不會被當成快捷鍵（選取不動）
    await page.locator('.agg-title-text').click();
    await page.keyboard.press('/');
    await eventually(
      () => ui((r) => r.getRootNode().activeElement === r.querySelector('.agg-search input')),
      true,
      '"/" focuses the search box',
    );
    assert.equal(await searchInput().inputValue(), '', '"/" itself must not be typed');
    await page.keyboard.type('jjkk/');
    assert.equal(await searchInput().inputValue(), 'jjkk/');
    assert.equal(
      await selectedRow(),
      0,
      'typing j/k// in the search box must not move the selection',
    );
    await page.keyboard.press('Escape'); // 清掉搜尋文字
    await eventually(() => searchInput().inputValue(), '', 'Esc clears the search text');
    assert.equal(await page.locator('.agg-panel').count(), 1, 'overlay stays open');
  });

  await step(
    'search: dims non-matches, counts, steps with Enter / Shift+Enter / chevrons',
    async () => {
      await resetView();
      await page.keyboard.press('/');
      await page.keyboard.type('rate limit');
      const hits = ['m7', 'x2', 'x1']; // 新 → 舊
      await eventually(litIds, hits, 'rows that match "rate limit"');
      const states = await rowStates();
      assert.equal(states.filter((s) => s.dim).length, SPECS.length - hits.length);
      assert.equal(await searchCount(), `0 / ${hits.length}`);
      const chips = await page.locator('.agg-stats .agg-chip').evaluateAll((els) =>
        els.map((e) => ({
          text: e.textContent,
          filter: e.classList.contains('agg-chip--filter'),
        })),
      );
      assert.ok(chips[0].filter, 'the filter chip comes first');
      assert.match(chips[0].text, new RegExp(`${hits.length}.*${SPECS.length}`), 'Showing 3 of 22');
      assert.match(chips[1].text, new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
      await shot(page, '4-search.png');

      // Enter：選第一筆符合的、開詳情、把它捲進畫面
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('m7'), 'Enter selects the first match');
      assert.equal(await searchCount(), `1 / ${hits.length}`);
      await page.locator('.agg-detail').waitFor();
      assert.equal(await detailSubject(), specById.get('m7').msg);
      await waitUntil(() => rowInView(rowOf('m7')), 10_000, 'match scrolled into view');
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('x2'), 'Enter steps to the next match');
      assert.equal(await searchCount(), `2 / ${hits.length}`);
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('x1'), 'third match');
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('m7'), 'Enter wraps around');
      await page.keyboard.press('Shift+Enter');
      await eventually(selectedRow, rowOf('x1'), 'Shift+Enter steps back (wraps)');
      assert.equal(await searchCount(), `3 / ${hits.length}`);
      await page.getByRole('button', { name: L.nextMatch }).click();
      await eventually(selectedRow, rowOf('m7'), 'next-match chevron');
      await page.getByRole('button', { name: L.prevMatch }).click();
      await eventually(selectedRow, rowOf('x1'), 'previous-match chevron');
      assert.deepStrictEqual(await litIds(), hits, 'stepping keeps the dimming');

      // 輸入法選字中的 Enter / Esc 不會跳轉、不會清除
      await searchInput().focus();
      await searchInput().evaluate((el) => {
        for (const key of ['Enter', 'Escape']) {
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              keyCode: 229,
              isComposing: true,
              bubbles: true,
              composed: true,
            }),
          );
        }
      });
      await sleep(300);
      assert.equal(await selectedRow(), rowOf('x1'), 'IME Enter must not step');
      assert.equal(await searchInput().inputValue(), 'rate limit', 'IME Esc must not clear');
      assert.equal(await page.locator('.agg-panel').count(), 1);

      // 不分大小寫、搜尋 author / sha / ref 名稱、多個詞要全部符合
      const cases = [
        ['RATE LIMIT', ['m7', 'x2', 'x1']],
        ['cat', ['y2', 'y1', 'x2', 'x1']],
        [sha('m5').slice(0, 9), ['m5']],
        ['dark-mode', ['y2']],
        ['v0.0.1', ['m3']],
        ['cat feat', ['y2', 'y1']],
      ];
      for (const [q, ids] of cases) {
        await searchInput().fill(q);
        await eventually(litIds, ids, `rows matching "${q}"`);
      }
      // 沒有符合
      await searchInput().fill('zzzz-no-such-commit');
      await eventually(litIds, [], 'nothing matches');
      assert.match(await searchCount(), L.noMatches);
      assert.match(
        await page.locator('.agg-chip--filter').innerText(),
        new RegExp(`0.*${SPECS.length}`),
      );
      const sel = await selectedRow();
      await page.keyboard.press('Enter');
      await sleep(300);
      assert.equal(await selectedRow(), sel, 'Enter without matches must not move the selection');
      assert.equal(await page.getByRole('button', { name: L.nextMatch }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: L.prevMatch }).isDisabled(), true);
      // 清除按鈕
      await page.getByRole('button', { name: L.clearSearch }).click();
      await eventually(() => searchInput().inputValue(), '', 'clear button empties the search');
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'nothing is dimmed without a query',
      );
      assert.equal(await page.locator('.agg-chip--filter').count(), 0);
      assert.equal(await page.locator('.agg-search-count').count(), 0);
    },
  );

  await step(
    'branch chips focus a branch: pressed state, dimming, scroll to the tip, Esc / click clears',
    async () => {
      await resetView();
      const chip = (name) => page.locator('.agg-branch', { hasText: name });
      const pressed = () =>
        page
          .locator('.agg-branch')
          .evaluateAll((els) =>
            els
              .filter((e) => e.getAttribute('aria-pressed') === 'true')
              .map((e) => e.querySelector('.agg-branch-name').textContent),
          );
      assert.deepStrictEqual(await pressed(), []);
      // a-old 的 tip 是最舊的 commit：點了要捲到最下面
      await chip('a-old').click();
      await eventually(pressed, ['a-old'], 'a-old is pressed');
      await eventually(litIds, ['m1'], 'only the history of a-old stays lit');
      await waitUntil(() => rowInView(LAST), 10_000, 'camera scrolled to the tip');
      assert.ok((await scrollSettled()) > 100, 'scrolled down to the tip of a-old');
      assert.match(
        await page.locator('.agg-chip--filter').innerText(),
        new RegExp(`1.*${SPECS.length}`),
      );
      // 換成另一條 branch：只有一個 chip 是 pressed
      await chip('feat/dark-mode').click();
      await eventually(pressed, ['feat/dark-mode'], 'only one chip pressed at a time');
      const lit = [...reach(HEADS['feat/dark-mode'])];
      await eventually(
        async () => [...(await litIds())].sort(),
        lit.sort(),
        'rows reachable from feat/dark-mode',
      );
      const dimmed = (await rowStates()).filter((s) => s.dim).length;
      assert.equal(dimmed, SPECS.length - lit.length);
      assert.ok(dimmed > 0 && lit.length > 0, 'the focus must dim something and keep something');
      await waitUntil(
        () => rowInView(rowOf('y2')),
        10_000,
        'scrolled to the tip of feat/dark-mode',
      );
      await shot(page, '5-branch-focus.png');
      // 再點一次 → 取消
      await chip('feat/dark-mode').click();
      await eventually(pressed, [], 'second click clears the focus');
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'nothing dimmed after clearing',
      );
      // Esc 也能取消
      await chip('release/v0.1').click();
      await eventually(pressed, ['release/v0.1'], 'release/v0.1 pressed');
      await eventually(
        async () => [...(await litIds())].sort(),
        [...reach(HEADS['release/v0.1'])].sort(),
        'rows reachable from release/v0.1',
      );
      await page.keyboard.press('Escape');
      await eventually(pressed, [], 'Esc clears the branch focus');
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'nothing dimmed after Esc',
      );
      assert.equal(await page.locator('.agg-panel').count(), 1, 'overlay stays open');
      // 搜尋只會算還亮著的列：聚焦 a-old 時搜尋 "rate" 找不到
      await chip('a-old').click();
      await page.keyboard.press('/');
      await page.keyboard.type('rate');
      await eventually(litIds, [], 'search is limited to the focused branch');
      assert.match(await searchCount(), L.noMatches);
      await clearLayers();
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'all layers cleared',
      );
    },
  );

  await step('detail panel: content, parents / children / prev / next jump', async () => {
    await resetView();
    await clickRow('m7');
    await page.locator('.agg-detail').waitFor();
    assert.equal(await selectedRow(), rowOf('m7'));
    assert.equal(
      await page.locator('.agg-root[data-detail]').count(),
      1,
      'root carries data-detail',
    );
    const d = await page.locator('.agg-detail').evaluate((el) => ({
      subject: el.querySelector('.agg-detail-subject').textContent,
      sha: el.querySelector('.agg-sha-full').textContent,
      text: el.textContent,
      parents: [
        ...el.querySelectorAll('.agg-facts dd.agg-stack')[0].querySelectorAll('.agg-link code'),
      ].map((c) => c.textContent),
      children: [
        ...el.querySelectorAll('.agg-facts dd.agg-stack')[1].querySelectorAll('.agg-link code'),
      ].map((c) => c.textContent),
    }));
    assert.equal(d.subject, specById.get('m7').msg);
    assert.match(d.sha, /^[0-9a-f]{40}$/);
    assert.equal(d.sha, sha('m7'));
    assert.match(d.text, /amy/, 'author in the detail');
    assert.match(d.text, /Jan 4, 2026|2026/, 'date in the detail');
    assert.deepStrictEqual(
      d.parents,
      ['m6', 'x2'].map((id) => sha(id).slice(0, 7)),
      'merge has two parents',
    );
    assert.deepStrictEqual(d.children, [sha('m8').slice(0, 7)]);
    await shot(page, '6-detail-wide.png');

    // parent 連結：跳到那個 commit
    await page.locator('.agg-detail .agg-link', { hasText: specById.get('x2').msg }).click();
    await eventually(selectedRow, rowOf('x2'), 'parent link selects the parent');
    await eventually(detailSubject, specById.get('x2').msg, 'detail follows the selection');
    // 上一個（較新）/ 下一個（較舊）
    await page.getByRole('button', { name: L.prev }).click();
    await eventually(selectedRow, rowOf('x2') - 1, 'Previous (newer)');
    await page.getByRole('button', { name: L.next }).click();
    await page.getByRole('button', { name: L.next }).click();
    await eventually(selectedRow, rowOf('x2') + 1, 'Next (older) twice');
    // child 連結（目前選的就是 m6，它的 child 是 m7）
    assert.equal(await detailSubject(), specById.get('m6').msg);
    await page.locator('.agg-detail .agg-link', { hasText: specById.get('m7').msg }).click();
    await eventually(selectedRow, rowOf('m7'), 'child link selects the child');
    await waitUntil(() => rowInView(rowOf('m7')), 10_000, 'linked commit scrolled into view');

    // 頭尾：沒有上一個 / 下一個
    await page.keyboard.press('Home');
    await eventually(selectedRow, 0, 'Home');
    assert.equal(
      await page.getByRole('button', { name: L.prev }).isDisabled(),
      true,
      'no newer commit',
    );
    await page.keyboard.press('End');
    await eventually(selectedRow, LAST, 'End');
    assert.equal(
      await page.getByRole('button', { name: L.next }).isDisabled(),
      true,
      'no older commit',
    );
    // 走到底的那一下，焦點落在被 disable 的按鈕上：鍵盤快捷鍵仍要有效
    await page.keyboard.press('ArrowUp');
    await eventually(selectedRow, LAST - 1, 'ArrowUp');
    await page.getByRole('button', { name: L.next }).click();
    await eventually(selectedRow, LAST, 'Next (older) reaches the last commit');
    await eventually(
      () => page.getByRole('button', { name: L.next }).isDisabled(),
      true,
      'Next now disabled',
    );
    await page.keyboard.press('ArrowUp');
    await eventually(
      selectedRow,
      LAST - 1,
      'ArrowUp still works after the focused button got disabled',
    );

    // 根 commit：沒有 parent、被所有 branch 包含
    await page.keyboard.press('End');
    await eventually(selectedRow, LAST, 'End');
    const root0 = await page.locator('.agg-detail').evaluate((el) => ({
      subject: el.querySelector('.agg-detail-subject').textContent,
      parentsText: el.querySelectorAll('.agg-facts dd')[3]?.textContent,
      contained: [...el.querySelectorAll('.agg-chips-wrap .agg-ref-name')]
        .map((n) => n.textContent)
        .sort(),
    }));
    assert.equal(root0.subject, 'chore: initial commit');
    assert.match(root0.parentsText, L.initialCommit);
    assert.deepStrictEqual(
      root0.contained,
      Object.keys(HEADS).sort(),
      'initial commit is in every branch',
    );
    // 中間的 commit：只被「走得到它」的 branch 包含；tag / branch 徽章列在詳情裡
    await clickRow('m3');
    await eventually(detailSubject, specById.get('m3').msg, 'm3 detail');
    const m3 = await page.locator('.agg-detail').evaluate((el) => ({
      contained: [...el.querySelectorAll('.agg-chips-wrap .agg-ref-name')]
        .map((n) => n.textContent)
        .sort(),
      refs: [...el.querySelectorAll('.agg-facts .agg-refs .agg-ref-name')]
        .map((n) => n.textContent)
        .sort(),
    }));
    assert.deepStrictEqual(
      m3.contained,
      Object.entries(HEADS)
        .filter(([, h]) => reach(h).has('m3'))
        .map(([n]) => n)
        .sort(),
      'branches containing m3',
    );
    assert.deepStrictEqual(m3.refs, ['v0.0.1'], 'tag at m3');
    // 點作者 → 以作者搜尋
    await page.locator('.agg-detail .agg-link--plain').click();
    await eventually(
      () => searchInput().inputValue(),
      'amy',
      'author click searches for the author',
    );
    await eventually(
      litIds,
      ROWS.filter((s) => s.author === 'amy').map((s) => s.id),
      'rows by amy',
    );
    await clearLayers();
  });

  await step(
    'detail: "Open on GitHub" opens the commit in a new tab; Copy SHA shows the copied state',
    async () => {
      await resetView();
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: 'https://github.com',
      });
      await clickRow('m5');
      await page.locator('.agg-detail').waitFor();
      const cta = page.locator('.agg-detail .agg-cta');
      assert.match(await cta.innerText(), L.openCommit);
      const [popup] = await Promise.all([ctx.waitForEvent('page'), cta.click()]);
      assert.equal(popup.url(), `${REPO_URL}/commit/${sha('m5')}`, 'commit page in a new tab');
      assert.match(popup.url(), /github\.com\/demo\/adorable-git-graph\/commit\/[0-9a-f]{40}$/);
      await popup.close();
      await page.bringToFront();
      assert.equal(await selectedRow(), rowOf('m5'), 'selection survives opening the commit page');
      assert.equal(await page.locator('.agg-panel').count(), 1);

      // Copy SHA（詳情裡的小按鈕）：先把剪貼簿設成別的值，才確定真的是這次複製寫進去的
      await page.evaluate(() => navigator.clipboard.writeText('sentinel-before-copy'));
      assert.equal(
        await readClipboard(),
        'sentinel-before-copy',
        'clipboard is readable in this browser',
      );
      const copy = page.locator('.agg-detail .agg-mini-btn');
      assert.equal(await copy.getAttribute('data-state'), 'idle');
      await copy.click();
      await eventually(
        () => copy.getAttribute('data-state'),
        'ok',
        'copy button shows the copied state',
      );
      assert.match(await copy.innerText(), L.copied);
      assert.equal(await readClipboard(), sha('m5'), 'the full sha is on the clipboard');
      await eventually(
        () => copy.getAttribute('data-state'),
        'idle',
        'copied state fades back',
        5_000,
      );
      assert.match(await copy.innerText(), L.copySha);

      // 列上的 sha 按鈕：複製完整 sha、顯示 ✓、但不會順便選取那一列
      await page.evaluate(() => navigator.clipboard.writeText('sentinel-before-row-copy'));
      const other = rowLoc('m10');
      const btn = other.locator('.agg-sha');
      assert.match(await btn.locator('code').innerText(), /^[0-9a-f]{7}$/);
      await btn.click();
      await eventually(() => btn.getAttribute('data-state'), 'ok', 'row sha button shows ✓');
      assert.equal(await readClipboard(), sha('m10'), 'row button copies the FULL sha');
      assert.equal(await selectedRow(), rowOf('m5'), 'copying from a row must not select that row');
      await eventually(() => btn.getAttribute('data-state'), 'idle', 'row ✓ fades back', 5_000);

      // 關閉詳情後鍵盤焦點要回到 viewer，ArrowDown 仍然有效
      await scrollTo(0);
      await page.getByRole('button', { name: L.closeDetail }).click();
      await page.locator('.agg-detail').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.agg-root[data-detail]').count(), 0);
      assert.equal(await selectedRow(), null, 'closing the detail deselects');
      const focused = await ui((r) => {
        const a = r.getRootNode().activeElement;
        return a !== null && r.contains(a);
      });
      assert.ok(focused, 'keyboard focus stays inside the viewer after closing the detail');
      await page.keyboard.press('ArrowDown');
      await eventually(selectedRow, 0, 'ArrowDown works after closing the detail with the button');
      await page.keyboard.press('Escape'); // 鍵盤關詳情
      await page.locator('.agg-detail').waitFor({ state: 'detached' });
      await page.keyboard.press('ArrowDown');
      await eventually(selectedRow, 0, 'ArrowDown works after closing the detail with Esc');
      // 點同一列再點一次 = 取消選取
      await page.keyboard.press('Escape');
      await clickRow('m9');
      await eventually(selectedRow, rowOf('m9'), 'click selects');
      await clickRow('m9');
      await eventually(selectedRow, null, 'clicking the selected row again deselects');
      assert.equal(await page.locator('.agg-detail').count(), 0);
    },
  );

  await step(
    'RWD: wide / medium / narrow have no horizontal overflow, detail never hides the selected row',
    async () => {
      const overflow = () =>
        ui((r) => {
          const sc = r.querySelector('.agg-scroll');
          return {
            scroll: sc.scrollWidth - sc.clientWidth,
            doc: document.documentElement.scrollWidth - window.innerWidth,
            root: r.scrollWidth - r.clientWidth,
            panel: r.closest('.agg-panel').scrollWidth - r.closest('.agg-panel').clientWidth,
          };
        });
      const assertNoOverflow = async (label) => {
        const o = await overflow();
        assert.ok(o.scroll <= 1, `${label}: .agg-scroll overflows horizontally by ${o.scroll}px`);
        assert.ok(o.doc <= 0, `${label}: the document overflows horizontally by ${o.doc}px`);
        assert.ok(o.root <= 1, `${label}: .agg-root overflows horizontally by ${o.root}px`);
        assert.ok(o.panel <= 1, `${label}: .agg-panel overflows horizontally by ${o.panel}px`);
      };
      const rect = (sel) =>
        page.locator(sel).evaluate((el) => {
          const b = el.getBoundingClientRect();
          return { l: b.left, t: b.top, r: b.right, b: b.bottom };
        });
      const visible = (sel) =>
        page
          .locator(sel)
          .first()
          .evaluate((el) => {
            const cs = getComputedStyle(el);
            const b = el.getBoundingClientRect();
            return (
              cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0
            );
          });
      const sizes = [
        { name: 'wide', w: 1440, h: 900, size: 'wide' },
        { name: 'medium', w: 820, h: 900, size: 'medium' },
        { name: 'narrow', w: 390, h: 844, size: 'narrow' },
      ];
      try {
        for (const vp of sizes) {
          await resetView();
          await page.setViewportSize({ width: vp.w, height: vp.h });
          await eventually(() => ui((r) => r.dataset.size), vp.size, `${vp.name}: size class`);
          await panelSettled();
          await settle();
          const cols = await ui((r) => r.dataset.cols);
          console.log(`  ${vp.name}: ${vp.w}x${vp.h} data-cols=${cols}`);
          await assertNoOverflow(`${vp.name} (list only)`);
          await assertGraphSync(`${vp.name}: graph`);
          await shot(page, `7-rwd-${vp.name}.png`);
          // 捲到中間與最底下也要同步（窄螢幕的列比較高，canvas 視窗相對更短，要重新置中）
          const { maxScroll } = await geom();
          for (const off of [Math.round(maxScroll / 2), maxScroll]) {
            await scrollTo(off);
            await assertGraphSync(`${vp.name}: scrollTop ${off}`);
          }
          await scrollTo(0);

          // 欄位組合
          if (vp.size === 'wide') assert.equal(cols, 'full', 'wide shows author + date + sha');
          if (vp.size === 'medium') {
            assert.equal(cols, 'compact', 'medium collapses the author to an avatar');
            assert.equal(
              await visible('.agg-commit .agg-author-name'),
              false,
              'author name hidden in compact',
            );
            assert.equal(
              await visible('.agg-commit .agg-c-author img'),
              true,
              'author avatar still shown',
            );
          }
          if (vp.size === 'narrow') {
            assert.equal(cols, 'min');
            // 兩行式：作者 · 日期 · sha 在第二行
            const two = await rowLoc('m13').evaluate((el) => {
              const top = (s) => el.querySelector(s).getBoundingClientRect().top;
              const vis = (s) => {
                const b = el.querySelector(s).getBoundingClientRect();
                return b.width > 0 && b.height > 0;
              };
              return {
                h: el.getBoundingClientRect().height,
                main: top('.agg-subject'),
                author: top('.agg-c-author'),
                date: top('.agg-c-date'),
                sha: top('.agg-c-sha'),
                shown: ['.agg-c-author', '.agg-c-date', '.agg-c-sha'].every(vis),
              };
            });
            assert.ok(two.shown, 'author, date and sha are visible in the narrow two-line row');
            assert.ok(two.h > 52, `narrow rows are two lines tall (${two.h}px)`);
            for (const k of ['author', 'date', 'sha']) {
              assert.ok(
                two[k] > two.main + 8,
                `narrow: ${k} is on the second line (${two[k]} vs ${two.main})`,
              );
            }
          }

          // 欄位標題與列的欄位對齊（寬螢幕 full）
          if (vp.size === 'wide') {
            const align = await ui((r) => {
              const head = r.querySelector('.agg-colhead');
              const row = r.querySelector('.agg-commit');
              const out = {};
              for (const c of ['c-g', 'c-main', 'c-author', 'c-date', 'c-sha']) {
                const a = head.querySelector(`.agg-${c}`).getBoundingClientRect();
                const b = row.querySelector(`.agg-${c}`).getBoundingClientRect();
                out[c] = {
                  dl: Math.abs(a.left - b.left),
                  dw: Math.abs(a.width - b.width),
                  w: a.width,
                };
              }
              return out;
            });
            for (const [c, v] of Object.entries(align)) {
              assert.ok(v.w > 0, `${c} header has a width`);
              assert.ok(
                v.dl <= 1.5 && v.dw <= 1.5,
                `column header ${c} misaligned with the rows: ${JSON.stringify(v)}`,
              );
            }
          }

          // 開詳情
          const target = 'm10';
          if (vp.size === 'narrow') {
            // 把目標列捲到清單的最底下，再點它：底部面板把清單縮小後，那一列必須被捲回看得見的地方
            await ui((r, row) => {
              const sc = r.querySelector('.agg-scroll');
              const m = r.querySelector('.agg-commit').getBoundingClientRect().height;
              sc.scrollTop = 10 + (row + 1) * m - sc.clientHeight;
            }, rowOf(target));
            await settle(100);
          }
          await clickRow(target);
          await page.locator('.agg-detail').waitFor();
          await panelSettled();
          await detailSettled(); // 詳情的滑入動畫還在跑時量到的位置會偏移
          await settle(300);
          assert.equal(await selectedRow(), rowOf(target));
          await assertNoOverflow(`${vp.name} (detail open)`);
          const detail = await rect('.agg-detail');
          const main = await rect('.agg-main');
          const rootBox = await rect('.agg-root');
          assert.ok(
            detail.l >= rootBox.l - 1 &&
              detail.r <= rootBox.r + 1 &&
              detail.t >= rootBox.t - 1 &&
              detail.b <= rootBox.b + 1,
            `${vp.name}: detail is inside the viewer ${JSON.stringify({ detail, rootBox })}`,
          );
          if (vp.size === 'wide') {
            assert.ok(
              detail.l >= main.r - 1,
              `wide: detail (${detail.l}) must not overlap the list (right edge ${main.r})`,
            );
            const colsOpen = await ui((r) => r.dataset.cols);
            // 並排之後欄位標題仍然要對得齊
            if (colsOpen !== 'min') {
              const a = await ui((r) => {
                const head = r.querySelector('.agg-colhead .agg-c-date').getBoundingClientRect();
                const row = r.querySelector('.agg-commit .agg-c-date').getBoundingClientRect();
                return Math.abs(head.left - row.left);
              });
              assert.ok(a <= 1.5, `wide + detail: date column misaligned by ${a}px`);
            }
          }
          if (vp.size === 'narrow') {
            await eventually(
              async () => {
                const row = await rect(`.agg-commit[data-sha="${sha(target)}"]`);
                const sheet = await rect('.agg-detail');
                const sc = await rect('.agg-scroll');
                return row.b <= sheet.t + 1 && row.t >= sc.t - 1;
              },
              true,
              'narrow: the selected row stays above the bottom sheet',
              15_000,
            );
            const sheet = await rect('.agg-detail');
            const sc = await rect('.agg-scroll');
            assert.ok(
              sheet.t >= sc.b - 1,
              `narrow: sheet (${sheet.t}) sits below the list (${sc.b}): it lives in the flow`,
            );
            assert.ok(sheet.b - sheet.t <= 844 * 0.6, 'narrow: the sheet leaves room for the list');
          }
          if (vp.size === 'medium') {
            const pos = await page
              .locator('.agg-detail')
              .evaluate((el) => getComputedStyle(el).position);
            assert.equal(pos, 'absolute', 'medium: the detail is a floating drawer');
          }
          await shot(page, `7-rwd-${vp.name}-detail.png`);
          // 詳情開著時線圖仍然對齊（列表變窄 → 場景重排版）
          await assertGraphSync(`${vp.name} + detail: graph`);
          await clearLayers();
        }

        // 詳情開著時直接縮成手機寬度（例如旋轉裝置）：選取的那一列仍要留在底部面板上方看得到；
        // 在手機寬度用鍵盤跳到最後一列也一樣。
        const aboveSheet = async () => {
          const g = await geom();
          const sel = g.rows.find((r) => r.selected);
          const sheet = await rect('.agg-detail');
          return Boolean(sel) && sel.b <= sheet.t + 1 && sel.t >= g.sc.t - 1 && sel.b <= g.sc.b + 1;
        };
        await page.setViewportSize({ width: 1440, height: 900 });
        await eventually(() => ui((r) => r.dataset.size), 'wide', 'back to wide');
        await resetView();
        await clickRow('m4');
        await page.locator('.agg-detail').waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        await eventually(
          () => ui((r) => r.dataset.size),
          'narrow',
          'resized to narrow with the detail open',
        );
        await eventually(
          aboveSheet,
          true,
          'resize to narrow: the selected row stays above the sheet',
          15_000,
        );
        assert.equal(await selectedRow(), rowOf('m4'), 'selection survives the resize');
        await page.keyboard.press('End');
        await eventually(selectedRow, LAST, 'End in narrow mode');
        await eventually(
          aboveSheet,
          true,
          'narrow: the last row stays above the sheet after End',
          15_000,
        );
        await page.keyboard.press('Home');
        await eventually(selectedRow, 0, 'Home in narrow mode');
        await eventually(
          aboveSheet,
          true,
          'narrow: the first row stays visible after Home',
          15_000,
        );
        await clearLayers();
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
        await eventually(() => ui((r) => r.dataset.size), 'wide', 'viewport restored');
      }
    },
  );

  await step(
    'refresh keeps the list mounted: same scroller, scroll position and selection',
    async () => {
      await resetView();
      await scrollTo(250);
      await settle();
      await clickRow('m6');
      await page.locator('.agg-detail').waitFor();
      await settle(200);
      const before = await ui((r) => {
        const sc = r.querySelector('.agg-scroll');
        sc.__e2eSameScroller = true;
        window.__aggRefreshLog = [];
        const log = window.__aggRefreshLog;
        const mo = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type === 'attributes')
              log.push(`${m.attributeName}=${m.target.getAttribute(m.attributeName)}`);
            for (const n of m.removedNodes)
              if (n.nodeType === 1 && (n.matches('.agg-scroll') || n.querySelector('.agg-scroll')))
                log.push('scroll-removed');
            for (const n of m.addedNodes)
              if (n.nodeType === 1 && (n.matches('.agg-center') || n.querySelector('.agg-center')))
                log.push('loading-or-error-shown');
          }
        });
        mo.observe(r.getRootNode(), {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-busy', 'data-replay'],
        });
        window.__aggRefreshObserver = mo;
        return {
          scrollTop: sc.scrollTop,
          selected: r.querySelector('.agg-commit[data-selected]').dataset.sha,
        };
      });
      assert.ok(before.scrollTop > 100, `scrolled down before refreshing (${before.scrollTop})`);
      assert.equal(before.selected, sha('m6'));
      const requests = seen.paths.length;
      // API 回應太快時，React 會把「開始重新整理」和「完成」合併成同一次 render，轉圈根本不會出現：
      // 讓每個回應慢一點，轉圈一定看得到（要驗證的是「轉圈而列表不卸載」，不是網路有多快）
      latency.ms = 150;
      try {
        await page.getByRole('button', { name: L.refresh }).click();
        await waitUntil(() => seen.paths.length > requests, 15_000, 'refresh hits the API again');
        await waitUntil(
          () => page.evaluate(() => window.__aggRefreshLog.includes('aria-busy=null')),
          20_000,
          'the refresh spinner stops',
        );
      } finally {
        latency.ms = 0;
      }
      await settle(500);
      const after = await ui((r) => {
        const sc = r.querySelector('.agg-scroll');
        window.__aggRefreshObserver.disconnect();
        return {
          same: sc.__e2eSameScroller === true,
          connected: sc.isConnected,
          scrollTop: sc.scrollTop,
          selected: r.querySelector('.agg-commit[data-selected]')?.dataset.sha ?? null,
          detail: r.querySelector('.agg-detail') !== null,
          busy: r.querySelector('[aria-busy="true"]') !== null,
          rows: r.querySelectorAll('.agg-commit').length,
          replay: r.querySelector('.agg-canvas').dataset.replay,
          log: window.__aggRefreshLog,
        };
      });
      assert.ok(after.log.includes('aria-busy=true'), `the Refresh button must spin: ${after.log}`);
      assert.ok(after.same && after.connected, 'the same .agg-scroll element survives the refresh');
      assert.ok(!after.log.includes('scroll-removed'), `the list was unmounted: ${after.log}`);
      assert.ok(
        !after.log.includes('loading-or-error-shown'),
        `a loading / error panel flashed: ${after.log}`,
      );
      assert.ok(
        !after.log.includes('data-replay=playing'),
        `the graph replayed on refresh: ${after.log}`,
      );
      assert.equal(after.replay, 'done');
      assert.ok(
        Math.abs(after.scrollTop - before.scrollTop) <= 4,
        `scroll jumped ${before.scrollTop} → ${after.scrollTop}`,
      );
      assert.equal(after.selected, before.selected, 'selection kept');
      assert.ok(after.detail, 'detail panel kept');
      assert.equal(after.busy, false);
      assert.equal(after.rows, SPECS.length);
      await assertGraphSync('after refresh');
      await clearLayers();
    },
  );

  await step('Escape closes one layer at a time, then the overlay', async () => {
    await resetView();
    const chip = page.locator('.agg-branch', { hasText: 'feat/dark-mode' });
    // 三層：branch 聚焦、搜尋文字、選取（詳情）。焦點在 viewer（不在搜尋框）時：詳情 → 搜尋 → branch → overlay
    await chip.click();
    await page.keyboard.press('/');
    await page.keyboard.type('feat');
    await page.keyboard.press('Enter'); // 選第一筆符合的並開詳情
    await page.locator('.agg-detail').waitFor();
    await focusViewer();
    assert.deepStrictEqual(await layerState(), { detail: true, query: true, branch: true });
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: false, query: true, branch: true },
      'Esc 1 closes the detail',
    );
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: false, query: false, branch: true },
      'Esc 2 clears the search',
    );
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: false, query: false, branch: false },
      'Esc 3 clears the branch focus',
    );
    assert.equal(
      await page.locator('.agg-panel').count(),
      1,
      'overlay is still open after three Escapes',
    );
    // 在搜尋框裡：Esc 先清文字（選取仍在），再來關詳情，最後關 overlay
    await page.keyboard.press('/');
    await page.keyboard.type('rate limit');
    await page.keyboard.press('Enter');
    await page.locator('.agg-detail').waitFor();
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: true, query: false, branch: false },
      'Esc in the search box clears the text first',
    );
    assert.equal(await page.locator('.agg-panel').count(), 1);
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: false, query: false, branch: false },
      'next Esc closes the detail',
    );
    assert.equal(await page.locator('.agg-panel').count(), 1);
    await page.keyboard.press('Escape');
    await page.locator('.agg-panel').waitFor({ state: 'detached' });
    await page.locator('.agg-fab').waitFor();
    // 重新打開：選取 / 搜尋不會殘留
    await openOverlay();
    assert.deepStrictEqual(await layerState(), { detail: false, query: false, branch: false });
  });

  await step(
    'extension: the page behind the overlay cannot scroll; <html> styles are restored on close',
    async () => {
      await closeOverlay();
      // 讓假頁面夠高（能捲動），並預先放一個 inline overflow：關閉後要還原成它
      await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.id = 'agg-e2e-spacer';
        spacer.style.height = '4000px';
        document.body.append(spacer);
        document.documentElement.style.overflow = 'auto';
        window.scrollTo(0, 0);
      });
      const pageState = () =>
        page.evaluate(() => ({
          y: window.scrollY,
          overflow: document.documentElement.style.overflow,
          computed: getComputedStyle(document.documentElement).overflowY,
          gutter: document.documentElement.style.scrollbarGutter,
        }));
      const wheelAt = async (x, y, dy = 700) => {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, dy);
        await sleep(250);
      };
      // 對照組：overlay 沒開時滾輪會捲動頁面（否則底下的斷言沒有意義）
      await wheelAt(700, 450);
      await eventually(
        async () => (await pageState()).y > 0,
        true,
        'the fake page scrolls when the overlay is closed',
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('.agg-fab').click();
      await page.locator('.agg-panel').waitFor();
      await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
      await panelSettled();

      let st = await pageState();
      assert.equal(st.overflow, 'hidden', '<html> overflow is locked while the overlay is open');
      assert.equal(st.computed, 'hidden');
      assert.equal(st.gutter, 'stable', 'scrollbar-gutter keeps the background from shifting');
      assert.equal(st.y, 0);

      // 清單捲到底之後再滾（捲動鏈接不能把頁面帶著走）
      const list = await page.locator('.agg-scroll').boundingBox();
      const spots = {
        'list (at its end)': [list.x + list.width / 2, list.y + list.height / 2],
        toolbar: await page
          .locator('.agg-toolbar')
          .boundingBox()
          .then((b) => [b.x + b.width / 2, b.y + b.height / 2]),
        header: await page
          .locator('.agg-top')
          .boundingBox()
          .then((b) => [b.x + 30, b.y + b.height / 2]),
        'backdrop (left)': [10, 450],
        'backdrop (right)': [1430, 450],
        'backdrop (top)': [700, 6],
      };
      await wheelAt(...spots['list (at its end)'], 600);
      assert.ok((await scrollSettled()) > 100, 'the wheel scrolls the list itself');
      await scrollTo(1e6);
      for (const [name, [x, y]] of Object.entries(spots)) {
        await wheelAt(x, y, 900);
        await wheelAt(x, y, -300);
        await wheelAt(x, y, 900);
        st = await pageState();
        assert.equal(st.y, 0, `page scrolled (scrollY=${st.y}) while wheeling over the ${name}`);
      }
      await shot(page, '8-extension-scroll-lock.png');

      await closeOverlay();
      st = await pageState();
      assert.equal(
        st.overflow,
        'auto',
        `<html> overflow restored to its previous inline value (${st.overflow})`,
      );
      assert.equal(st.gutter, '', 'scrollbar-gutter restored');
      await wheelAt(700, 450);
      await eventually(
        async () => (await pageState()).y > 0,
        true,
        'the page scrolls again after closing',
      );
      await page.evaluate(() => {
        document.getElementById('agg-e2e-spacer').remove();
        document.documentElement.style.overflow = '';
        window.scrollTo(0, 0);
      });
    },
  );

  await step(
    'extension: clicking the backdrop closes the overlay, a drag that starts inside does not',
    async () => {
      await openOverlay();
      const panel = await page.locator('.agg-panel').boundingBox();
      // 在面板裡按下、拖到背景放開（例如選文字）不算點背景
      await page.mouse.move(panel.x + 200, panel.y + 40);
      await page.mouse.down();
      await page.mouse.move(8, 8, { steps: 4 });
      await page.mouse.up();
      await sleep(300);
      assert.equal(
        await page.locator('.agg-panel').count(),
        1,
        'a drag out of the panel must not close it',
      );
      // 點面板內部不會關
      await page.locator('.agg-title-text').click();
      await sleep(200);
      assert.equal(
        await page.locator('.agg-panel').count(),
        1,
        'clicking inside the panel must not close it',
      );
      // 點背景才關
      await page.mouse.click(10, 450);
      await page.locator('.agg-panel').waitFor({ state: 'detached' });
      await page.locator('.agg-fab').waitFor();
    },
  );

  await step(
    'extension: key events never reach the GitHub page (document-level hotkeys stay quiet)',
    async () => {
      await closeOverlay();
      await page.evaluate(() => {
        window.__keys = [];
        const rec = (e) => window.__keys.push(`${e.type}:${e.key}`);
        // GitHub 的快捷鍵就是掛在 document / window 的 bubble 階段
        for (const type of ['keydown', 'keyup', 'keypress']) document.addEventListener(type, rec);
        window.addEventListener('keydown', rec);
      });
      const keys = () => page.evaluate(() => window.__keys.slice());
      // 對照組：overlay 沒開時，頁面看得到按鍵
      await page.locator('body').click({ position: { x: 5, y: 200 } });
      await page.keyboard.press('g');
      await eventually(
        async () => (await keys()).includes('keydown:g'),
        true,
        'the page listener works while the overlay is closed',
      );
      await page.evaluate(() => (window.__keys.length = 0));

      await page.locator('.agg-fab').click();
      await page.locator('.agg-panel').waitFor();
      await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
      await panelSettled();
      await page.evaluate(() => (window.__keys.length = 0));
      // 在列表上導覽、在搜尋框裡打字（含 j k / g t s 等 GitHub 快捷鍵字母）、Enter、Esc 清除、再選一筆
      for (const k of ['ArrowDown', 'j', 'k', 'End', 'Home', 'ArrowUp'])
        await page.keyboard.press(k);
      await page.keyboard.press('/');
      await page.keyboard.type('gts rate/limit jk', { delay: 10 });
      await page.keyboard.press('Enter');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('feat');
      await page.keyboard.press('Escape'); // 清掉搜尋
      await eventually(() => searchInput().inputValue(), '', 'search cleared');
      await page.keyboard.press('Escape'); // 關詳情（如果有）
      await sleep(300);
      assert.deepStrictEqual(
        await keys(),
        [],
        'key events leaked out of the shadow host to the page',
      );
      assert.equal(await page.locator('.agg-panel').count(), 1);

      // 焦點掉到 overlay 外面（body）：按鍵一樣不能漏給頁面，而且焦點會被拉回 overlay
      await page.evaluate((id) => {
        document.getElementById(id).shadowRoot.activeElement?.blur();
        document.activeElement?.blur();
      }, HOST_ID);
      await page.keyboard.press('g');
      await sleep(200);
      assert.deepStrictEqual(
        await keys(),
        [],
        'keys typed while focus is outside the overlay leaked to the page',
      );
      assert.ok(
        await ui((r) => r.contains(r.getRootNode().activeElement)),
        'focus is pulled back into the overlay',
      );
      // 焦點在外面時 Esc 仍然能關閉 overlay，而且那個 keydown 也不會漏出去
      await page.evaluate((id) => {
        document.getElementById(id).shadowRoot.activeElement?.blur();
        document.activeElement?.blur();
      }, HOST_ID);
      await page.keyboard.press('Escape');
      await page.locator('.agg-panel').waitFor({ state: 'detached' });
      assert.ok(
        !(await keys()).some((k) => k.startsWith('keydown') || k.startsWith('keypress')),
        `leaked: ${await keys()}`,
      );
      // 關閉之後頁面又看得到按鍵
      await page.locator('.agg-fab').waitFor();
      await page.locator('body').click({ position: { x: 5, y: 200 } });
      await page.evaluate(() => (window.__keys.length = 0));
      await page.keyboard.press('g');
      await eventually(
        async () => (await keys()).includes('keydown:g'),
        true,
        'page hotkeys work again after closing',
      );
    },
  );

  await step('second open is served from cache; refresh button forces a re-fetch', async () => {
    await openOverlay();
    // 先強制重抓一次：快取時間重新計算，下面的快取斷言不受執行時間影響。要等到 API 請求完全停下來才往下
    const first = seen.paths.length;
    await page.getByRole('button', { name: L.refresh }).click();
    await waitUntil(() => seen.paths.length > first, 15_000, 'forced refresh reaches the API');
    await quiet(700);
    await closeOverlay();
    const before = seen.paths.length;
    await page.locator('.agg-fab').click();
    await page.locator('.agg-canvas canvas').waitFor();
    await page.locator('.agg-commit').first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(seen.paths.length, before, 'expected a cache hit (no new API requests)');
    await page.getByRole('button', { name: L.refresh }).click();
    await waitUntil(() => seen.paths.length > before, 15_000, 'refresh re-fetches');
    await page.locator('.agg-canvas canvas').waitFor();
    await page.locator('.agg-commit').first().waitFor();
    await quiet(700);
    await closeOverlay();
  });

  await step('night theme follows GitHub color mode and still paints the graph', async () => {
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'dark'));
    await page.locator('.agg-fab').click();
    await page.locator('.agg-root[data-theme="night"]').waitFor();
    await page.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: REPLAY_TIMEOUT });
    await panelSettled();
    const night = await ui((r) => getComputedStyle(r.querySelector('.agg-main')).backgroundColor);
    assert.notEqual(night, 'rgb(255, 253, 247)', 'the list card uses the night colours');
    await assertGraphSync('night');
    await shot(page, '9-night.png');
    await closeOverlay();
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'light'));
    await page.locator('.agg-fab').click();
    await page.locator('.agg-root[data-theme="day"]').waitFor();
    await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
    await closeOverlay();
  });

  await step('SPA navigation: error states (404 / rate limit) are friendly', async () => {
    await page.evaluate(() => history.pushState({}, '', '/ghost/missing'));
    await page.waitForTimeout(2000); // repoStore polling
    await page.locator('.agg-fab').click();
    await page.locator('.agg-center[role="alert"]').waitFor();
    assert.equal(
      await page.locator('.agg-scroll').count(),
      0,
      'no stale list behind the error panel',
    );
    assert.equal(await page.locator('.agg-commit').count(), 0, "never show another repo's commits");
    await page.waitForTimeout(700);
    await shot(page, '10-error-404.png');
    // 錯誤畫面裡鍵盤仍然可用：Esc 關閉 overlay
    await page.keyboard.press('Escape');
    await page.locator('.agg-panel').waitFor({ state: 'detached' });

    await page.evaluate(() => history.pushState({}, '', '/limited/repo'));
    await page.waitForTimeout(2000);
    await page.locator('.agg-fab').click();
    await page.locator('.agg-center[role="alert"]').waitFor();
    const text = await page.locator('.agg-center').innerText();
    assert.match(text, /60/);
    // 錯誤畫面仍有標題列的按鈕；重新整理 = 再試一次（仍然是錯誤）
    const before = seen.paths.length;
    await page.getByRole('button', { name: L.refresh }).click();
    await waitUntil(() => seen.paths.length > before, 10_000, 'retry hits the API');
    await page.locator('.agg-center[role="alert"]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.agg-panel').waitFor({ state: 'detached' });
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
    await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
    // 再按一次工具列圖示 = 關閉
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    });
    await page.locator('.agg-panel').waitFor({ state: 'detached' });
    await page.locator('.agg-fab').waitFor();
  });

  await step(
    'settings button opens the options page; token is sent only as a Bearer header and never leaks',
    async () => {
      await page.locator('.agg-fab').click();
      await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
      // 從 overlay 的設定按鈕開（真實流程：background 的 openOptionsPage）
      const [opt] = await Promise.all([
        ctx.waitForEvent('page'),
        page.getByRole('button', { name: L.settings }).click(),
      ]);
      await opt.waitForLoadState();
      assert.equal(opt.url(), `chrome-extension://${extId}/options.html`);
      await opt.locator('input[type="password"]').fill('github_pat_e2e_secret');
      await opt.getByRole('button', { name: /^(儲存|Save)$/ }).click();
      await opt.locator('output', { hasText: /✓/ }).waitFor();
      await shot(opt, '11-options.png');
      await opt.getByRole('button', { name: /(測試|Test)/ }).click();
      await opt.locator('output', { hasText: /42/ }).waitFor();
      await opt.close();
      await page.bringToFront();
      await closeOverlay();

      seen.auth.length = 0;
      await page.evaluate((u) => history.pushState({}, '', new URL(u).pathname), REPO_URL);
      await page.waitForTimeout(2000);
      await page.locator('.agg-fab').click();
      await page.locator('.agg-canvas canvas').waitFor();
      await page.locator('.agg-commit').first().waitFor({ timeout: 30_000 });
      assert.equal(await page.locator('.agg-commit').count(), SPECS.length);
      assert.ok(seen.auth.length > 0, 'expected authorised requests');
      assert.ok(seen.auth.every((a) => a === 'Bearer github_pat_e2e_secret'));
      // 選一個 commit、開詳情、搜尋：token 不能出現在頁面 DOM（含 shadow tree）、URL 或剪貼簿以外的任何地方
      await clickRow('m5');
      await page.locator('.agg-detail').waitFor();
      await page.evaluate(() => (window.__aggDom = 1));
      const html = await page.content();
      const shadowHtml = await page.evaluate(
        (id) => document.getElementById(id).shadowRoot.innerHTML,
        HOST_ID,
      );
      assert.ok(shadowHtml.includes('agg-detail'), 'the shadow tree was really inspected');
      assert.ok(!html.includes('github_pat_e2e_secret'), 'token must never reach the page DOM');
      assert.ok(
        !shadowHtml.includes('github_pat_e2e_secret'),
        'token must never reach the shadow DOM',
      );
      assert.ok(!page.url().includes('github_pat'), 'token must never appear in the page URL');
      assert.ok(
        seen.paths.every((p) => !p.includes('github_pat')),
        'token must never appear in a URL',
      );
      const resources = await page.evaluate(() =>
        performance.getEntriesByType('resource').map((e) => e.name),
      );
      assert.ok(
        resources.every((u) => !u.includes('github_pat')),
        'token must never appear in a resource URL',
      );
      await closeOverlay();
    },
  );

  // ───────────── 更早的歷史（infinite scroll） ─────────────
  // demo/long-history（見 mock 的 LONG）：每條 branch 只抓一頁（25 筆）時，第一批只有最新的一段，
  // 其餘要捲到底、由 content script → background 的 fetch-more 從 missing parent 往回抓（/commits?sha=<40 位 hex>）。

  const LONG_URL = `https://github.com/${LONG.owner}/${LONG.name}`;
  const LONG_PER_PAGE = 25;
  const longSpecs = LONG.specs.map(([id, parents, , , hours]) => ({
    id,
    sha: sha(id),
    parents: parents.map(sha),
    hours,
  }));
  const longBySha = new Map(longSpecs.map((s) => [s.sha, s]));
  /** 全部載入之後畫面上由上到下的 sha（時間都不同，直接依時間倒序）。 */
  const LONG_ROWS = [...longSpecs].sort((a, b) => b.hours - a.hours).map((s) => s.sha);
  const isMoreRequest = (p) =>
    p.startsWith(`/repos/${LONG.owner}/${LONG.name}/commits?`) && /[?&]sha=[0-9a-f]{40}\b/.test(p);
  /** 從 seen.paths 的第 `from` 筆之後，「從 commit sha 往回抓」的請求。 */
  const moreRequests = (from) =>
    seen.paths
      .slice(from)
      .filter(isMoreRequest)
      .map((p) => {
        const q = new URL(p, 'http://x').searchParams;
        return { sha: q.get('sha'), per: q.get('per_page') };
      });
  const footerNow = () =>
    ui((r) => {
      const f = r.querySelector('.agg-footer');
      return { state: f.dataset.state, text: f.innerText.trim() };
    });
  const rowShas = () =>
    ui((r) => [...r.querySelectorAll('.agg-commit')].map((el) => el.dataset.sha));
  /** 某一列相對於捲動容器上緣的位置（沒指定就取第一個完整可見的列）＋目前的 scrollTop。 */
  const rowAnchor = (shaHex) =>
    ui((r, want) => {
      const sc = r.querySelector('.agg-scroll');
      const top = sc.getBoundingClientRect().top;
      const els = [...r.querySelectorAll('.agg-commit')];
      const el = want
        ? els.find((e) => e.dataset.sha === want)
        : els.find((e) => e.getBoundingClientRect().top >= top - 0.5);
      return {
        sha: el.dataset.sha,
        offset: el.getBoundingClientRect().top - top,
        scrollTop: sc.scrollTop,
      };
    }, shaHex);
  /** 頁尾連續 `ms` 毫秒都不是 loading（一批載入回來之後，頁尾仍在附近時會馬上接著載下一批，要等整串都停下來）。 */
  async function footerSettled(ms = 1500, timeout = 60_000) {
    const t = Date.now();
    let since = Date.now();
    for (;;) {
      const f = await footerNow();
      if (f.state === 'loading') since = Date.now();
      else if (Date.now() - since >= ms) return f;
      if (Date.now() - t > timeout) assert.fail(`the footer kept loading: ${JSON.stringify(f)}`);
      await sleep(100);
    }
  }
  const setPerPage = (per) =>
    sw.evaluate(async (n) => {
      const cur = (await chrome.storage.local.get('settings')).settings ?? {};
      await chrome.storage.local.set({ settings: { ...cur, maxCommitsPerBranch: n } });
    }, per);

  await step(
    'infinite scroll: scrolling to the bottom loads older commits page by page (no jump, no replay, graph in sync)',
    async () => {
      await closeOverlay();
      const saved = await sw.evaluate(
        async () => (await chrome.storage.local.get('settings')).settings ?? null,
      );
      await setPerPage(LONG_PER_PAGE);
      try {
        const from = seen.paths.length;
        // GitHub 是 SPA：同一個文件裡換到另一個 repo（content script 偵測網址變化）
        await page.evaluate((p) => history.pushState({}, '', p), new URL(LONG_URL).pathname);
        await page.waitForTimeout(2000); // repoStore polling
        await openOverlay({ replay: true });
        assert.equal(await page.locator('.agg-title-text').innerText(), 'demo/long-history');
        // 第一批：每條 branch 一頁（設定的 25 筆）
        const branchReqs = seen.paths
          .slice(from)
          .filter((p) => p.startsWith(`/repos/demo/${LONG.name}/commits?`) && !isMoreRequest(p));
        assert.deepStrictEqual(
          branchReqs.map((p) => new URL(p, 'http://x').searchParams.get('per_page')),
          branchReqs.map(() => String(LONG_PER_PAGE)),
          `the first batch uses the per-branch page size: ${branchReqs}`,
        );
        // 第一頁不夠填滿「可視範圍 + 1.5 個視窗高」時會直接接著載入（不用捲動）；起點一定是 main 第一頁之前的 L123
        let f = await footerSettled();
        assert.equal(f.state, 'idle', `more history can be loaded: ${JSON.stringify(f)}`);
        const auto = moreRequests(from);
        if (auto.length)
          assert.equal(auto[0].sha, sha('L123'), 'the first start is the missing parent');
        const opened = (await rowShas()).length;
        assert.ok(opened < LONG.total, `only part of the history is loaded at first (${opened})`);
        console.log(
          `  opened with ${opened} rows (${auto.length} start(s) auto-loaded before scrolling)`,
        );

        // 場景不能重播（data-replay 不會再變成 playing）；捲動容器不能被重建
        await page.evaluate((id) => {
          const sr = document.getElementById(id).shadowRoot;
          const cv = sr.querySelector('.agg-canvas');
          window.__aggReplayLog = [];
          new MutationObserver(() => window.__aggReplayLog.push(cv.dataset.replay)).observe(cv, {
            attributes: true,
            attributeFilter: ['data-replay'],
          });
          sr.querySelector('.agg-scroll').__aggSame = true;
        }, HOST_ID);

        let batches = 0;
        let failed = false;
        for (let i = 0; i < 15; i++) {
          f = await footerSettled();
          if (f.state === 'end') break;
          assert.equal(f.state, 'idle', `footer before batch ${batches + 1}: ${JSON.stringify(f)}`);
          if (batches > 0) assert.match(f.text, L.loadedMore, 'the footer reports the last batch');
          const before = await rowShas();
          const reqFrom = seen.paths.length;
          const injectFailure = batches === 1 && !failed;
          if (injectFailure) faults.more = 1;
          // 這一批的請求先擋在 mock 裡：量「載入中」的頁尾與畫面位置時，那一批一定還沒回來
          gate.hold = true;

          if (batches === 0) {
            // 第一次用真的滾輪捲到底
            const box = await page.locator('.agg-scroll').boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            for (let k = 0; k < 30; k++) {
              const g = await geom();
              if (g.scrollTop >= g.maxScroll - 1) break;
              await page.mouse.wheel(0, 1500);
              await sleep(60);
            }
          } else {
            await scrollTo(1e6);
          }
          await page.locator('.agg-footer[data-state="loading"]').waitFor({ timeout: 10_000 });
          await waitUntil(() => gate.queue.length > 0, 20_000, 'the batch request reaches the API');
          await scrollSettled();
          const anchor = await rowAnchor();
          assert.equal((await rowShas()).length, before.length, 'the batch is still on hold');
          if (batches === 0) {
            assert.match((await footerNow()).text, L.loadingMore, 'the footer says it is loading');
            await shot(page, '12-infinite-scroll-loading.png');
          }
          releaseHeld();

          if (injectFailure) {
            await page.locator('.agg-footer[data-state="error"]').waitFor({ timeout: 30_000 });
            assert.match((await footerNow()).text, L.loadMoreFailed);
            const n = moreRequests(reqFrom).length;
            await sleep(2500);
            assert.equal(
              moreRequests(reqFrom).length,
              n,
              'a failed batch is never retried automatically',
            );
            assert.deepStrictEqual(await rowShas(), before, 'a failed batch changes nothing');
            await shot(page, '12-infinite-scroll-error.png');
            await page.locator('.agg-footer').getByRole('button', { name: L.retry }).click();
            failed = true;
          }

          await eventually(
            async () => (await rowShas()).length > before.length,
            true,
            `batch ${batches + 1} adds rows`,
            60_000,
          );
          await footerSettled();
          const after = await rowShas();
          assert.deepStrictEqual(
            after.slice(0, before.length),
            before,
            'older commits are appended below; the existing rows keep their order',
          );
          // 每個請求都是「已載入的 commit 的 parent、本身還沒載入」，每頁筆數 = 設定值
          const reqs = moreRequests(reqFrom);
          assert.ok(reqs.length > 0, 'the batch was fetched from commit shas');
          for (const r of reqs) {
            assert.equal(r.per, String(LONG_PER_PAGE), 'per_page follows the setting');
            assert.ok(!before.includes(r.sha), `start ${r.sha} was not loaded yet`);
            assert.ok(after.includes(r.sha), `start ${r.sha} is loaded by its own page`);
            assert.ok(
              after.some((s) => longBySha.get(s).parents.includes(r.sha)),
              `start ${r.sha} is a parent of a loaded commit`,
            );
          }
          // 畫面沒有跳：同一列還在同一個位置
          const now = await rowAnchor(anchor.sha);
          assert.ok(
            Math.abs(now.offset - anchor.offset) <= 1 &&
              Math.abs(now.scrollTop - anchor.scrollTop) <= 1,
            `the view jumped: ${JSON.stringify(anchor)} → ${JSON.stringify(now)}`,
          );
          assert.equal(await page.locator('.agg-canvas').getAttribute('data-replay'), 'done');
          await assertGraphSync(`after batch ${batches + 1}`);
          batches++;
        }

        f = await footerSettled();
        assert.equal(f.state, 'end', `all history loaded: ${JSON.stringify(f)}`);
        assert.match(f.text, L.startOfHistory, 'the footer marks the start of history');
        assert.ok(failed, 'the failure / retry path was exercised');
        assert.ok(batches >= 2, `several scroll-triggered batches (${batches})`);
        assert.deepStrictEqual(await rowShas(), LONG_ROWS, 'every commit, newest first');
        const replayLog = await page.evaluate(() => window.__aggReplayLog);
        assert.ok(!replayLog.includes('playing'), `the scene replayed: ${replayLog}`);
        assert.ok(
          await ui((r) => r.querySelector('.agg-scroll').__aggSame === true),
          'the scroller was not re-created',
        );
        // 往回載入之後，指向舊 commit 的 tag 也出現了（畫面外的列有 content-visibility: auto，innerText 是空的，所以讀 textContent）
        const tagsAt = (id) => rowLoc(id).locator('.agg-ref--tag .agg-ref-name').allTextContents();
        assert.deepStrictEqual(await tagsAt('L40'), ['v1.0']);
        assert.deepStrictEqual(await tagsAt('L148'), ['v2.0']);
        const chips = await page.locator('.agg-stats .agg-chip').allInnerTexts();
        assert.match(chips[0], new RegExp(`^${LONG.total} commits?|^${LONG.total} 個`));
        await scrollTo(1e6);
        await assertGraphSync('end of history');
        await shot(page, '12-infinite-scroll-end.png');
        // 到底之後不會再發請求
        const total = moreRequests(from).length;
        await scrollTo(1e6 - 1);
        await sleep(1500);
        assert.equal(moreRequests(from).length, total, 'no requests after the start of history');
        console.log(
          `  ${batches} scroll-triggered batch(es), ${total} sha= request(s), ${LONG.total} rows`,
        );

        // 重新整理 = 回到第一批
        await scrollTo(0);
        await page.getByRole('button', { name: L.refresh }).click();
        await eventually(
          async () => (await rowShas()).length < LONG.total,
          true,
          'refresh goes back to the first batch',
          30_000,
        );
        f = await footerSettled();
        assert.equal(
          f.state,
          'idle',
          `after a refresh more history can be loaded again: ${f.state}`,
        );
      } finally {
        faults.more = 0;
        releaseHeld();
        await sw.evaluate(async (s) => {
          if (s) await chrome.storage.local.set({ settings: s });
          else await chrome.storage.local.remove('settings');
        }, saved);
      }
      await closeOverlay();
      await page.evaluate((u) => history.pushState({}, '', new URL(u).pathname), REPO_URL);
      await page.waitForTimeout(2000);
      await page.locator('.agg-fab').waitFor({ timeout: 10_000 });
    },
  );

  await step('no uncaught page errors or console errors in any tab', async () => {
    assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join('\n')}`);
  });

  console.log(`\nAll ${results.length} e2e steps passed. Screenshots → ${artifacts}`);
} catch (err) {
  console.error('\n✘ e2e failed:', err);
  if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  try {
    if (page && !page.isClosed()) await shot(page, 'failure.png');
  } catch {
    /* 截圖失敗不影響結果 */
  }
  process.exitCode = 1;
} finally {
  await ctx.close();
  mock.close();
}
