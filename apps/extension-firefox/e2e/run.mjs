// End-to-end：用「真正的 Firefox」載入打包後的 MV3 extension，對 mock GitHub API + 本機假的 github 頁面驗證整條流程，
// 並把截圖輸出到 e2e/.artifacts。
//   用法：pnpm e2e     環境變數：FIREFOX_PATH 指定 Firefox；沒有找到 Firefox 時，一般情況只提示並略過，
//                       設了 CI 或 REQUIRE_FIREFOX 則視為失敗。WebGL 需要 Xvfb（或自行用 xvfb-run 包起來）。
//                       除錯用：E2E_ONLY=<regex> 只跑名稱符合的步驟（步驟之間不互相依賴，各自會先打開 overlay / 回到乾淨狀態）。
//
// viewer 是「垂直捲動的 git log 清單」：每一列是一個 commit（.agg-commit），WebGL 線圖是一張貼在捲動內容裡的 canvas
// （.agg-log > .agg-canvas，只畫可視範圍加上下緩衝的視窗，會跟著捲動重新定位）。涵蓋：
//   - FAB / overlay / 真的有畫出 WebGL（graph 欄位的深色描邊像素）/ 夜間主題 / 404 與 rate limit 錯誤畫面 / 快取與強制重抓 / 設定頁與 token 不外洩
//   - 列的 git 資訊：順序、短 sha、作者、日期、branch / tag 徽章、merge 標籤、conventional type 標籤、統計 chips
//   - 捲動與線圖同步：捲到多個位置後截圖，在每一列 node 中心取樣像素（要明顯異於卡片底色）、每一列的 graph 欄位不能是空白，
//     短視窗下捲動距離超過 canvas 緩衝時視窗（data-win-top）必須重新置中
//   - 鍵盤（j/k/方向鍵/Home/End、/）、搜尋（淡化、計數、Enter 逐筆跳、IME 不觸發）、branch 聚焦
//   - 詳情面板（內容、上一個 / 下一個 / parent 連結、在 GitHub 開啟的新分頁、複製 SHA（真的讀剪貼簿）、關閉後鍵盤焦點）
//   - RWD：wide / medium / narrow（無橫向溢位、窄螢幕底部面板不蓋住選取列、寬螢幕詳情不壓到列表、欄位標題對齊）
//   - 重新整理會保留捲動 / 選取（同一個 scroller 不被重建）、Esc 一次收一層、overlay 開著時背後頁面不能捲動（捲軸位置保留、
//     頁面 inert、Tab 走不進去、換掉 <body> 後仍然 inert）、鍵盤事件不會漏給 GitHub 頁面（shadow host 擋下）、點背景關閉
//   - Firefox 專屬：真正的工具列按鈕（action.onClicked → tabs.sendMessage）開關 overlay、沒有 content script 的分頁顯示 "!" 徽章、
//     設定頁（特權的 moz-extension:// 頁面）與 token、event page 被終止後由下一個請求喚醒、extension 自己的 console 錯誤
//   - 更早的歷史（infinite scroll，demo/long-history、每條 branch 一頁 25 筆）：捲到底就從 missing parent 往回載入下一批
//     （sha=<40 位 hex> 的請求，由 event page 代抓）、列只接在後面、畫面不跳、場景不重播、線圖保持同步、
//     頁尾的 載入中 / 失敗→再試一次 / 歷史起點
//
// Firefox 的限制（見 firefox.mjs 的說明）：moz-extension:// 頁面不能截圖 / 不接受真實輸入，所以設定頁用 JS 操作；
// 頁面由本機假的 github 伺服器（127.0.0.1）提供，e2e 版 manifest 額外比對 http://127.0.0.1/*；
// 外部網址（commit 頁）會被封閉網路擋成 about:neterror，網址由 realUrl() 還原後檢查。
// 注意：WebGL 走 Mesa 軟體繪圖，CPU 吃緊時很慢，所以全部以「等狀態」為主、timeout 開得很寬。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GECKO_ID } from '@adorable/extension-core/manifest';
import { startFakeGithub } from '../../../tools/e2e/fake-github-page.mjs';
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
import { colorDistance, inkRatio, samplePixels } from '../../../tools/e2e/pixels.mjs';
import {
  backgroundControl,
  backgroundHandle,
  chord,
  clickExtByText,
  clickToolbarButton,
  extensionConsoleErrors,
  fillExt,
  findFirefox,
  launchFirefox,
  newTabFrom,
  openExtensionPage,
  readClipboard,
  shadowKit,
  startXvfb,
  waitForTabUrl,
  writeClipboard,
} from './firefox.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(root, 'e2e/.artifacts');
const extDir = resolve(artifacts, 'extension');
/** 固定 extension 的內部 uuid（透過 pref），才能直接開 moz-extension://<uuid>/options.html */
const EXT_UUID = '8d6f1c2e-4b7a-4c1e-9a3d-2f5e7b9c0a11';
const HOST_ID = 'adorable-git-graph-host';

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

// ───────────────────────── helpers ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (cond, timeout = 20_000, what = 'condition') => {
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// mock 也會服務頭像 SVG；「有沒有打 GitHub API」只算 /repos 與 /rate_limit
const apiCalls = () =>
  seen.paths.filter((p) => p.startsWith('/repos') || p.startsWith('/rate_limit')).length;
/** GitHub API 的請求數量連續 `ms` 毫秒沒有增加（背景的抓取已經結束）。 */
const quiet = async (ms) => {
  let last = -1;
  let since = Date.now();
  for (;;) {
    if (apiCalls() !== last) {
      last = apiCalls();
      since = Date.now();
    } else if (Date.now() - since >= ms) return;
    await sleep(100);
  }
};

const results = [];
const errors = [];
const only = process.env['E2E_ONLY'] ? new RegExp(process.env['E2E_ONLY'], 'i') : null;
const step = async (name, fn) => {
  if (only && !only.test(name)) return;
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

// 軟體 WebGL 很慢：replay 在 CPU 吃緊時可能超過 1 分鐘
const REPLAY_TIMEOUT = 150_000;

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
let page;
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

  /** 空白分頁：用來解碼截圖（WebGL canvas 無法直接讀回，只能看截圖）。 */
  const decoder = await browser.newPage();
  await decoder.goto('about:blank');
  /** 假 github 頁面（content script 所在的分頁）。 */
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  // ── Shadow DOM（open）內的查詢 / 操作：content script 的畫面都在 #adorable-git-graph-host 裡 ──
  // ui(fn, ...args)：fn 的第一個參數是 .agg-root（shadow DOM 裡），window / document 是頁面的。
  const { shadow, ui, exists, count, textOf, text, waitFor, waitGone, find, click } =
    shadowKit(page);
  const replayDone = () => waitFor('.agg-canvas[data-replay="done"]', REPLAY_TIMEOUT);
  const snap = async (opts) => Buffer.from(await page.screenshot(opts));
  const shot = (name, p = page) => p.screenshot({ path: resolve(artifacts, name) });
  // （ui 的第一個參數就是 .agg-root 本身，querySelector 找不到它自己，所以先用 matches 判斷）
  const box = (sel) =>
    ui((r, s) => {
      const b = (r.matches(s) ? r : r.querySelector(s)).getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }, sel);
  const rect = (sel) =>
    ui((r, s) => {
      const b = (r.matches(s) ? r : r.querySelector(s)).getBoundingClientRect();
      return { l: b.left, t: b.top, r: b.right, b: b.bottom };
    }, sel);
  const chipTexts = () =>
    ui((r) => [...r.querySelectorAll('.agg-stats .agg-chip')].map((e) => e.textContent));

  // 圖示按鈕（aria-label，zh / en 都認）
  const button = (label) => click('button[aria-label]', label, 'aria-label');
  const buttonCount = (label) =>
    shadow(
      (sr, src) =>
        [...sr.querySelectorAll('button[aria-label]')].filter((b) =>
          new RegExp(src).test(b.getAttribute('aria-label')),
        ).length,
      label.source,
    );
  const buttonDisabled = (label) =>
    shadow((sr, src) => {
      const b = [...sr.querySelectorAll('button[aria-label]')].find((x) =>
        new RegExp(src).test(x.getAttribute('aria-label')),
      );
      return b ? b.disabled : null;
    }, label.source);

  /** 該元素的 CSS 動畫都結束了（量位置之前先等，不然會量到滑入途中的位置）。 */
  const animationsSettled = (sel) =>
    shadow(
      (sr, s) =>
        Promise.all(
          (sr.querySelector(s)?.getAnimations() ?? []).map((a) => a.finished.catch(() => {})),
        ).then(() => true),
      sel,
    );
  const panelSettled = () => animationsSettled('.agg-panel');
  const detailSettled = () => animationsSettled('.agg-detail');

  /** 等兩個 frame + 一小段時間，並把滑鼠停到背景（避免列的 hover 底色 / node 放大干擾像素）。 */
  const settle = async (ms = 200) => {
    await page.mouse.move(4, 4);
    // 分頁在背景時 rAF 不會跑：最多等 1 秒
    await page.evaluate(() =>
      Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((r) => setTimeout(r, 1000)),
      ]),
    );
    await sleep(ms);
  };

  /**
   * 記錄元素某個屬性每次變化時的「屬性值|文字|title」（例如「已複製」只會出現 1.3 秒，輪詢可能剛好漏掉）。
   * 讀取用 attrLog(key)。
   */
  const watchAttr = (sel, attr, key) =>
    shadow(
      (sr, s, a, k) => {
        const el = sr.querySelector(s);
        window[k] = [];
        new MutationObserver(() => {
          window[k].push(
            `${el.getAttribute(a)}|${el.textContent.trim()}|${el.getAttribute('title')}`,
          );
        }).observe(el, { attributes: true, attributeFilter: [a] });
      },
      sel,
      attr,
      key,
    );
  const attrLog = (key) => page.evaluate((k) => window[k] ?? [], key);

  async function openOverlay({ replay = false } = {}) {
    await page.bringToFront();
    if (!(await exists('.agg-panel'))) {
      await waitFor('.agg-fab');
      await click('.agg-fab');
    }
    await waitFor('.agg-panel');
    await waitFor('.agg-commit', 30_000);
    await waitFor('.agg-canvas canvas');
    await panelSettled();
    if (replay) await replayDone();
  }
  const gotoRepo = async () => {
    await page.goto(REPO_URL);
    await waitFor('.agg-fab');
  };

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
  const focusViewer = () => click('.agg-title-text');
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
  /** 回到乾淨的初始狀態：overlay 開著、沒有詳情 / 搜尋 / branch 聚焦、捲到最上面、焦點在 viewer。 */
  async function resetView() {
    await openOverlay({ replay: true }); // 剛打開時線圖還在重播（node 一個一個彈出來），要等它播完才能取樣像素
    await clearLayers();
    await scrollTo(0);
    await focusViewer();
    await settle(50);
  }
  async function closeOverlay() {
    if (!(await exists('.agg-panel'))) return;
    await clearLayers();
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');
    await waitFor('.agg-fab');
  }

  const rowSel = (id) => `.agg-commit[data-sha="${sha(id)}"]`;
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
  const clickRow = (id) => click(`${rowSel(id)} .agg-subject`);
  const searchValue = () => ui((r) => r.querySelector('.agg-search input').value);
  const searchCount = () => text('.agg-search-count');
  const focusSearch = () => ui((r) => r.querySelector('.agg-search input').focus());
  /** 真的用鍵盤把搜尋框的內容換成 q（全選再打字；q 為空就刪除）。 */
  const fillSearch = async (q) => {
    await focusSearch();
    await chord(page, ['Control'], 'a');
    if (q) await page.keyboard.type(q);
    else await page.keyboard.press('Backspace');
  };
  const detailSubject = () => text('.agg-detail-subject');
  const branchChip = (name) => click('.agg-branch', new RegExp(esc(name)));
  const pressedBranches = () =>
    ui((r) =>
      [...r.querySelectorAll('.agg-branch')]
        .filter((e) => e.getAttribute('aria-pressed') === 'true')
        .map((e) => e.querySelector('.agg-branch-name').textContent),
    );
  /** 輸入法選字中的按鍵（keyCode 229 / isComposing）：不是快捷鍵。 */
  const composing = (selector, keys) =>
    ui(
      (r, s, ks) => {
        const target = s ? r.querySelector(s) : r;
        for (const key of ks)
          target.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              keyCode: 229,
              isComposing: true,
              bubbles: true,
              composed: true,
            }),
          );
      },
      selector,
      keys,
    );

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
  async function graphSyncOnce(label) {
    await settle();
    const g = await geom();
    const png = await snap();
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
    const bands = full.map((r) => ({
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
  /**
   * WebGL 的畫面是非同步送到合成器的：重新定位 canvas 視窗之後，截圖偶爾會晚一個 frame 才看到新內容。
   * 所以失敗時隔一下再截一次（最多 4 次）；真的不同步（持續空白 / 位置錯）還是會失敗，重試會印出來。
   */
  async function assertGraphSync(label) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await graphSyncOnce(label);
        if (attempt > 0) console.log(`  (graph sync "${label}" passed on retry ${attempt})`);
        return r;
      } catch (err) {
        if (!(err instanceof assert.AssertionError)) throw err;
        lastErr = err;
        await sleep(500);
      }
    }
    throw lastErr;
  }

  await gotoRepo();

  // ───────────────────────── 測試 ─────────────────────────

  await step('FAB appears on a repo page and not on a profile page', async () => {
    await page.goto(`${GH}/demo`);
    await sleep(800);
    assert.equal(
      await page.evaluate((id) => document.getElementById(id) !== null, HOST_ID),
      true,
      'the content script must be loaded (shadow host present) on a user page too',
    );
    assert.equal(await exists('.agg-fab'), false, 'FAB must not render on a user page');
    await gotoRepo();
  });

  await step('opens the overlay; the replay plays and finishes under real WebGL', async () => {
    await click('.agg-fab');
    await waitFor('.agg-panel');
    await waitFor('.agg-canvas canvas');
    assert.equal(await textOf('.agg-title-text'), 'demo/adorable-git-graph');
    const chips = await chipTexts();
    assert.match(chips[0], new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
    assert.equal(await exists('.agg-fab'), false, 'the FAB is replaced by the overlay while open');
    await panelSettled();
    await shot('1-replay-start.png');
    const t = Date.now();
    await sleep(1500);
    await shot('1-replay-mid.png');
    await replayDone();
    console.log(`  replay finished after ${Date.now() - t + 1500}ms (software GL)`);
    await settle(1000);
    await shot('2-overview.png');
  });

  await step(
    'WebGL really painted: ink pixels in the graph column of the visible rows',
    async () => {
      await resetView();
      await settle(400);
      const g = await geom();
      const png = await snap({
        clip: { x: g.log.l, y: g.sc.t, width: g.graphW, height: g.sc.b - g.sc.t },
      });
      // graph 欄位（.agg-c-g）在 DOM 裡是空的，所以裡面的深色描邊像素只可能來自 WebGL canvas
      const ratio = await inkRatio(decoder, png);
      console.log('  ink pixel ratio in the graph column:', ratio.toFixed(4));
      assert.ok(
        ratio > 0.01,
        `graph column looks empty (ink ratio ${ratio}) — is WebGL available?`,
      );
      assert.equal(await exists('.agg-center[role="alert"]'), false, 'no error panel may be shown');
      // 沒有任何 DOM 東西畫在 graph 欄位：右邊緣一條沒有 node 的帶子應該完全沒有墨水
      const edge = await snap({
        clip: { x: g.log.l + g.graphW - 6, y: g.sc.t, width: 5, height: g.sc.b - g.sc.t },
      });
      assert.equal(await inkRatio(decoder, edge), 0, 'unexpected ink right of the last lane');
    },
  );

  await step(
    'rows show git info: order, short sha, author, date, refs, merge pills, type chips',
    async () => {
      await resetView();
      const rows = await ui((r) =>
        [...r.querySelectorAll('.agg-commit')].map((el) => ({
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
      const chips = await chipTexts();
      assert.match(chips[0], new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
      assert.match(
        chips[1],
        new RegExp(`^${Object.keys(HEADS).length} branch|^${Object.keys(HEADS).length} 條`),
      );
      assert.match(chips.join('|'), /2 tags?|2 個 tag|2 個標籤/i);
      assert.match(chips.join('|'), /3 authors?|3 位/i);
      assert.match(chips.join('|'), /2 merges?|2 個合併|2 次合併|2 個 merge/i);
      assert.equal(await count('.agg-chip--filter'), 0, 'no filter chip without a filter');
      const names = await ui((r) =>
        [...r.querySelectorAll('.agg-branch .agg-branch-name')].map((e) => e.textContent),
      );
      assert.deepStrictEqual([...names].sort(), Object.keys(HEADS).sort());
      // 列表本身是 listbox，footer 在最後
      assert.equal(await ui((r) => r.querySelector('.agg-scroll').getAttribute('role')), 'listbox');
      assert.equal(await count('.agg-footer'), 1);
      // 這一版沒有 Fit 按鈕、也沒有 tooltip
      assert.equal(await buttonCount(L.fit), 0, 'no Fit button');
      assert.equal(await count('.agg-tip'), 0, 'no tooltip element');
    },
  );

  await step('scroll keeps the WebGL graph in sync with the rows (tall viewport)', async () => {
    await resetView();
    const { g } = await assertGraphSync('scrollTop 0');
    assert.ok(g.maxScroll > 150, `the list must be scrollable (max ${g.maxScroll})`);
    await shot('3-scroll-0.png');
    for (const off of [123, Math.round(g.maxScroll / 2), g.maxScroll]) {
      await scrollTo(off);
      const r = await assertGraphSync(`scrollTop ${off}`);
      assert.ok(Math.abs(r.g.scrollTop - off) <= 1, `scrolled to ${off}, got ${r.g.scrollTop}`);
    }
    // 真的用滾輪（捲動鏈接 / overscroll 設定不能讓滾輪沒作用）
    await scrollTo(0);
    await settle();
    const b = await box('.agg-scroll');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel({ deltaY: 240 });
    await eventually(async () => (await scrollSettled()) > 100, true, 'wheel scrolls the list');
    await assertGraphSync('after wheel');
    await shot('3-scroll-wheel.png');
  });

  await step(
    'short viewport: the canvas window re-centres on a big scroll and stays in sync',
    async () => {
      await resetView();
      await page.setViewport({ width: 1440, height: 600 });
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
          if (off === 600) await shot('3-scroll-short-600.png');
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
        await page.setViewport({ width: 1440, height: 900 });
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
    await button(L.latest);
    await eventually(scrollSettled, 0, 'Jump to latest scrolls to the top');
    // 重播：data-replay 會先變 playing 再變 done（用 MutationObserver 記錄，不怕輪詢漏掉）
    const replayOnce = async (key) => {
      await watchAttr('.agg-canvas', 'data-replay', key);
      await button(L.replay);
      await waitUntil(
        async () => (await attrLog(key)).some((l) => l.startsWith('playing|')),
        8_000,
        'replay starts',
      );
      await replayDone();
      return (await attrLog(key)).map((l) => l.split('|')[0]);
    };
    assert.deepStrictEqual((await replayOnce('__aggReplay1')).slice(0, 2), ['playing', 'done']);
    await assertGraphSync('after the replay');
    // 捲到中間再重播：重播結束後線圖仍然要和列對齊（重播是在目前的捲動位置重畫，不是回到最上面）
    await scrollTo(250);
    await settle();
    assert.deepStrictEqual((await replayOnce('__aggReplay2')).slice(0, 2), ['playing', 'done']);
    await assertGraphSync('replay while scrolled');
    assert.ok(
      Math.abs((await scrollTopNow()) - 250) <= 2,
      'the replay must not move the scroll position',
    );
    for (const name of [L.refresh, L.settings, L.close]) {
      assert.equal(await buttonCount(name), 1, `header button ${name}`);
    }
    assert.equal(await buttonCount(L.fit), 0);
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
    assert.equal(await count('.agg-detail'), 1, 'selecting a row opens the detail');
    // 輸入法選字中的按鍵不是快捷鍵
    await composing(null, ['j', 'ArrowDown', 'End']);
    await sleep(300);
    assert.equal(await selectedRow(), 0, 'IME composition keys must not move the selection');

    // "/" 聚焦搜尋；在搜尋框裡打 j / k / / 不會被當成快捷鍵（選取不動）
    await focusViewer();
    await page.keyboard.press('/');
    await eventually(
      () => ui((r) => r.getRootNode().activeElement === r.querySelector('.agg-search input')),
      true,
      '"/" focuses the search box',
    );
    assert.equal(await searchValue(), '', '"/" itself must not be typed');
    await page.keyboard.type('jjkk/');
    assert.equal(await searchValue(), 'jjkk/');
    assert.equal(
      await selectedRow(),
      0,
      'typing j/k// in the search box must not move the selection',
    );
    await page.keyboard.press('Escape'); // 清掉搜尋文字
    await eventually(searchValue, '', 'Esc clears the search text');
    assert.equal(await count('.agg-panel'), 1, 'overlay stays open');
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
      const chips = await ui((r) =>
        [...r.querySelectorAll('.agg-stats .agg-chip')].map((e) => ({
          text: e.textContent,
          filter: e.classList.contains('agg-chip--filter'),
        })),
      );
      assert.ok(chips[0].filter, 'the filter chip comes first');
      assert.match(chips[0].text, new RegExp(`${hits.length}.*${SPECS.length}`), 'Showing 3 of 22');
      assert.match(chips[1].text, new RegExp(`^${SPECS.length} commits?|^${SPECS.length} 個`));
      await shot('4-search.png');

      // Enter：選第一筆符合的、開詳情、把它捲進畫面
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('m7'), 'Enter selects the first match');
      assert.equal(await searchCount(), `1 / ${hits.length}`);
      await waitFor('.agg-detail');
      assert.equal(await detailSubject(), specById.get('m7').msg);
      await waitUntil(() => rowInView(rowOf('m7')), 10_000, 'match scrolled into view');
      // 跳到的那一筆會被置中（這一筆離頭尾夠遠，不會被捲動範圍夾住）。smooth scroll 在軟體 WebGL 忙碌時可能晚幾百毫秒才開始，
      // 所以等「到位」而不是等「停下來」（它一開始就在畫面內，rowInView 與「捲動靜止」都會過早成立）
      const centreOff = (n) =>
        ui((r, n) => {
          const sc = r.querySelector('.agg-scroll').getBoundingClientRect();
          const b = r.querySelector(`.agg-commit[data-row="${n}"]`).getBoundingClientRect();
          return (b.top + b.bottom) / 2 - (sc.top + sc.bottom) / 2;
        }, n);
      let off = Number.NaN;
      await waitUntil(
        async () => Math.abs((off = await centreOff(rowOf('m7')))) <= 3,
        10_000,
        'the match is centred in the list',
      ).catch((err) => {
        throw new Error(`${err.message} (last offset from the centre: ${off}px)`);
      });
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('x2'), 'Enter steps to the next match');
      assert.equal(await searchCount(), `2 / ${hits.length}`);
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('x1'), 'third match');
      await page.keyboard.press('Enter');
      await eventually(selectedRow, rowOf('m7'), 'Enter wraps around');
      await chord(page, ['Shift'], 'Enter');
      await eventually(selectedRow, rowOf('x1'), 'Shift+Enter steps back (wraps)');
      assert.equal(await searchCount(), `3 / ${hits.length}`);
      await button(L.nextMatch);
      await eventually(selectedRow, rowOf('m7'), 'next-match chevron');
      await button(L.prevMatch);
      await eventually(selectedRow, rowOf('x1'), 'previous-match chevron');
      assert.deepStrictEqual(await litIds(), hits, 'stepping keeps the dimming');

      // 輸入法選字中的 Enter / Esc 不會跳轉、不會清除
      await focusSearch();
      await composing('.agg-search input', ['Enter', 'Escape']);
      await sleep(300);
      assert.equal(await selectedRow(), rowOf('x1'), 'IME Enter must not step');
      assert.equal(await searchValue(), 'rate limit', 'IME Esc must not clear');
      assert.equal(await count('.agg-panel'), 1);

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
        await fillSearch(q);
        await eventually(litIds, ids, `rows matching "${q}"`);
      }
      // 沒有符合
      await fillSearch('zzzz-no-such-commit');
      await eventually(litIds, [], 'nothing matches');
      assert.match(await searchCount(), L.noMatches);
      assert.match(await text('.agg-chip--filter'), new RegExp(`0.*${SPECS.length}`));
      const sel = await selectedRow();
      await page.keyboard.press('Enter');
      await sleep(300);
      assert.equal(await selectedRow(), sel, 'Enter without matches must not move the selection');
      assert.equal(await buttonDisabled(L.nextMatch), true);
      assert.equal(await buttonDisabled(L.prevMatch), true);
      // 清除按鈕
      await button(L.clearSearch);
      await eventually(searchValue, '', 'clear button empties the search');
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'nothing is dimmed without a query',
      );
      assert.equal(await count('.agg-chip--filter'), 0);
      assert.equal(await count('.agg-search-count'), 0);
    },
  );

  await step(
    'branch chips focus a branch: pressed state, dimming, scroll to the tip, Esc / click clears',
    async () => {
      await resetView();
      assert.deepStrictEqual(await pressedBranches(), []);
      // a-old 的 tip 是最舊的 commit：點了要捲到最下面
      await branchChip('a-old');
      await eventually(pressedBranches, ['a-old'], 'a-old is pressed');
      await eventually(litIds, ['m1'], 'only the history of a-old stays lit');
      await waitUntil(() => rowInView(LAST), 10_000, 'camera scrolled to the tip');
      assert.ok((await scrollSettled()) > 100, 'scrolled down to the tip of a-old');
      assert.match(await text('.agg-chip--filter'), new RegExp(`1.*${SPECS.length}`));
      // 換成另一條 branch：只有一個 chip 是 pressed
      await branchChip('feat/dark-mode');
      await eventually(pressedBranches, ['feat/dark-mode'], 'only one chip pressed at a time');
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
      await shot('5-branch-focus.png');
      // 再點一次 → 取消
      await branchChip('feat/dark-mode');
      await eventually(pressedBranches, [], 'second click clears the focus');
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'nothing dimmed after clearing',
      );
      // Esc 也能取消
      await branchChip('release/v0.1');
      await eventually(pressedBranches, ['release/v0.1'], 'release/v0.1 pressed');
      await eventually(
        async () => [...(await litIds())].sort(),
        [...reach(HEADS['release/v0.1'])].sort(),
        'rows reachable from release/v0.1',
      );
      await page.keyboard.press('Escape');
      await eventually(pressedBranches, [], 'Esc clears the branch focus');
      await eventually(
        litIds,
        ROWS.map((s) => s.id),
        'nothing dimmed after Esc',
      );
      assert.equal(await count('.agg-panel'), 1, 'overlay stays open');
      // 搜尋只會算還亮著的列：聚焦 a-old 時搜尋 "rate" 找不到
      await branchChip('a-old');
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
    await waitFor('.agg-detail');
    assert.equal(await selectedRow(), rowOf('m7'));
    assert.equal(await count('.agg-root[data-detail]'), 1, 'root carries data-detail');
    const d = await ui((r) => {
      const el = r.querySelector('.agg-detail');
      const stacks = el.querySelectorAll('.agg-facts dd.agg-stack');
      return {
        subject: el.querySelector('.agg-detail-subject').textContent,
        sha: el.querySelector('.agg-sha-full').textContent,
        text: el.textContent,
        parents: [...stacks[0].querySelectorAll('.agg-link code')].map((c) => c.textContent),
        children: [...stacks[1].querySelectorAll('.agg-link code')].map((c) => c.textContent),
      };
    });
    assert.equal(d.subject, specById.get('m7').msg);
    assert.match(d.sha, /^[0-9a-f]{40}$/);
    assert.equal(d.sha, sha('m7'));
    assert.match(d.text, /amy/, 'author in the detail');
    assert.match(d.text, /2026/, 'date in the detail');
    assert.deepStrictEqual(
      d.parents,
      ['m6', 'x2'].map((id) => sha(id).slice(0, 7)),
      'merge has two parents',
    );
    assert.deepStrictEqual(d.children, [sha('m8').slice(0, 7)]);
    await shot('6-detail-wide.png');

    // parent 連結：跳到那個 commit
    await click('.agg-detail .agg-link', new RegExp(esc(specById.get('x2').msg)));
    await eventually(selectedRow, rowOf('x2'), 'parent link selects the parent');
    await eventually(detailSubject, specById.get('x2').msg, 'detail follows the selection');
    // 上一個（較新）/ 下一個（較舊）
    await button(L.prev);
    await eventually(selectedRow, rowOf('x2') - 1, 'Previous (newer)');
    await button(L.next);
    await button(L.next);
    await eventually(selectedRow, rowOf('x2') + 1, 'Next (older) twice');
    // child 連結（目前選的就是 m6，它的 child 是 m7）
    assert.equal(await detailSubject(), specById.get('m6').msg);
    await click('.agg-detail .agg-link', new RegExp(esc(specById.get('m7').msg)));
    await eventually(selectedRow, rowOf('m7'), 'child link selects the child');
    await waitUntil(() => rowInView(rowOf('m7')), 10_000, 'linked commit scrolled into view');

    // 頭尾：沒有上一個 / 下一個
    await page.keyboard.press('Home');
    await eventually(selectedRow, 0, 'Home');
    assert.equal(await buttonDisabled(L.prev), true, 'no newer commit');
    await page.keyboard.press('End');
    await eventually(selectedRow, LAST, 'End');
    assert.equal(await buttonDisabled(L.next), true, 'no older commit');
    // 走到底的那一下，焦點落在被 disable 的按鈕上：鍵盤快捷鍵仍要有效
    await page.keyboard.press('ArrowUp');
    await eventually(selectedRow, LAST - 1, 'ArrowUp');
    await button(L.next);
    await eventually(selectedRow, LAST, 'Next (older) reaches the last commit');
    await eventually(() => buttonDisabled(L.next), true, 'Next now disabled');
    await page.keyboard.press('ArrowUp');
    await eventually(
      selectedRow,
      LAST - 1,
      'ArrowUp still works after the focused button got disabled',
    );

    // 根 commit：沒有 parent、被所有 branch 包含
    await page.keyboard.press('End');
    await eventually(selectedRow, LAST, 'End');
    const root0 = await ui((r) => {
      const el = r.querySelector('.agg-detail');
      return {
        subject: el.querySelector('.agg-detail-subject').textContent,
        parentsText: el.querySelectorAll('.agg-facts dd')[3]?.textContent,
        contained: [...el.querySelectorAll('.agg-chips-wrap .agg-ref-name')]
          .map((n) => n.textContent)
          .sort(),
      };
    });
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
    const m3 = await ui((r) => {
      const el = r.querySelector('.agg-detail');
      return {
        contained: [...el.querySelectorAll('.agg-chips-wrap .agg-ref-name')]
          .map((n) => n.textContent)
          .sort(),
        refs: [...el.querySelectorAll('.agg-facts .agg-refs .agg-ref-name')]
          .map((n) => n.textContent)
          .sort(),
      };
    });
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
    await click('.agg-detail .agg-link--plain');
    await eventually(searchValue, 'amy', 'author click searches for the author');
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
      await clickRow('m5');
      await waitFor('.agg-detail');
      assert.match(await text('.agg-detail .agg-cta'), L.openCommit);
      // 外部網址在封閉網路裡會變成 about:neterror：waitForTabUrl 會還原成原本要去的網址
      const tab = await newTabFrom(browser, () => click('.agg-detail .agg-cta'));
      const url = await waitForTabUrl(tab, /\/commit\/[0-9a-f]{40}$/);
      assert.equal(
        url,
        `https://github.com/demo/adorable-git-graph/commit/${sha('m5')}`,
        'commit page in a new tab',
      );
      await tab.close();
      await page.bringToFront();
      assert.equal(await selectedRow(), rowOf('m5'), 'selection survives opening the commit page');
      assert.equal(await count('.agg-panel'), 1);

      // Copy SHA（詳情裡的小按鈕）：先把剪貼簿設成別的值，才確定真的是這次複製寫進去的。
      // 剪貼簿從瀏覽器 chrome 範圍讀（內容頁讀要 user activation + 貼上提示）；讀不到時只檢查按鈕狀態。
      await writeClipboard(browser, 'sentinel-before-copy');
      const readable = (await readClipboard(browser)) === 'sentinel-before-copy';
      if (!readable)
        console.warn('  ⚠ clipboard is not readable here: asserting the button state only');
      const miniState = () => ui((r) => r.querySelector('.agg-detail .agg-mini-btn').dataset.state);
      assert.equal(await miniState(), 'idle');
      await watchAttr('.agg-detail .agg-mini-btn', 'data-state', '__aggCopyLog');
      await click('.agg-detail .agg-mini-btn');
      await waitUntil(
        async () => (await attrLog('__aggCopyLog')).some((l) => l.startsWith('ok|')),
        8_000,
        'copy button reaches the copied state',
      );
      const copied = (await attrLog('__aggCopyLog')).find((l) => l.startsWith('ok|'));
      assert.match(copied, L.copied, 'the button says "Copied"');
      if (readable) {
        assert.equal(await readClipboard(browser), sha('m5'), 'the full sha is on the clipboard');
      }
      await waitUntil(
        async () => (await attrLog('__aggCopyLog')).some((l) => l.startsWith('idle|')),
        8_000,
        'copied state fades back',
      );
      assert.match(await text('.agg-detail .agg-mini-btn'), L.copySha);

      // 列上的 sha 按鈕：複製完整 sha、顯示 ✓、但不會順便選取那一列
      await writeClipboard(browser, 'sentinel-before-row-copy');
      // （這一列可能在畫面外：列有 content-visibility: auto，畫面外的 innerText 是空的，所以讀 textContent）
      assert.match(await textOf(`${rowSel('m10')} .agg-sha code`), /^[0-9a-f]{7}$/);
      await watchAttr(`${rowSel('m10')} .agg-sha`, 'data-state', '__aggRowCopyLog');
      await click(`${rowSel('m10')} .agg-sha`);
      await waitUntil(
        async () => (await attrLog('__aggRowCopyLog')).some((l) => l.startsWith('ok|')),
        8_000,
        'row sha button shows the copied state',
      );
      if (readable) {
        assert.equal(await readClipboard(browser), sha('m10'), 'row button copies the FULL sha');
      }
      assert.equal(await selectedRow(), rowOf('m5'), 'copying from a row must not select that row');
      await waitUntil(
        async () => (await attrLog('__aggRowCopyLog')).some((l) => l.startsWith('idle|')),
        8_000,
        'row ✓ fades back',
      );

      // 關閉詳情後鍵盤焦點要回到 viewer，ArrowDown 仍然有效
      await scrollTo(0);
      await button(L.closeDetail);
      await waitGone('.agg-detail');
      assert.equal(await count('.agg-root[data-detail]'), 0);
      assert.equal(await selectedRow(), null, 'closing the detail deselects');
      const focused = await ui((r) => {
        const a = r.getRootNode().activeElement;
        return a !== null && r.contains(a);
      });
      assert.ok(focused, 'keyboard focus stays inside the viewer after closing the detail');
      await page.keyboard.press('ArrowDown');
      await eventually(selectedRow, 0, 'ArrowDown works after closing the detail with the button');
      await page.keyboard.press('Escape'); // 鍵盤關詳情
      await waitGone('.agg-detail');
      await page.keyboard.press('ArrowDown');
      await eventually(selectedRow, 0, 'ArrowDown works after closing the detail with Esc');
      // 點同一列再點一次 = 取消選取
      await page.keyboard.press('Escape');
      await clickRow('m9');
      await eventually(selectedRow, rowOf('m9'), 'click selects');
      await clickRow('m9');
      await eventually(selectedRow, null, 'clicking the selected row again deselects');
      assert.equal(await count('.agg-detail'), 0);
    },
  );

  await step(
    'RWD: wide / medium / narrow have no horizontal overflow, detail never hides the selected row',
    async () => {
      const overflow = () =>
        ui((r) => {
          const sc = r.querySelector('.agg-scroll');
          const panel = r.closest('.agg-panel');
          return {
            scroll: sc.scrollWidth - sc.clientWidth,
            doc: document.documentElement.scrollWidth - window.innerWidth,
            root: r.scrollWidth - r.clientWidth,
            panel: panel.scrollWidth - panel.clientWidth,
          };
        });
      const assertNoOverflow = async (label) => {
        const o = await overflow();
        assert.ok(o.scroll <= 1, `${label}: .agg-scroll overflows horizontally by ${o.scroll}px`);
        assert.ok(o.doc <= 0, `${label}: the document overflows horizontally by ${o.doc}px`);
        assert.ok(o.root <= 1, `${label}: .agg-root overflows horizontally by ${o.root}px`);
        assert.ok(o.panel <= 1, `${label}: .agg-panel overflows horizontally by ${o.panel}px`);
      };
      const visible = (sel) =>
        ui((r, s) => {
          const el = r.querySelector(s);
          const cs = getComputedStyle(el);
          const b = el.getBoundingClientRect();
          return cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 && b.height > 0;
        }, sel);
      const sizes = [
        { name: 'wide', w: 1440, h: 900, size: 'wide' },
        { name: 'medium', w: 820, h: 900, size: 'medium' },
        { name: 'narrow', w: 390, h: 844, size: 'narrow' },
      ];
      try {
        for (const vp of sizes) {
          await resetView();
          await page.setViewport({ width: vp.w, height: vp.h });
          await eventually(() => ui((r) => r.dataset.size), vp.size, `${vp.name}: size class`);
          await panelSettled();
          await settle();
          const cols = await ui((r) => r.dataset.cols);
          console.log(`  ${vp.name}: ${vp.w}x${vp.h} data-cols=${cols}`);
          await assertNoOverflow(`${vp.name} (list only)`);
          await assertGraphSync(`${vp.name}: graph`);
          await shot(`7-rwd-${vp.name}.png`);
          // 捲到中間與最底下也要同步（窄螢幕的列比較高，canvas 視窗相對更短，要重新置中）
          const { maxScroll } = await geom();
          for (const off of [Math.round(maxScroll / 2), maxScroll]) {
            await scrollTo(off);
            await assertGraphSync(`${vp.name}: scrollTop ${off}`);
          }
          await scrollTo(0);
          // 列有 content-visibility: auto：Firefox 要到下一次繪製才會把剛捲進畫面的列「真的排版」，之前量到的子元素都是 0×0
          await settle(50);

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
              await visible('.agg-commit .agg-c-author .agg-avatar'),
              true,
              'author avatar still shown',
            );
          }
          if (vp.size === 'narrow') {
            assert.equal(cols, 'min');
            // 兩行式：作者 · 日期 · sha 在第二行
            const two = await ui((r, selector) => {
              const el = r.querySelector(selector);
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
            }, rowSel('m13'));
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
          await waitFor('.agg-detail');
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
                const row = await rect(rowSel(target));
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
            const pos = await ui((r) => getComputedStyle(r.querySelector('.agg-detail')).position);
            assert.equal(pos, 'absolute', 'medium: the detail is a floating drawer');
          }
          await shot(`7-rwd-${vp.name}-detail.png`);
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
        await page.setViewport({ width: 1440, height: 900 });
        await eventually(() => ui((r) => r.dataset.size), 'wide', 'back to wide');
        await resetView();
        await clickRow('m4');
        await waitFor('.agg-detail');
        await page.setViewport({ width: 390, height: 844 });
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
        // 反過來：詳情開著時從手機寬度放大回桌面寬度，詳情要改成並排在右邊、線圖仍然對齊、選取的那一列還看得到
        await page.setViewport({ width: 1440, height: 900 });
        await eventually(() => ui((r) => r.dataset.size), 'wide', 'resized back to wide');
        await panelSettled();
        await detailSettled();
        await settle(300);
        assert.equal(await selectedRow(), 0, 'selection survives the resize back to wide');
        const docked = await rect('.agg-detail');
        const list = await rect('.agg-main');
        assert.ok(
          docked.l >= list.r - 1,
          `wide again: detail (${docked.l}) must dock to the right of the list (${list.r})`,
        );
        await assertGraphSync('narrow → wide with the detail open');
        assert.equal(await rowInView(0), true, 'the selected row is still visible');
        await clearLayers();
      } finally {
        await page.setViewport({ width: 1440, height: 900 });
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
      await waitFor('.agg-detail');
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
      const requests = apiCalls();
      // API 回應太快時，React 會把「開始重新整理」和「完成」合併成同一次 render，轉圈根本不會出現：
      // 讓每個回應慢一點，轉圈一定看得到（要驗證的是「轉圈而列表不卸載」，不是網路有多快）
      latency.ms = 150;
      try {
        await button(L.refresh);
        await waitUntil(() => apiCalls() > requests, 15_000, 'refresh hits the API again');
        // 結束條件：轉圈停了；或列表被卸載 / 出現 loading 畫面（那就是 bug，下面的斷言會講清楚原因）
        await waitUntil(
          async () => {
            const log = await page.evaluate(() => window.__aggRefreshLog);
            return (
              log.includes('aria-busy=null') ||
              log.includes('scroll-removed') ||
              log.includes('loading-or-error-shown')
            );
          },
          20_000,
          'the refresh finishes (spinner stops)',
        );
      } finally {
        latency.ms = 0;
      }
      await settle(500);
      const after = await ui((r) => {
        const sc = r.querySelector('.agg-scroll');
        window.__aggRefreshObserver.disconnect();
        return {
          same: sc?.__e2eSameScroller === true,
          connected: sc?.isConnected ?? false,
          scrollTop: sc?.scrollTop ?? -1,
          selected: r.querySelector('.agg-commit[data-selected]')?.dataset.sha ?? null,
          detail: r.querySelector('.agg-detail') !== null,
          busy: r.querySelector('[aria-busy="true"]') !== null,
          rows: r.querySelectorAll('.agg-commit').length,
          replay: r.querySelector('.agg-canvas')?.dataset.replay ?? null,
          log: window.__aggRefreshLog,
        };
      });
      assert.ok(!after.log.includes('scroll-removed'), `the list was unmounted: ${after.log}`);
      assert.ok(
        !after.log.includes('loading-or-error-shown'),
        `a loading / error panel flashed: ${after.log}`,
      );
      assert.ok(after.log.includes('aria-busy=true'), `the Refresh button must spin: ${after.log}`);
      assert.ok(after.same && after.connected, 'the same .agg-scroll element survives the refresh');
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
    // 三層：branch 聚焦、搜尋文字、選取（詳情）。焦點在 viewer（不在搜尋框）時：詳情 → 搜尋 → branch → overlay
    await branchChip('feat/dark-mode');
    await page.keyboard.press('/');
    await page.keyboard.type('feat');
    await page.keyboard.press('Enter'); // 選第一筆符合的並開詳情
    await waitFor('.agg-detail');
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
    assert.equal(await count('.agg-panel'), 1, 'overlay is still open after three Escapes');
    // 在搜尋框裡：Esc 先清文字（選取仍在），再來關詳情，最後關 overlay
    await page.keyboard.press('/');
    await page.keyboard.type('rate limit');
    await page.keyboard.press('Enter');
    await waitFor('.agg-detail');
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: true, query: false, branch: false },
      'Esc in the search box clears the text first',
    );
    assert.equal(await count('.agg-panel'), 1);
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: false, query: false, branch: false },
      'next Esc closes the detail',
    );
    assert.equal(await count('.agg-panel'), 1);
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');
    await waitFor('.agg-fab');
    // 重新打開：選取 / 搜尋不會殘留
    await openOverlay();
    assert.deepStrictEqual(await layerState(), { detail: false, query: false, branch: false });
    // 只有搜尋文字（沒有選取、沒有 branch 聚焦）：Esc 清掉文字，overlay 還在；再按一次 Esc 才關閉 overlay
    await page.keyboard.press('/');
    await page.keyboard.type('rate');
    await eventually(
      layerState,
      { detail: false, query: true, branch: false },
      'search text only (no selection)',
    );
    await page.keyboard.press('Escape');
    await eventually(
      layerState,
      { detail: false, query: false, branch: false },
      'Esc clears the search text',
    );
    assert.equal(await count('.agg-panel'), 1, 'overlay stays open after clearing the text');
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');
    await waitFor('.agg-fab');
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
        await page.mouse.wheel({ deltaY: dy });
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
      // 頁面有捲軸時，鎖住捲動不能讓背景內容橫向位移（置中的 <main> 會因為捲軸消失而挪動半個捲軸寬）
      const layout = () =>
        page.evaluate(() => ({
          mainLeft: document.querySelector('main').getBoundingClientRect().left,
          scrollbar: window.innerWidth - document.documentElement.clientWidth,
        }));
      const closedLayout = await layout();
      await click('.agg-fab');
      await waitFor('.agg-panel');
      await waitFor('.agg-commit', 30_000);
      await panelSettled();

      let st = await pageState();
      assert.equal(st.overflow, 'hidden', '<html> overflow is locked while the overlay is open');
      assert.equal(st.computed, 'hidden');
      assert.equal(st.gutter, 'stable', 'scrollbar-gutter keeps the background from shifting');
      assert.equal(st.y, 0);
      assert.ok(
        closedLayout.scrollbar > 0,
        'the tall fake page shows a classic scrollbar (needed to detect a background shift)',
      );
      const openLayout = await layout();
      assert.ok(
        Math.abs(openLayout.mainLeft - closedLayout.mainLeft) < 0.5,
        `the page behind shifted ${openLayout.mainLeft - closedLayout.mainLeft}px when the overlay locked the scrollbar away`,
      );

      // 清單捲到底之後再滾（捲動鏈接不能把頁面帶著走）
      const list = await box('.agg-scroll');
      const toolbar = await box('.agg-toolbar');
      const header = await box('.agg-top');
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      const spots = {
        'list (at its end)': [list.x + list.width / 2, list.y + list.height / 2],
        toolbar: [toolbar.x + toolbar.width / 2, toolbar.y + toolbar.height / 2],
        header: [header.x + 30, header.y + header.height / 2],
        'backdrop (left)': [10, 450],
        'backdrop (right)': [vw - 10, 450],
        'backdrop (top)': [700, 6],
      };
      await wheelAt(...spots['list (at its end)'], 600);
      await eventually(
        async () => (await scrollSettled()) > 100,
        true,
        'the wheel scrolls the list itself',
      );
      await scrollTo(1e6);
      for (const [name, [x, y]] of Object.entries(spots)) {
        await wheelAt(x, y, 900);
        await wheelAt(x, y, -300);
        await wheelAt(x, y, 900);
        st = await pageState();
        assert.equal(st.y, 0, `page scrolled (scrollY=${st.y}) while wheeling over the ${name}`);
      }
      await shot('8-extension-scroll-lock.png');

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
    'extension: the page behind is inert (Tab cannot reach it, also after <body> is replaced); no gutter without a scrollbar',
    async () => {
      await closeOverlay();
      const pageInfo = () =>
        page.evaluate(() => ({
          bodyInert: document.body.inert,
          gutter: document.documentElement.style.scrollbarGutter,
          overflow: document.documentElement.style.overflow,
          scrollbar: window.innerWidth - document.documentElement.clientWidth,
          mainLeft: document.querySelector('main')?.getBoundingClientRect().left ?? null,
          active: document.activeElement?.id ?? document.activeElement?.tagName,
        }));
      // 一個真的能拿到焦點的頁面元素（假頁面本來沒有任何可聚焦的東西）
      await page.evaluate(() => {
        const b = document.createElement('button');
        b.id = 'agg-e2e-page-button';
        b.textContent = 'page button';
        document.body.prepend(b);
      });
      const closed = await pageInfo();
      assert.equal(closed.scrollbar, 0, 'the short fake page has no scrollbar');
      assert.equal(closed.bodyInert, false);
      // 對照組：overlay 沒開時，從 FAB 按 Shift+Tab 會走到它前面的頁面按鈕，而且頁面按鈕能直接拿到焦點
      await shadow((sr) => sr.querySelector('.agg-fab').focus());
      await chord(page, ['Shift'], 'Tab');
      await eventually(
        async () => (await pageInfo()).active,
        'agg-e2e-page-button',
        'Shift+Tab reaches the page button while the overlay is closed',
      );
      await page.evaluate(() => document.activeElement.blur());

      await click('.agg-fab');
      await waitFor('.agg-panel');
      await waitFor('.agg-commit', 30_000);
      await panelSettled();
      const open = await pageInfo();
      assert.equal(open.overflow, 'hidden');
      assert.equal(open.bodyInert, true, '<body> is inert while the overlay is open');
      // 頁面沒有捲軸時不要加 scrollbar-gutter（加了反而讓版面位移）
      assert.equal(open.gutter, '', 'no scrollbar-gutter on a page without a scrollbar');
      assert.ok(
        Math.abs(open.mainLeft - closed.mainLeft) < 0.5,
        `the page behind shifted ${open.mainLeft - closed.mainLeft}px`,
      );
      // 直接 focus() 也拿不到焦點；一路 Tab / Shift+Tab 下去（比 overlay 裡可聚焦的元素多很多次）：
      // 焦點不能落到頁面上的按鈕、也不能把頁面捲動
      assert.equal(
        await page.evaluate(() => {
          document.getElementById('agg-e2e-page-button').focus();
          return document.activeElement?.id;
        }),
        'adorable-git-graph-host',
        'an inert page button cannot be focused',
      );
      for (const mods of [[], ['Shift']]) {
        for (let i = 0; i < 30; i++) {
          await chord(page, mods, 'Tab');
          const info = await page.evaluate(() => ({
            id: document.activeElement?.id,
            y: window.scrollY,
          }));
          assert.notEqual(
            info.id,
            'agg-e2e-page-button',
            `${mods.join('+') || 'Tab'} #${i + 1} reached the page behind`,
          );
          assert.equal(info.y, 0, 'the page must not scroll while tabbing');
        }
      }
      assert.equal(await count('.agg-panel'), 1, 'tabbing does not close the overlay');

      // GitHub（Turbo）換頁會換掉整個 <body>：新的 <body> 也要是 inert
      await page.evaluate(() => {
        const nb = document.createElement('body');
        nb.innerHTML = '<button id="agg-e2e-page-button-2">new page button</button>';
        document.documentElement.replaceChild(nb, document.body);
      });
      await eventually(
        async () => (await pageInfo()).bodyInert,
        true,
        'a replacement <body> is made inert as well',
      );
      await closeOverlay();
      const after = await pageInfo();
      assert.equal(after.bodyInert, false, 'inert is released on close');
      assert.equal(after.overflow, '');
      assert.equal(after.gutter, '');
      // 還原假頁面
      await page.evaluate(() => document.getElementById('agg-e2e-page-button-2')?.remove());
    },
  );

  await step(
    'extension: clicking the backdrop closes the overlay, a drag that starts inside does not',
    async () => {
      await openOverlay();
      const panel = await page.evaluate((id) => {
        const b = document
          .getElementById(id)
          .shadowRoot.querySelector('.agg-panel')
          .getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }, HOST_ID);
      // 在面板裡按下、拖到背景放開（例如選文字）不算點背景
      await page.mouse.move(panel.x + 200, panel.y + 40);
      await page.mouse.down();
      await page.mouse.move(8, 8, { steps: 4 });
      await page.mouse.up();
      await sleep(300);
      assert.equal(await count('.agg-panel'), 1, 'a drag out of the panel must not close it');
      // 點面板內部不會關
      await click('.agg-title-text');
      await sleep(200);
      assert.equal(await count('.agg-panel'), 1, 'clicking inside the panel must not close it');
      // 點背景才關
      await page.mouse.click(10, 450);
      await waitGone('.agg-panel');
      await waitFor('.agg-fab');
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
      await page.mouse.click(5, 200);
      await page.keyboard.press('g');
      await eventually(
        async () => (await keys()).includes('keydown:g'),
        true,
        'the page listener works while the overlay is closed',
      );
      await page.evaluate(() => (window.__keys.length = 0));

      await click('.agg-fab');
      await waitFor('.agg-panel');
      await waitFor('.agg-commit', 30_000);
      await panelSettled();
      await page.evaluate(() => (window.__keys.length = 0));
      // 在列表上導覽、在搜尋框裡打字（含 j k / g t s 等 GitHub 快捷鍵字母）、Enter、Esc 清除、再選一筆
      for (const k of ['ArrowDown', 'j', 'k', 'End', 'Home', 'ArrowUp'])
        await page.keyboard.press(k);
      await page.keyboard.press('/');
      await page.keyboard.type('gts rate/limit jk', { delay: 10 });
      await page.keyboard.press('Enter');
      await chord(page, ['Shift'], 'Enter');
      await chord(page, ['Control'], 'a');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('feat');
      await page.keyboard.press('Escape'); // 清掉搜尋
      await eventually(searchValue, '', 'search cleared');
      await page.keyboard.press('Escape'); // 關詳情（如果有）
      await sleep(300);
      assert.deepStrictEqual(
        await keys(),
        [],
        'key events leaked out of the shadow host to the page',
      );
      assert.equal(await count('.agg-panel'), 1);

      // 焦點掉到 overlay 外面（body）：按鍵一樣不能漏給頁面，而且焦點會被拉回 overlay
      const blurAll = () =>
        page.evaluate((id) => {
          document.getElementById(id).shadowRoot.activeElement?.blur();
          document.activeElement?.blur();
        }, HOST_ID);
      await blurAll();
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
      await blurAll();
      await page.keyboard.press('Escape');
      await waitGone('.agg-panel');
      assert.ok(
        !(await keys()).some((k) => k.startsWith('keydown') || k.startsWith('keypress')),
        `leaked: ${await keys()}`,
      );
      // 關閉之後頁面又看得到按鍵
      await waitFor('.agg-fab');
      await page.mouse.click(5, 200);
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
    const first = apiCalls();
    await button(L.refresh);
    await waitUntil(() => apiCalls() > first, 15_000, 'forced refresh reaches the API');
    await quiet(700);
    await closeOverlay();
    const before = apiCalls();
    await click('.agg-fab');
    await waitFor('.agg-canvas canvas');
    await waitFor('.agg-commit', 30_000);
    await sleep(600);
    assert.equal(apiCalls(), before, 'expected a cache hit (no new API requests)');
    await button(L.refresh);
    await waitUntil(() => apiCalls() > before, 15_000, 'refresh re-fetches');
    await waitFor('.agg-canvas canvas');
    await waitFor('.agg-commit');
    await quiet(700);
    await closeOverlay();
  });

  await step('night theme follows GitHub color mode and still paints the graph', async () => {
    await closeOverlay();
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'dark'));
    await click('.agg-fab');
    await waitFor('.agg-root[data-theme="night"]');
    await replayDone();
    await panelSettled();
    const cardBg = () => ui((r) => getComputedStyle(r.querySelector('.agg-main')).backgroundColor);
    const night = await cardBg();
    await assertGraphSync('night');
    await shot('4-night.png');
    await closeOverlay();
    await page.evaluate(() => (document.documentElement.dataset.colorMode = 'light'));
    await click('.agg-fab');
    await waitFor('.agg-root[data-theme="day"]');
    await waitFor('.agg-commit', 30_000);
    assert.notEqual(night, await cardBg(), 'the list card uses different colours at night');
    await closeOverlay();
  });

  await step('SPA navigation: error states (404 / rate limit) are friendly', async () => {
    await closeOverlay();
    // Firefox 沒有 Navigation API，換頁靠 content script 每 1.5 秒的輪詢偵測（repoStore）：等 3 秒才保證偵測得到
    await page.evaluate(() => history.pushState({}, '', '/ghost/missing'));
    await sleep(3000);
    await waitFor('.agg-fab');
    await click('.agg-fab');
    await waitFor('.agg-center[role="alert"]');
    assert.equal(await count('.agg-scroll'), 0, 'no stale list behind the error panel');
    assert.equal(await count('.agg-commit'), 0, "never show another repo's commits");
    await sleep(700);
    await shot('5-error-404.png');
    // 錯誤畫面裡鍵盤仍然可用：Esc 關閉 overlay
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');

    await page.evaluate(() => history.pushState({}, '', '/limited/repo'));
    await sleep(3000);
    await waitFor('.agg-fab');
    await click('.agg-fab');
    await waitFor('.agg-center[role="alert"]');
    assert.match(await textOf('.agg-center'), /60/);
    // 錯誤畫面仍有標題列的按鈕；重新整理 = 再試一次（仍然是錯誤）
    const before = apiCalls();
    await button(L.refresh);
    await waitUntil(() => apiCalls() > before, 10_000, 'retry hits the API');
    await waitFor('.agg-center[role="alert"]');
    await page.keyboard.press('Escape');
    await waitGone('.agg-panel');

    await page.evaluate((p) => history.pushState({}, '', p), REPO);
    await sleep(3000);
    await waitFor('.agg-fab');
  });

  await step(
    'the real toolbar button toggles the overlay (action.onClicked → tabs.sendMessage)',
    async () => {
      await closeOverlay();
      await page.bringToFront();
      await clickToolbarButton(browser, GECKO_ID);
      await waitFor('.agg-panel');
      await waitFor('.agg-commit', 30_000);
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
      const opt = await newTabFrom(browser, () => button(L.settings));
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
      await button(L.refresh);
      await waitUntil(() => seen.auth.length > 0, 20_000, 'authorised requests');
      await quiet(700);
      await waitFor('.agg-commit', 30_000);
      assert.equal(await count('.agg-commit'), SPECS.length);
      assert.ok(seen.auth.every((a) => a === 'Bearer github_pat_e2e_secret'));
      // 選一個 commit、開詳情：token 不能出現在頁面 DOM（含 shadow tree）、URL 或資源網址裡
      await clickRow('m5');
      await waitFor('.agg-detail');
      // extension 的畫面都在 open shadow root 裡，page.content() 看不到，所以連 shadow tree 一起檢查
      const shadowHtml = await shadow((sr) => sr?.innerHTML ?? '');
      assert.ok(shadowHtml.includes('agg-detail'), 'the shadow tree was really inspected');
      assert.ok(
        !(await page.content()).includes('github_pat_e2e_secret') &&
          !shadowHtml.includes('github_pat_e2e_secret'),
        'token must never reach the page DOM (light or shadow)',
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

  await step(
    'the event page is suspended, and the next request wakes it and is answered (suspend → wake)',
    async () => {
      await closeOverlay();
      // 直接終止 event page（見 backgroundControl 的說明），而不是等閒置逾時
      assert.equal(await backgroundControl(browser, GECKO_ID, 'terminate'), 'stopped');
      assert.equal(await backgroundControl(browser, GECKO_ID, 'state'), 'stopped');
      const before = apiCalls();
      await openOverlay();
      await button(L.refresh);
      await waitUntil(() => apiCalls() > before, 20_000, 'the woken event page fetches');
      await waitFor('.agg-canvas canvas');
      await waitFor('.agg-commit', 30_000);
      assert.equal(
        await exists('.agg-center[role="alert"]'),
        false,
        'the woken event page must serve the request',
      );
      assert.equal(await backgroundControl(browser, GECKO_ID, 'state'), 'running');
      await closeOverlay();
    },
  );

  // ───────────── 更早的歷史（infinite scroll） ─────────────
  // demo/long-history（見 mock 的 LONG）：每條 branch 只抓一頁（25 筆）時，第一批只有最新的一段，
  // 其餘要捲到底、由 content script → event page 的 fetch-more 從 missing parent 往回抓（/commits?sha=<40 位 hex>）。

  const LONG_URL = `${GH}/${LONG.owner}/${LONG.name}`;
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
    }, shaHex ?? null);
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
  /** 在設定頁（extension 的特權頁面，有 chrome.storage）裡改設定；回傳改之前的設定。 */
  async function withSettings(fn, arg) {
    const opt = await openExtensionPage(browser, EXT_UUID, 'options.html');
    try {
      return await opt.evaluate(fn, arg);
    } finally {
      await opt.close();
      await page.bringToFront();
    }
  }

  await step(
    'infinite scroll: scrolling to the bottom loads older commits page by page (no jump, no replay, graph in sync)',
    async () => {
      await closeOverlay();
      const saved = await withSettings(async (n) => {
        const cur = (await chrome.storage.local.get('settings')).settings ?? null;
        await chrome.storage.local.set({ settings: { ...(cur ?? {}), maxCommitsPerBranch: n } });
        return cur;
      }, LONG_PER_PAGE);
      try {
        const from = seen.paths.length;
        await page.goto(LONG_URL);
        await waitFor('.agg-fab');
        await openOverlay({ replay: true });
        assert.equal(await text('.agg-title-text'), 'demo/long-history');
        // 第一批：每條 branch 一頁（設定的 25 筆）
        const branchReqs = seen.paths
          .slice(from)
          .filter((p) => p.startsWith(`/repos/demo/${LONG.name}/commits?`) && !isMoreRequest(p));
        assert.ok(branchReqs.length > 0, 'the first batch was fetched by branch name');
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
        await shadow((sr) => {
          const cv = sr.querySelector('.agg-canvas');
          window.__aggReplayLog = [];
          new MutationObserver(() => window.__aggReplayLog.push(cv.dataset.replay)).observe(cv, {
            attributes: true,
            attributeFilter: ['data-replay'],
          });
          sr.querySelector('.agg-scroll').dataset.aggE2eSame = '1';
        });

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
            const b = await box('.agg-scroll');
            await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
            for (let k = 0; k < 30; k++) {
              const g = await geom();
              if (g.scrollTop >= g.maxScroll - 1) break;
              await page.mouse.wheel({ deltaY: 1500 });
              await sleep(60);
            }
          } else {
            await scrollTo(1e6);
          }
          await waitFor('.agg-footer[data-state="loading"]', 10_000);
          await waitUntil(() => gate.queue.length > 0, 20_000, 'the batch request reaches the API');
          await scrollSettled();
          const anchor = await rowAnchor();
          assert.equal((await rowShas()).length, before.length, 'the batch is still on hold');
          if (batches === 0) {
            assert.match((await footerNow()).text, L.loadingMore, 'the footer says it is loading');
            await shot('6-infinite-scroll-loading.png');
          }
          releaseHeld();

          if (injectFailure) {
            await waitFor('.agg-footer[data-state="error"]', 30_000);
            assert.match((await footerNow()).text, L.loadMoreFailed);
            const n = moreRequests(reqFrom).length;
            await sleep(2500);
            assert.equal(
              moreRequests(reqFrom).length,
              n,
              'a failed batch is never retried automatically',
            );
            assert.deepStrictEqual(await rowShas(), before, 'a failed batch changes nothing');
            await shot('6-infinite-scroll-error.png');
            await click('.agg-footer button', L.retry);
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
          assert.equal(await ui((r) => r.querySelector('.agg-canvas').dataset.replay), 'done');
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
        assert.equal(
          await ui((r) => r.querySelector('.agg-scroll').dataset.aggE2eSame ?? null),
          '1',
          'the scroller was not re-created',
        );
        // 往回載入之後，指向舊 commit 的 tag 也出現了
        const tagsAt = (id) =>
          ui(
            (r, s) =>
              [...r.querySelectorAll(`${s} .agg-ref--tag .agg-ref-name`)].map((e) => e.textContent),
            rowSel(id),
          );
        assert.deepStrictEqual(await tagsAt('L40'), ['v1.0']);
        assert.deepStrictEqual(await tagsAt('L148'), ['v2.0']);
        assert.match(
          (await chipTexts())[0],
          new RegExp(`^${LONG.total} commits?|^${LONG.total} 個`),
        );
        await scrollTo(1e6);
        await assertGraphSync('end of history');
        await shot('6-infinite-scroll-end.png');
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
        await button(L.refresh);
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
        await withSettings(async (prev) => {
          if (prev) await chrome.storage.local.set({ settings: prev });
          else await chrome.storage.local.remove('settings');
        }, saved);
      }
      await closeOverlay();
      await gotoRepo();
    },
  );

  await step(
    'no uncaught page errors or console errors (page, event page, options page)',
    async () => {
      // event page / options page 的未捕捉錯誤（content script 的錯誤已由 page 的 console 事件收進 errors）
      errors.push(...(await extensionConsoleErrors(browser, EXT_UUID)));
      assert.deepEqual(errors, [], `unexpected console errors:\n${errors.join('\n')}`);
    },
  );

  console.log(`\nAll ${results.length} Firefox e2e steps passed. Screenshots → ${artifacts}`);
} catch (err) {
  console.error('\n✘ Firefox e2e failed:', err);
  if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  try {
    if (page && !page.isClosed())
      await page.screenshot({ path: resolve(artifacts, 'failure.png') });
  } catch {
    /* 截圖失敗不影響結果 */
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  xvfb?.stop();
  api.close();
  fake.close();
}
