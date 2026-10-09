// End-to-end：啟動真正的 dev server（pnpm start 同一份設定），用 Chromium 驗證「垂直捲動的 git log 列表」viewer。
// 資料全部是 e2e 自己建立的暫時 git repo（88 個 commit、3 條 branch、1 個 merge、1 個 tag）與 mock GitHub API，不依賴網路；
// 所有「應該長怎樣」的期望值都由 git 自己算出來（git log / for-each-ref / rev-list），不是手寫常數。
//   · 列表與 git 資訊：列數 = commit 數、最新的在最上面、7 位 sha / 作者 / 日期、branch / tag 標籤、merge 標籤、類型標籤
//   · 捲動 ↔ 線圖同步：捲到 0 / 123 / 中間 / 超過 canvas 緩衝的大跳躍 / 滾輪 / 底端，截圖後逐列取樣小球的像素
//     （中心 + 外圍 8 點，與同列的卡片底色比較；整列線圖欄不能是空白；canvas 視窗要重新置中並涵蓋可視範圍）
//   · 搜尋（計數、淡化、Enter / Shift+Enter / 箭頭、IME）、branch 聚焦、分層 Escape（詳情 → 搜尋文字 → branch 聚焦）
//   · 詳情面板（內容、parent / child / 上一個 / 下一個、在 GitHub 開啟 = 新分頁、複製 SHA、關閉後鍵盤焦點）與鍵盤（j k ↑ ↓ Home End /）
//   · RWD（wide / medium / narrow：沒有橫向溢位、欄位與標題對齊、詳情不蓋住選取列、尺寸改變時錨定畫面最上面的 commit）
//   · 重新整理保留捲動 / 選取（本機 + GitHub，轉圈中列表不卸載；失敗時錯誤畫面取代列表）
//   · 即時更新（git commit / 一次進來好幾筆 / branch / checkout / tag / 刪 branch）：不重新整理、只有新的 commit 彈出來、
//     捲動錨定（捲下去時畫面最上面的 commit 不動、選取不丟、不重播）
//   · GitHub 來源（輸入驗證、404、rate limit、loading、深連結與快取、token 只以 Bearer header 送出且不進 DOM / URL / 快取）
//   · 安全性（cross-origin 讀不到 dev endpoint、快照與 bundle 沒有 commit 本文 / email）→ 主題記憶 → zh-TW → 其他本機 repo
//     （沒有 remote / 空的 / 不是 git）→ 本機 build + preview。
// 軟體 WebGL（SwiftShader）在 CPU 吃緊時很慢：一律等「狀態」（data-replay、定位器、輪詢），不用固定 sleep 當判斷依據；
// 像素判斷失敗時會重截幾次才判定；逾時乘上 E2E_TIMEOUT_SCALE（預設 2）。截圖輸出到 e2e/.artifacts。
//   用法：pnpm e2e        （環境變數 CHROME_PATH 可指定 Chrome）
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';
import { SPECS, seen, sha as mockSha, startMock } from '../../../tools/e2e/mock-github-api.mjs';
import { colorDistance, inkRatio, samplePixels } from '../../../tools/e2e/pixels.mjs';

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
// 每個 commit（含 merge）的時間戳都比上一個晚一小時：--date-order 的順序就等於「建立順序倒過來」，沒有歧義
let tick = 0;
const T0 = Date.UTC(2026, 0, 1);
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
const identity = (name) => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.test`,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@example.test`,
});
const stamped = (name) => {
  const date = new Date(T0 + tick++ * 3600_000).toISOString();
  return { ...gitEnv, ...identity(name), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
};
const commit = (cwd, msg, author = 'Amy') =>
  execFileSync('git', ['commit', '--allow-empty', '-m', msg], { cwd, env: stamped(author) });
const merge = (cwd, branch) =>
  execFileSync('git', ['merge', '--no-ff', branch, '-m', `Merge branch '${branch}'`], {
    cwd,
    env: stamped('Amy'),
  });

const TYPES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'perf'];
let fillerNo = 0;
const filler = (dir, count) => {
  for (let i = 0; i < count; i++) {
    fillerNo++;
    commit(
      dir,
      `${TYPES[fillerNo % TYPES.length]}: step ${fillerNo}`,
      fillerNo % 7 === 0 ? 'Ben' : 'Amy',
    );
  }
};

/**
 * 捲動測試需要夠長的歷史：88 個 commit、3 條 branch（main / feat/x 已 merge / wip/old 沒 merge）、1 個 merge、1 個 tag，
 * 作者 Amy / Ben / Cat，含一個有內文的 commit、一個 scope + breaking 的 commit、一個沒有 conventional 前綴的 commit。
 */
function makeRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/octo/cat.git');
  commit(dir, 'chore: root');
  commit(dir, 'feat: two');
  git(dir, 'tag', 'v1');
  filler(dir, 6);
  git(dir, 'checkout', '-q', '-b', 'wip/old');
  commit(dir, 'wip: old one', 'Cat');
  commit(dir, 'wip: old two', 'Cat');
  git(dir, 'checkout', '-q', 'main');
  filler(dir, 2);
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  commit(dir, 'feat: side one', 'Ben');
  commit(dir, 'fix: side two', 'Ben');
  git(dir, 'checkout', '-q', 'main');
  filler(dir, 3);
  git(dir, 'checkout', '-q', 'feat/x');
  commit(dir, 'feat: side three', 'Ben');
  commit(dir, 'docs: side four', 'Ben');
  git(dir, 'checkout', '-q', 'main');
  filler(dir, 4);
  merge(dir, 'feat/x');
  commit(dir, 'feat: add parser\n\nBody line: the parser rejects empty input.\nSecond body line.');
  commit(dir, 'fix(parser)!: reject empty input');
  filler(dir, 62);
  return dir; // 88 commits, 3 branches, 1 tag, 1 merge
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

const dirBase = (d) => d.split('/').pop();
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 軟體 WebGL + 別的程序一起吃 CPU 時很慢：所有輪詢逾時（與 Playwright 的預設逾時）都乘上這個倍率（預設 2；E2E_TIMEOUT_SCALE 可調）
const SCALE = Number(process.env.E2E_TIMEOUT_SCALE) || 2;

/** 輪詢直到條件成立；逾時會把 `what` 放進錯誤訊息，方便從 log 看出卡在哪。 */
const waitUntil = async (cond, timeout = 20_000, what = '') => {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > timeout * SCALE)
      throw new Error(`waitUntil timed out${what ? `: ${what}` : ''}`);
    await sleep(100);
  }
};

const results = [];
const errors = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
  } catch (err) {
    console.error(`✘ ${name} (${Date.now() - t}ms)`);
    throw err;
  }
  results.push(name);
  console.log(`✔ ${name} (${Date.now() - t}ms)`);
};

/** 與真實使用者一樣只看得到的錯誤：頁面例外與 console.error（404 / 403 / 被擋下的請求 Chrome 會記成 Failed to load resource，是預期的）。 */
const watchErrors = (p, tag) => {
  p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(`${tag} console.error: ${m.text()}`);
  });
};

// ───────────────────────── 從 git 讀「應該長怎樣」 ─────────────────────────
// 期望值一律由 git 本身算出來（不是手寫常數），所以 UI 排序 / 內容不對就會失敗。

/** 與 viewer 相同的範圍與順序：所有 branch + tag 可到達的 commit，新 → 舊。 */
const gitLog = (cwd) =>
  execFileSync(
    'git',
    ['log', '--date-order', '-z', '--format=%H%x1f%P%x1f%an%x1f%at%x1f%B', '--branches', '--tags'],
    { cwd, env: gitEnv, encoding: 'utf8' },
  )
    .split('\0')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, author, at, body] = rec.split('\x1f');
      const subject = body.trim().split('\n')[0];
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        author,
        atMs: Number(at) * 1000,
        // 本機快照只帶第一行（%s）：本文常夾 Signed-off-by / Co-authored-by 的 email，刻意不放進 bundle / dev endpoint
        message: subject,
        subject,
      };
    });

/** sha → [{ name, kind }]（本機 branch 與 tag） */
const gitRefs = (cwd) => {
  const map = new Map();
  const out = git(
    cwd,
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(*objectname)',
    'refs/heads',
    'refs/tags',
  );
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, obj, peeled] = line.split('\t');
    const kind = ref.startsWith('refs/tags/') ? 'tag' : 'branch';
    const name = ref.replace(/^refs\/(heads|tags)\//, '');
    const target = peeled || obj;
    map.set(target, [...(map.get(target) ?? []), { name, kind }]);
  }
  return map;
};

const gitBranches = (cwd) =>
  git(cwd, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

const gitCount = (cwd) => gitLog(cwd).length;

/** 搜尋的期望結果：與 graph-core 的 matchesQuery 相同的語意（每個詞都要出現在 說明 / 作者 / sha / ref 名稱 之一，不分大小寫）。 */
const expectMatches = (cwd, query) => {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const refs = gitRefs(cwd);
  return gitLog(cwd)
    .filter((c) => {
      const hay = [c.message, c.author, c.sha, ...(refs.get(c.sha) ?? []).map((r) => r.name)]
        .join('\n')
        .toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .map((c) => c.sha);
};

/** 與 viewer 的 parseSubject 相同的 conventional commit 規則 */
const CONVENTIONAL =
  /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(?:\(([^)]*)\))?(!)?:\s+/i;

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
let page;

try {
  dev = startVite(['--port', String(port), '--strictPort'], env);
  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    // Playwright 的 headless 預設會隱藏捲軸（寬度 0）：改成真的捲軸，欄位標題才會真的和有捲軸的列對齊
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  await dev.ready;
  const base = `http://localhost:${port}`;
  // 語系固定為 en-US：標籤文字可以直接比對（zh-TW 另有一步專門驗證）
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  ctx.setDefaultTimeout(30_000 * SCALE);
  ctx.setDefaultNavigationTimeout(30_000 * SCALE);
  await ctx.route('https://github.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: '<title>fake github</title>' }),
  );
  // 複製 SHA：Chromium 可以授權並讀回剪貼簿
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const decoder = await ctx.newPage();
  await decoder.goto('about:blank');
  page = await ctx.newPage();
  watchErrors(page, 'page');

  // ── 狀態讀取 ──
  const chips = async () => (await page.locator('.agg-chip').allInnerTexts()).join(' | ');
  const commitCount = async () => {
    const t = await page
      .locator('.agg-chip--commits')
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => null);
    return Number(/^(\d+)/.exec(t ?? '')?.[1] ?? NaN);
  };
  const waitForCommits = (n) =>
    waitUntil(async () => (await commitCount()) === n, 25_000, `commit chip to show ${n}`);
  const replayDone = (pg = page) =>
    pg.locator('.agg-canvas[data-replay="done"]').waitFor({ timeout: 90_000 });
  let expected = gitCount(repoDir);

  /** 目前 DOM 的每一列（內容 + 狀態）。 */
  const domRows = (pg = page) =>
    pg.evaluate(() =>
      [...document.querySelectorAll('.agg-commit')].map((r) => {
        const time = r.querySelector('time');
        const refs = [...r.querySelectorAll('.agg-ref:not(.agg-ref--more)')].map((x) => ({
          cls: x.className,
          name: x.querySelector('.agg-ref-name')?.textContent ?? '',
          text: x.textContent ?? '',
        }));
        return {
          sha: r.dataset.sha,
          row: Number(r.dataset.row),
          lane: Number(r.dataset.lane),
          kind: r.dataset.kind,
          selected: r.hasAttribute('data-selected'),
          ariaSelected: r.getAttribute('aria-selected'),
          dim: r.hasAttribute('data-dim'),
          type: r.querySelector('.agg-type')?.textContent ?? null,
          scope: r.querySelector('.agg-scope')?.textContent ?? null,
          subject: r.querySelector('.agg-subject')?.textContent ?? '',
          title: r.querySelector('.agg-subject')?.title ?? '',
          refs,
          merge: Boolean(r.querySelector('.agg-merge')),
          short: r.querySelector('.agg-sha code')?.textContent ?? '',
          author: r.querySelector('.agg-author-name')?.textContent ?? '',
          datetime: time?.getAttribute('datetime') ?? '',
          dateTitle: time?.title ?? '',
          dateText: r.querySelector('.agg-date-abs')?.textContent ?? '',
          role: r.getAttribute('role'),
        };
      }),
    );
  const rowLoc = (sha, pg = page) => pg.locator(`.agg-commit[data-sha="${sha}"]`);
  const selectedSha = () =>
    page.evaluate(() => document.querySelector('.agg-commit[data-selected]')?.dataset.sha ?? null);
  const dimmedShas = async () => (await domRows()).filter((r) => r.dim).map((r) => r.sha);
  const litShas = async () => (await domRows()).filter((r) => !r.dim).map((r) => r.sha);
  const sameSet = (a, b) => a.length === b.length && new Set([...a, ...b]).size === a.length;
  const waitLit = async (want, what) => {
    await waitUntil(async () => sameSet(await litShas(), want), 10_000, what).catch(() => {});
    const got = await litShas();
    assert.ok(
      sameSet(got, want),
      `${what}: expected ${want.length} lit rows, got ${got.length} (missing ${want.filter((s) => !got.includes(s)).length}, extra ${got.filter((s) => !want.includes(s)).length})`,
    );
  };
  const waitSelected = async (sha, what = '') => {
    await waitUntil(async () => (await selectedSha()) === sha, 10_000, `selected ${what}`).catch(
      () => {},
    );
    assert.equal(await selectedSha(), sha, `selected row (${what})`);
  };

  // ── 捲動 ──
  const scrollTopNow = () => page.evaluate(() => document.querySelector('.agg-scroll').scrollTop);
  /** 等平滑捲動結束（scrollTop 連續 3 次輪詢都沒變）。 */
  const settleScroll = async () => {
    let last = NaN;
    let same = 0;
    const t = Date.now();
    while (same < 3) {
      const cur = await scrollTopNow();
      same = cur === last ? same + 1 : 0;
      last = cur;
      if (Date.now() - t > 20_000) throw new Error('scroll never settled');
      await sleep(80);
    }
    return last;
  };
  const scrollTo = async (top) => {
    await page.evaluate((t) => {
      document.querySelector('.agg-scroll').scrollTop = t;
    }, top);
    return settleScroll();
  };
  const scrollMax = () =>
    page.evaluate(() => {
      const s = document.querySelector('.agg-scroll');
      return s.scrollHeight - s.clientHeight;
    });

  /** 可視範圍內「完整看得到」的列，以及 canvas 視窗的位置（data-*）。 */
  const visibleGeometry = (pg = page) =>
    pg.evaluate(() => {
      const sc = document.querySelector('.agg-scroll');
      const scr = sc.getBoundingClientRect();
      const log = document.querySelector('.agg-log').getBoundingClientRect();
      const host = document.querySelector('.agg-canvas');
      const d = host.dataset;
      const hostR = host.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.agg-commit')]
        .map((r) => ({ r, b: r.getBoundingClientRect() }))
        .filter(({ b }) => b.top >= scr.top + 1 && b.bottom <= scr.bottom - 1)
        .map(({ r, b }) => {
          const g = r.querySelector('.agg-c-g').getBoundingClientRect();
          const row = Number(r.dataset.row);
          const lane = Number(r.dataset.lane);
          return {
            sha: r.dataset.sha,
            row,
            lane,
            rowTop: b.top,
            rowBottom: b.bottom,
            rowCenter: b.top + b.height / 2,
            gLeft: g.left,
            gWidth: g.width,
            // 契約：node 中心 = track 座標 (padLeft + lane * lanePitch, topPad + (row + 0.5) * rowH)，track 原點 = .agg-log 的左上角
            x: log.left + Number(d.padLeft) + lane * Number(d.lanePitch),
            y: log.top + Number(d.topPad) + (row + 0.5) * Number(d.rowH),
          };
        });
      return {
        scrollTop: sc.scrollTop,
        clientHeight: sc.clientHeight,
        scrollHeight: sc.scrollHeight,
        scrTop: scr.top,
        scrBottom: scr.bottom,
        winTop: Number(d.winTop),
        hostTop: hostR.top - log.top,
        hostHeight: hostR.height,
        replay: d.replay,
        rows,
      };
    });

  /** 每個 band 裡「和背景色差很多」的像素數（拿來判斷這一列的線圖欄不是空白）。 */
  const bandInk = (png, bands) =>
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
        return bands.map(({ x, y, w, h, bg }) => {
          const { data } = g.getImageData(
            Math.max(0, Math.round(x)),
            Math.max(0, Math.round(y)),
            Math.max(1, Math.round(w)),
            Math.max(1, Math.round(h)),
          );
          let n = 0;
          for (let i = 0; i < data.length; i += 4)
            if (
              Math.abs(data[i] - bg[0]) +
                Math.abs(data[i + 1] - bg[1]) +
                Math.abs(data[i + 2] - bg[2]) >
              60
            )
              n++;
          return n;
        });
      },
      { b64: png.toString('base64'), bands },
    );

  /**
   * 線圖與列表同步（核心）：對每一個完整可見的列，截圖後取樣「小球中心」的像素，必須和「同一列線圖欄最右邊（沒有小球 / 線）」
   * 的卡片底色明顯不同；而且整個線圖欄的那一列不能是空白。軟體 WebGL 偶爾慢一個 frame，所以失敗會重截幾次再判定。
   * 同一條 lane 裡上下相鄰的小球之間有一條連續的線，只取樣中心點會被那條線蓋過去（小球整個畫歪半列也看不出來），
   * 所以另外在中心外 11px 的圓周上取 8 個點（比線寬、比臉上的五官都外面，但仍在半徑 14px 的球身內）：至少 7 個要是球身。
   * `ring: false`：搜尋 / branch 聚焦時被淡化的列，小球是近乎白色的淺色球（只剩淡紫色外框），不適用；回傳取樣讓呼叫端自行判斷。
   */
  const RING = Array.from({ length: 8 }, (_, k) => [
    Math.cos((k * Math.PI) / 4) * 11,
    Math.sin((k * Math.PI) / 4) * 11,
  ]);
  const graphSync = async (
    label,
    { pg = page, minRows = 6, minDist = 100, minInk = 150, ring = true } = {},
  ) => {
    let problems = [];
    let geom;
    let samples = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      geom = await visibleGeometry(pg);
      const png = await pg.screenshot();
      problems = [];
      if (geom.rows.length < minRows)
        problems.push(`only ${geom.rows.length} fully visible rows (need ≥ ${minRows})`);
      // canvas 視窗要涵蓋整個可視範圍，並且位置和 data-win-top 一致
      if (geom.winTop > geom.scrollTop + 0.5)
        problems.push(`canvas window starts at ${geom.winTop}, below scrollTop ${geom.scrollTop}`);
      if (geom.winTop + geom.hostHeight < geom.scrollTop + geom.clientHeight - 0.5)
        problems.push(
          `canvas window ends at ${geom.winTop + geom.hostHeight}, above the viewport bottom ${geom.scrollTop + geom.clientHeight}`,
        );
      if (Math.abs(geom.hostTop - geom.winTop) > 1)
        problems.push(`canvas host top ${geom.hostTop} ≠ data-win-top ${geom.winTop}`);
      for (const r of geom.rows)
        if (Math.abs(r.y - r.rowCenter) > 1.5)
          problems.push(
            `row ${r.row}: contract y ${r.y.toFixed(1)} ≠ row centre ${r.rowCenter.toFixed(1)}`,
          );
      const pts = geom.rows.flatMap((r) => [
        [r.x, r.y],
        [r.gLeft + r.gWidth - 2, r.y],
        ...RING.map(([dx, dy]) => [r.x + dx, r.y + dy]),
      ]);
      const px = pts.length ? await samplePixels(decoder, png, pts) : [];
      const per = 2 + RING.length;
      samples = geom.rows.map((r, i) => ({
        ...r,
        node: px[per * i],
        bg: px[per * i + 1],
        ring: px.slice(per * i + 2, per * (i + 1)),
      }));
      const bands = await bandInk(
        png,
        samples.map((r) => ({
          x: r.gLeft,
          y: r.rowTop + 1,
          w: r.gWidth,
          h: r.rowBottom - r.rowTop - 2,
          bg: r.bg,
        })),
      );
      samples.forEach((r, i) => {
        r.dist = colorDistance(r.node, r.bg);
        r.ink = bands[i];
        if (r.dist < minDist)
          problems.push(
            `row ${r.row} (lane ${r.lane}): node centre ${r.node.slice(0, 3)} ≈ background ${r.bg.slice(0, 3)} (distance ${r.dist})`,
          );
        if (r.ink < minInk)
          problems.push(`row ${r.row}: graph column looks blank (${r.ink} ink px)`);
        if (ring) {
          const inside = r.ring.filter((p) => colorDistance(p, r.bg) >= 60).length;
          if (inside < 7)
            problems.push(
              `row ${r.row} (lane ${r.lane}): the ball is not where the row says (only ${inside}/8 probes around its centre hit the ball)`,
            );
        }
      });
      if (!problems.length) return { ...geom, samples };
      await sleep(300);
    }
    assert.fail(
      `graph out of sync with the list (${label}):\n  ${problems.slice(0, 8).join('\n  ')}`,
    );
  };

  // ── replay 狀態記錄（MutationObserver：不會漏掉很短的 playing） ──
  const watchReplay = (pg = page) =>
    pg.evaluate(() => {
      const host = document.querySelector('.agg-canvas');
      window.__replayLog = [host.dataset.replay];
      window.__replayObs?.disconnect();
      window.__replayObs = new MutationObserver(() => {
        const v = host.dataset.replay;
        const log = window.__replayLog;
        if (log[log.length - 1] !== v) log.push(v);
      });
      window.__replayObs.observe(host, { attributes: true, attributeFilter: ['data-replay'] });
    });
  const replayLog = (pg = page) => pg.evaluate(() => window.__replayLog.slice());

  // ── 版面 / 介面 ──
  const rectOf = (sel, pg = page) =>
    pg.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    }, sel);
  const rootAttr = (name, pg = page) =>
    pg.evaluate((n) => document.querySelector('.agg-root')?.getAttribute(n) ?? null, name);
  const noOverflow = () =>
    page.evaluate(() => {
      const bad = [];
      const sc = document.querySelector('.agg-scroll');
      if (sc.scrollWidth > sc.clientWidth + 1)
        bad.push(`.agg-scroll ${sc.scrollWidth} > ${sc.clientWidth}`);
      const de = document.documentElement;
      if (de.scrollWidth > innerWidth) bad.push(`document ${de.scrollWidth} > ${innerWidth}`);
      if (document.body.scrollWidth > innerWidth)
        bad.push(`body ${document.body.scrollWidth} > ${innerWidth}`);
      for (const sel of ['.agg-title', '.agg-actions', '.agg-search', '.agg-main', '.web-bar']) {
        const el = document.querySelector(sel);
        if (!el) {
          bad.push(`${sel} is missing`);
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.right > innerWidth + 0.5)
          bad.push(
            `${sel} spans ${r.left.toFixed(0)}–${r.right.toFixed(0)} in a ${innerWidth}px viewport`,
          );
      }
      return bad;
    });

  /** 把所有「層」收掉（詳情 → 搜尋 → branch 聚焦），回到最上面；焦點放回 viewer。 */
  const resetView = async () => {
    await page.evaluate(() => document.querySelector('.agg-root').focus({ preventScroll: true }));
    for (let i = 0; i < 6; i++) {
      const open = await page.evaluate(
        () =>
          Boolean(document.querySelector('.agg-detail')) ||
          Boolean(document.querySelector('.agg-search input')?.value) ||
          Boolean(document.querySelector('.agg-branch[aria-pressed="true"]')),
      );
      if (!open) break;
      await page.keyboard.press('Escape');
      await sleep(60);
    }
    assert.equal(await page.locator('.agg-detail').count(), 0, 'detail should be closed');
    assert.equal(
      await page.locator('.agg-search input').inputValue(),
      '',
      'search should be empty',
    );
    assert.equal(await page.locator('.agg-branch[aria-pressed="true"]').count(), 0);
    await scrollTo(0);
    await page.mouse.move(720, 8); // 滑鼠移出列表：不要留 hover 底色
  };

  const branchChip = (name) =>
    page.locator('.agg-branch', {
      has: page.locator('.agg-branch-name', { hasText: new RegExp(`^${name}$`) }),
    });
  const rowFullyVisible = (sha) =>
    page.evaluate((s) => {
      const r = document.querySelector(`.agg-commit[data-sha="${s}"]`)?.getBoundingClientRect();
      const sc = document.querySelector('.agg-scroll').getBoundingClientRect();
      return Boolean(r && r.top >= sc.top - 0.5 && r.bottom <= sc.bottom + 0.5);
    }, sha);
  const waitRowVisible = async (sha, what = '') => {
    await waitUntil(
      () => rowFullyVisible(sha),
      12_000,
      `row ${what || sha.slice(0, 7)} scrolled into view`,
    );
    await settleScroll();
    assert.ok(await rowFullyVisible(sha), `row ${what || sha.slice(0, 7)} must be fully visible`);
  };

  /** 詳情面板的內容（英文介面）。 */
  const detailInfo = () =>
    page.evaluate(() => {
      const d = document.querySelector('.agg-detail');
      if (!d) return null;
      const facts = {};
      d.querySelectorAll('.agg-facts dt').forEach((dt) => {
        facts[(dt.firstChild?.textContent ?? dt.textContent).trim()] = dt.nextElementSibling;
      });
      const links = (dd) =>
        dd
          ? [...dd.querySelectorAll('button.agg-link')].map((b) => ({
              short: b.querySelector('code')?.textContent ?? '',
              subject: b.title,
            }))
          : [];
      const nav = (label) => d.querySelector(`button[aria-label="${label}"]`);
      return {
        subject: d.querySelector('.agg-detail-subject')?.textContent ?? '',
        message: d.querySelector('.agg-detail-message')?.textContent ?? null,
        sha: d.querySelector('.agg-sha-full')?.textContent ?? '',
        author:
          facts['Author']?.querySelector('.agg-link--plain')?.textContent ??
          facts['Author']?.textContent ??
          '',
        datetime: facts['Date']?.querySelector('time')?.getAttribute('datetime') ?? '',
        parentText: facts['Parents']?.textContent ?? '',
        parents: links(facts['Parents']),
        children: links(facts['Children']),
        refs: facts['Branches / tags at this commit']
          ? [...facts['Branches / tags at this commit'].querySelectorAll('.agg-ref')].map((x) => ({
              cls: x.className,
              name: x.querySelector('.agg-ref-name')?.textContent ?? '',
            }))
          : [],
        containedIn: facts['In branches']
          ? [...facts['In branches'].querySelectorAll('.agg-ref-name')].map((x) => x.textContent)
          : [],
        prevDisabled: nav('Previous (newer)')?.disabled ?? null,
        nextDisabled: nav('Next (older)')?.disabled ?? null,
        hasCta: Boolean(d.querySelector('.agg-cta')),
      };
    });
  const clickRow = (sha, how = {}) => rowLoc(sha).click({ position: { x: 150, y: 10 }, ...how });

  const readClipboard = async () => {
    await page.bringToFront();
    let last;
    for (let i = 0; i < 10; i++) {
      try {
        return await page.evaluate(() => navigator.clipboard.readText());
      } catch (e) {
        last = e;
        await sleep(200);
      }
    }
    throw last;
  };

  const tagScroller = () =>
    page.evaluate(() => {
      document.querySelector('.agg-scroll').__tag = 'same-element';
    });
  const scrollerTag = () =>
    page.evaluate(() => document.querySelector('.agg-scroll')?.__tag ?? null);

  // ═════════════════════════ 本機快照 ═════════════════════════

  await step(
    'local snapshot: title, counts, branches, real WebGL pixels in the graph column (no GitHub, no network)',
    async () => {
      await page.goto(base);
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      const all = gitLog(repoDir);
      assert.ok(all.length >= 80, `the temp repo should be long enough to scroll (${all.length})`);
      assert.equal(await commitCount(), all.length);
      const stats = await page.locator('.agg-stats .agg-chip').allInnerTexts();
      assert.match(stats[0], new RegExp(`^${all.length} commits?$|^${all.length} 個 commit$`));
      assert.match(
        stats[1],
        new RegExp(
          `^${gitBranches(repoDir).length} branch(es)?$|^${gitBranches(repoDir).length} 條分支$`,
        ),
      );
      assert.ok(
        stats.some((s) => /^1 tag$/.test(s)),
        `tags chip in ${stats}`,
      );
      assert.ok(
        stats.some((s) => /^3 authors$/.test(s)),
        `authors chip in ${stats}`,
      );
      assert.ok(
        stats.some((s) => /^1 merge$/.test(s)),
        `merges chip in ${stats}`,
      );
      assert.ok(
        stats.some((s) => /^latest /.test(s)),
        `latest chip in ${stats}`,
      );
      assert.match(await page.title(), /octo\/cat/);
      assert.equal(await page.locator('.agg-branch').count(), gitBranches(repoDir).length);
      assert.equal(await rootAttr('data-theme'), 'day');
      assert.equal(await rootAttr('data-size'), 'wide');
      assert.equal(await rootAttr('data-cols'), 'full');
      assert.equal(await rootAttr('data-detail'), null, 'no detail panel before a selection');
      // 焦點在 viewer root 上（鍵盤快捷鍵開箱即用）
      assert.equal(
        await page.evaluate(() => document.activeElement?.className),
        'agg-root',
        'keyboard focus should be taken by the viewer on mount',
      );
      const list = page.locator('.agg-scroll');
      assert.equal(await list.getAttribute('role'), 'listbox');
      await replayDone();
      await page.mouse.move(720, 8);
      await sleep(1200);
      await page.screenshot({ path: resolve(artifacts, '1-local.png') });
      // 真的有畫：線圖欄（卡通描邊的深色像素）不是空的
      const col = await page.evaluate(() => {
        const sc = document.querySelector('.agg-scroll').getBoundingClientRect();
        const g = document.querySelector('.agg-c-g').getBoundingClientRect();
        return { x: g.left, y: sc.top, width: g.width, height: sc.height };
      });
      const ratio = await inkRatio(decoder, await page.screenshot({ clip: col }));
      console.log('  ink pixel ratio in the graph column:', ratio.toFixed(4));
      assert.ok(ratio > 0.02, `graph column looks empty (${ratio})`);
      assert.deepEqual(apiCalls(), [], 'local mode must not touch the GitHub API');
    },
  );

  await step(
    'rows mirror git: count, newest first, short sha, author, date, branch/tag badges, merge pill, type chips',
    async () => {
      const all = gitLog(repoDir);
      const rows = await domRows();
      assert.equal(rows.length, all.length, 'one row per commit');
      assert.equal(rows.length, await commitCount());
      // 排序：整串 sha 與 git log --date-order 完全相同（第 0 列 = 最新的 commit）
      assert.deepEqual(
        rows.map((r) => r.sha),
        all.map((c) => c.sha),
      );
      assert.deepEqual(
        rows.map((r) => r.row),
        rows.map((_, i) => i),
      );
      assert.equal(
        rows[0].sha,
        git(repoDir, 'rev-parse', 'HEAD'),
        'first row is the newest commit',
      );
      for (let i = 1; i < rows.length; i++)
        assert.ok(
          Date.parse(rows[i - 1].datetime) >= Date.parse(rows[i].datetime),
          `row ${i} is newer than row ${i - 1}`,
        );
      const refs = gitRefs(repoDir);
      const merges = new Set(all.filter((c) => c.parents.length > 1).map((c) => c.sha));
      assert.equal(merges.size, 1);
      for (const [i, r] of rows.entries()) {
        const c = all[i];
        assert.equal(r.role, 'option');
        assert.match(r.short, /^[0-9a-f]{7}$/, `row ${i} short sha`);
        assert.equal(r.short, c.sha.slice(0, 7));
        assert.equal(r.author, c.author, `row ${i} author`);
        assert.equal(Date.parse(r.datetime), c.atMs, `row ${i} date`);
        assert.ok(r.dateText.length > 0, `row ${i} shows a date`);
        assert.match(r.dateTitle, / · /, `row ${i} date tooltip is "absolute · relative"`);
        assert.ok(r.title.startsWith(c.subject), `row ${i} title attribute carries the message`);
        // 說明欄：只有第一行；conventional 的前綴變成類型標籤（含 scope / breaking）
        const m = CONVENTIONAL.exec(c.subject);
        if (m) {
          assert.equal(r.type, `${m[1].toLowerCase()}${m[3] ?? ''}`, `row ${i} type chip`);
          assert.equal(r.scope, m[2] ?? null, `row ${i} scope`);
          assert.equal(r.subject, `${r.type}${m[2] ?? ''}${c.subject.slice(m[0].length)}`);
        } else {
          assert.equal(r.type, null, `row ${i} ("${c.subject}") must not get a type chip`);
          assert.equal(r.subject, c.subject);
        }
        assert.ok(
          !r.subject.includes('Body line') && !r.title.includes('Body line'),
          'the commit body is not part of the row',
        );
        // merge 標籤只出現在 merge commit
        assert.equal(r.merge, merges.has(c.sha), `row ${i} merge pill`);
        assert.equal(r.kind === 'merge', merges.has(c.sha), `row ${i} data-kind`);
        // ref 標籤：這個 commit 上的 branch / tag，一個不多一個不少
        const want = (refs.get(c.sha) ?? []).map((x) => x.name).sort();
        assert.deepEqual(r.refs.map((x) => x.name).sort(), want, `row ${i} ref badges`);
      }
      // 各種標籤的樣式 class 與位置
      const tip = (b) => rows.find((r) => r.sha === git(repoDir, 'rev-parse', b));
      const main = tip('main');
      assert.ok(
        main.refs.some((x) => /agg-ref--current/.test(x.cls) && /^HEAD\s*➜\s*main$/.test(x.text)),
      );
      assert.ok(
        main.refs.some((x) => /agg-ref--default/.test(x.cls)),
        'main is the default branch',
      );
      assert.equal(
        rows.filter((r) => r.refs.some((x) => /agg-ref--current/.test(x.cls))).length,
        1,
      );
      assert.ok(
        tip('feat/x').refs.some((x) => x.name === 'feat/x' && /agg-ref--branch/.test(x.cls)),
      );
      assert.ok(tip('wip/old').refs.some((x) => x.name === 'wip/old'));
      const tagged = rows.find((r) => r.sha === git(repoDir, 'rev-parse', 'v1^{commit}'));
      assert.ok(tagged.refs.some((x) => x.name === 'v1' && /agg-ref--tag/.test(x.cls)));
      assert.equal(tagged.subject.replace(/^feat/, ''), 'two');
      // 說明欄只有一行：本文只在詳情面板裡
      assert.equal(await page.locator('.agg-scroll').getByText('Body line').count(), 0);
      // 隱私：email 不出現在畫面上（舊版的 tooltip 只含第一行、不含 email）
      const html = await page.content();
      assert.ok(!html.includes('@example.test'), 'author e-mail addresses must not be rendered');
      // 尾端
      assert.match(
        await page.locator('.agg-footer').innerText(),
        /first commit lives here|最初的 commit/,
      );
      assert.equal(await page.locator('.agg-tip').count(), 0, 'the old tooltip is gone');
      assert.equal(
        await page.getByRole('button', { name: /^(全景|Fit)$/ }).count(),
        0,
        'no Fit button',
      );
    },
  );

  await step(
    'header: Jump to latest scrolls to the top, Replay plays again; hover shows no tooltip',
    async () => {
      await resetView();
      const first = (await domRows())[0].sha;
      await scrollTo(1500);
      assert.equal(await rowFullyVisible(first), false);
      await page.getByRole('button', { name: /^(Jump to latest|回到最新)$/ }).click();
      await waitUntil(async () => (await scrollTopNow()) === 0, 12_000, 'Jump to latest');
      assert.ok(await rowFullyVisible(first), 'the newest commit is on screen again');
      await replayDone();
      await watchReplay();
      await page.getByRole('button', { name: /^(Replay|重播)$/ }).click();
      await waitUntil(
        async () => (await replayLog()).includes('playing'),
        10_000,
        'replay to start',
      );
      await replayDone();
      assert.deepEqual(await replayLog(), ['done', 'playing', 'done']);
      // 滑過列與線圖欄：沒有 tooltip（互動全在 DOM 列上）
      const g = await visibleGeometry();
      await page.mouse.move(g.rows[2].gLeft + 20, g.rows[2].rowCenter);
      await page.mouse.move(700, g.rows[4].rowCenter, { steps: 6 });
      await sleep(400);
      assert.equal(await page.locator('.agg-tip').count(), 0);
      await page.mouse.move(720, 8);
    },
  );

  // ═════════════════════════ 捲動 ↔ 線圖同步 ═════════════════════════

  await step(
    'scroll sync: the graph stays aligned with the rows at the top, +123px, middle, a re-centering jump, wheel and the end',
    async () => {
      await resetView();
      await replayDone();
      const wins = new Set();
      const checks = [];
      const at = async (label, top) => {
        await scrollTo(top);
        const g = await graphSync(label);
        wins.add(g.winTop);
        checks.push({ label, top: g.scrollTop, win: g.winTop, rows: g.rows.length });
        return g;
      };
      const g0 = await at('top', 0);
      assert.equal(g0.rows[0].row, 0, 'row 0 is at the top');
      await page.screenshot({ path: resolve(artifacts, '2-scroll-top.png') });
      await at('+123px', 123);
      const mid = Math.round((await scrollMax()) / 2);
      const gMid = await at('middle', mid);
      // 大跳躍：距離遠大於 canvas 的上下緩衝，視窗必須重新置中，位置要換
      const before = gMid.winTop;
      const jumped = await at('big jump (re-centre)', Math.round(mid * 0.3));
      assert.notEqual(jumped.winTop, before, 'canvas window must re-centre after a large jump');
      assert.ok(wins.size >= 3, `data-win-top should have moved (saw ${[...wins]})`);
      await page.screenshot({ path: resolve(artifacts, '2-scroll-jump.png') });
      // 真正的滑鼠滾輪（不是直接改 scrollTop）：捲動的是列表，不是縮放 / 頁面
      await page.mouse.move(720, 600);
      await page.mouse.wheel(0, 900);
      await waitUntil(
        async () => (await scrollTopNow()) > jumped.scrollTop + 500,
        8000,
        'wheel scroll',
      );
      await settleScroll();
      const gWheel = await graphSync('after the mouse wheel');
      assert.ok(gWheel.scrollTop > jumped.scrollTop + 500);
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'the page itself must not scroll');
      // 最底：最舊的 commit（root）與頁尾都看得到，小球也畫出來了
      const end = await at('end', await scrollMax());
      const rows = await domRows();
      const lastSha = rows[rows.length - 1].sha;
      assert.ok(
        end.rows.some((r) => r.sha === lastSha),
        'the root commit is visible at the end',
      );
      assert.ok(
        await page.evaluate(() => {
          const f = document.querySelector('.agg-footer').getBoundingClientRect();
          const s = document.querySelector('.agg-scroll').getBoundingClientRect();
          return f.top >= s.top && f.bottom <= s.bottom + 1;
        }),
        'the footer is visible at the end',
      );
      await page.screenshot({ path: resolve(artifacts, '2-scroll-end.png') });
      console.log(
        '  sync checks:',
        checks.map((c) => `${c.label}@${c.top}/win${c.win}`).join(', '),
      );
      await scrollTo(0);
    },
  );

  // ═════════════════════════ 搜尋 ═════════════════════════

  await step(
    'search: dims non-matches, counter + filter chip, Enter / Shift+Enter / chevrons step, layered Escape',
    async () => {
      await resetView();
      const input = page.locator('.agg-search input');
      assert.equal(await input.getAttribute('aria-label'), 'Search commits');
      const all = gitLog(repoDir);

      // ① 子字串（不分大小寫）
      const side = expectMatches(repoDir, 'side');
      assert.equal(side.length, 4, 'sanity: four "side" commits in the temp repo');
      await input.fill('SIDE');
      await waitLit(side, 'search "SIDE"');
      assert.equal((await dimmedShas()).length, all.length - side.length);
      assert.equal(
        await page.locator('.agg-stats .agg-chip').first().getAttribute('class'),
        'agg-chip agg-chip--filter',
        'the filter chip comes first',
      );
      assert.equal(
        await page.locator('.agg-chip--filter').innerText(),
        `Showing 4 of ${all.length} commits`,
      );
      assert.equal(await page.locator('.agg-search-count').innerText(), '0 / 4');
      // 統計列的其他 chip 還在，且仍是真實總數
      assert.equal(await commitCount(), all.length);

      // ② Enter：選第一個符合的（最新的）、開詳情、置中
      await input.press('Enter');
      await waitSelected(side[0], 'first match');
      assert.equal(await page.locator('.agg-search-count').innerText(), '1 / 4');
      assert.equal((await detailInfo()).sha, side[0]);
      await waitRowVisible(side[0], 'first match');
      await settleScroll();
      const centered = await page.evaluate((s) => {
        const r = document.querySelector(`.agg-commit[data-sha="${s}"]`).getBoundingClientRect();
        const sc = document.querySelector('.agg-scroll');
        const b = sc.getBoundingClientRect();
        return {
          off: Math.abs(r.top + r.height / 2 - (b.top + b.height / 2)),
          atEdge: sc.scrollTop <= 1 || sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1,
        };
      }, side[0]);
      assert.ok(
        centered.off <= 66 || centered.atEdge,
        `match not centred (off by ${centered.off}px)`,
      );
      await input.press('Enter');
      await waitSelected(side[1], 'second match');
      assert.equal(await page.locator('.agg-search-count').innerText(), '2 / 4');
      await input.press('Shift+Enter');
      await waitSelected(side[0], 'Shift+Enter goes back');
      assert.equal(await page.locator('.agg-search-count').innerText(), '1 / 4');
      await input.press('Shift+Enter'); // 繞到最後一筆
      await waitSelected(side[3], 'wrap to the last match');
      assert.equal(await page.locator('.agg-search-count').innerText(), '4 / 4');
      await page.getByRole('button', { name: 'Next match' }).click();
      await waitSelected(side[0], 'chevron next wraps to the first');
      await page.getByRole('button', { name: 'Previous match' }).click();
      await waitSelected(side[3], 'chevron previous');
      await page.screenshot({ path: resolve(artifacts, '3-search.png') });

      // 輸入法選字中：Enter 是確認候選字、Escape 是取消組字，都不能跳轉 / 清除
      await input.focus();
      await input.evaluate((el) => {
        for (const key of ['Enter', 'Escape'])
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              isComposing: true,
              bubbles: true,
              cancelable: true,
            }),
          );
      });
      await sleep(250);
      assert.equal(
        await input.inputValue(),
        'SIDE',
        'Escape during IME composition must not clear the text',
      );
      assert.equal(await selectedSha(), side[3], 'Enter during IME composition must not step');
      assert.equal(await page.locator('.agg-search-count').innerText(), '4 / 4');

      // ③ 輸入框裡的 Escape：先清掉文字（詳情還開著），再一次 Escape 才關詳情
      await page.keyboard.press('Escape');
      await waitUntil(
        async () => (await input.inputValue()) === '',
        5000,
        'Escape clears the text',
      );
      assert.equal((await dimmedShas()).length, 0, 'clearing the text un-dims every row');
      assert.equal(await page.locator('.agg-chip--filter').count(), 0);
      assert.equal(await page.locator('.agg-search-count').count(), 0);
      assert.equal(await selectedSha(), side[3], 'the first Escape only clears the search text');
      assert.equal(await page.locator('.agg-detail').count(), 1);
      await page.keyboard.press('Escape');
      await waitUntil(
        async () => (await selectedSha()) === null,
        5000,
        'second Escape closes the detail',
      );
      assert.equal(await page.locator('.agg-detail').count(), 0);

      // ④ 多個詞（AND）、作者、tag / branch 名稱、sha、沒有結果
      for (const q of [
        'ben side',
        'v1',
        'feat/x',
        'wip',
        all[40].sha.slice(0, 7),
        'Parser input',
      ]) {
        const want = expectMatches(repoDir, q);
        assert.ok(want.length >= 1 && want.length < all.length, `sanity: "${q}" → ${want.length}`);
        await input.fill(q);
        await waitLit(want, `search "${q}"`);
        assert.equal(
          await page.locator('.agg-chip--filter').innerText(),
          `Showing ${want.length} of ${all.length} commits`,
        );
      }
      assert.deepEqual(
        expectMatches(repoDir, 'ben side'),
        side,
        'Ben wrote all the "side" commits',
      );
      await input.fill('cat side');
      await waitLit([], 'two terms that never co-occur');
      assert.equal(await page.locator('.agg-search-count').innerText(), 'No matching commits');
      assert.equal(await page.getByRole('button', { name: 'Next match' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Previous match' }).isDisabled(), true);
      await input.press('Enter');
      await sleep(300);
      assert.equal(await selectedSha(), null, 'Enter without matches selects nothing');

      // ⑤ 在輸入框打字不會觸發 j / k / ／ 快捷鍵（也不會移動選取）
      await input.fill('');
      await input.focus();
      await page.keyboard.type('jk/');
      assert.equal(await input.inputValue(), 'jk/');
      assert.equal(await selectedSha(), null);
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await selectedSha(),
        null,
        'arrow keys inside the search box do not move the selection',
      );
      // 清除按鈕：清空並把焦點留在輸入框
      await page.getByRole('button', { name: 'Clear search' }).click();
      assert.equal(await input.inputValue(), '');
      assert.equal(
        await page.evaluate(() => document.activeElement?.closest('.agg-search') !== null),
        true,
      );
      assert.equal((await dimmedShas()).length, 0);
    },
  );

  // ═════════════════════════ branch 聚焦 ═════════════════════════

  await step(
    'branch focus chip: aria-pressed, unreachable rows dim (and their balls fade), scrolls to the tip, Escape / second click clears',
    async () => {
      await resetView();
      await replayDone();
      const all = gitLog(repoDir);
      const chip = branchChip;
      const reach = (b) => git(repoDir, 'rev-list', b).split('\n').filter(Boolean);

      // feat/x：不是它祖先的 commit 全部淡化（以 git rev-list 為準）
      await chip('feat/x').click();
      assert.equal(await chip('feat/x').getAttribute('aria-pressed'), 'true');
      const featReach = reach('feat/x');
      await waitLit(featReach, 'focus feat/x');
      assert.equal((await dimmedShas()).length, all.length - featReach.length);
      assert.equal(
        await page.locator('.agg-chip--filter').innerText(),
        `Showing ${featReach.length} of ${all.length} commits`,
      );
      // 鏡頭（捲動）移到它的 tip
      const featTip = git(repoDir, 'rev-parse', 'feat/x');
      await waitRowVisible(featTip, 'feat/x tip');
      assert.equal(await page.locator('.agg-branch[aria-pressed="true"]').count(), 1);
      await page.screenshot({ path: resolve(artifacts, '4-branch-focus.png') });

      // 換一條：只有最後點的那條是 pressed
      await chip('wip/old').click();
      assert.equal(await chip('wip/old').getAttribute('aria-pressed'), 'true');
      assert.equal(await chip('feat/x').getAttribute('aria-pressed'), 'false');
      const wipReach = reach('wip/old');
      await waitLit(wipReach, 'focus wip/old');
      await waitRowVisible(git(repoDir, 'rev-parse', 'wip/old'), 'wip/old tip');
      // WebGL 線圖也跟著淡化：被淡化的列，小球變成低彩度的淺色（只剩淡紫色外框）；亮的列是鮮豔的 branch 顏色
      let seen = { dim: 0, lit: 0 };
      await waitUntil(
        async () => {
          const g = await graphSync('branch focus', {
            minRows: 6,
            minDist: 0,
            minInk: 30,
            ring: false,
          });
          const sat = (p) => Math.max(...p.slice(0, 3)) - Math.min(...p.slice(0, 3));
          const dimSet = new Set(await dimmedShas());
          const dimRows = g.samples.filter((r) => dimSet.has(r.sha));
          const litRows = g.samples.filter((r) => !dimSet.has(r.sha));
          seen = { dim: dimRows.length, lit: litRows.length };
          return (
            dimRows.length >= 2 &&
            litRows.length >= 2 &&
            dimRows.every((r) => sat(r.node) < 40) &&
            litRows.every((r) => sat(r.node) > 80 && r.dist >= 100)
          );
        },
        15_000,
        `graph nodes fade with the rows (dim ${seen.dim}, lit ${seen.lit})`,
      );
      // 再點一次 → 取消
      await chip('wip/old').click();
      assert.equal(await chip('wip/old').getAttribute('aria-pressed'), 'false');
      await waitLit(
        all.map((c) => c.sha),
        'second click clears the focus',
      );
      assert.equal(await page.locator('.agg-chip--filter').count(), 0);

      // Escape 取消（焦點在 chip 按鈕上：事件會冒泡到 viewer）
      await chip('feat/x').click();
      await waitLit(featReach, 'focus feat/x again');
      await page.keyboard.press('Escape');
      assert.equal(await chip('feat/x').getAttribute('aria-pressed'), 'false');
      await waitLit(
        all.map((c) => c.sha),
        'Escape clears the focus',
      );
      await settleScroll();
    },
  );

  await step('Escape closes ONE layer at a time: detail → search text → branch focus', async () => {
    await resetView();
    const input = page.locator('.agg-search input');
    await page.locator('.agg-branch', { hasText: 'feat/x' }).click();
    await input.fill('side');
    const want = expectMatches(repoDir, 'side').filter((s) =>
      git(repoDir, 'rev-list', 'feat/x').split('\n').includes(s),
    );
    await waitLit(want, 'search ∩ branch focus');
    assert.equal(
      await page.locator('.agg-chip--filter').innerText(),
      `Showing ${want.length} of ${expected} commits`,
    );
    await clickRow(want[1]); // 點列：焦點在列表容器上（不是輸入框）
    await waitSelected(want[1], 'row click');
    await page.keyboard.press('Escape');
    await waitUntil(async () => (await selectedSha()) === null, 5000, 'Escape 1 closes the detail');
    assert.equal(await input.inputValue(), 'side', 'search text survives the first Escape');
    assert.equal(await page.locator('.agg-branch[aria-pressed="true"]').count(), 1);
    await page.keyboard.press('Escape');
    await waitUntil(
      async () => (await input.inputValue()) === '',
      5000,
      'Escape 2 clears the text',
    );
    assert.equal(
      await page.locator('.agg-branch[aria-pressed="true"]').count(),
      1,
      'branch focus survives',
    );
    assert.ok((await dimmedShas()).length > 0, 'branch focus is still dimming rows');
    await page.keyboard.press('Escape');
    await waitUntil(
      async () => (await page.locator('.agg-branch[aria-pressed="true"]').count()) === 0,
      5000,
      'Escape 3 clears the branch focus',
    );
    assert.equal((await dimmedShas()).length, 0);
    // 都沒有了：再按 Escape 什麼事也不會發生（網頁版沒有 overlay 可關）
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.agg-scroll').count(), 1);
  });

  // ═════════════════════════ 詳情面板 ═════════════════════════

  await step(
    'detail panel: row click, content, parents / children / prev / next jump, deselect, Open on GitHub (new tab), Copy SHA',
    async () => {
      await resetView();
      const all = gitLog(repoDir);
      const parserCommit = all.find((c) => c.subject === 'feat: add parser');
      const idx = all.indexOf(parserCommit);
      const wideList = (await rectOf('.agg-scroll')).width;

      // ① 點列：選取、a11y 屬性、詳情面板與內容
      await clickRow(parserCommit.sha);
      await waitSelected(parserCommit.sha, 'parser commit');
      assert.equal(await rootAttr('data-detail'), '', 'data-detail while a commit is selected');
      const rows = await domRows();
      assert.equal(rows.filter((r) => r.selected).length, 1);
      assert.equal(rows[idx].ariaSelected, 'true');
      assert.equal(
        await page.locator('.agg-scroll').getAttribute('aria-activedescendant'),
        `agg-row-${parserCommit.sha}`,
      );
      let d = await detailInfo();
      assert.equal(d.subject, parserCommit.subject);
      assert.match(d.sha, /^[0-9a-f]{40}$/);
      assert.equal(d.sha, parserCommit.sha);
      assert.equal(
        d.message,
        null,
        'local snapshots carry only the first line: there is no commit body to show',
      );
      assert.ok(!(await page.content()).includes('Body line'), 'the commit body is never rendered');
      assert.equal(d.author, parserCommit.author);
      assert.equal(Date.parse(d.datetime), parserCommit.atMs);
      assert.deepEqual(
        d.parents.map((p) => p.short),
        parserCommit.parents.map((p) => p.slice(0, 7)),
      );
      assert.deepEqual(
        d.children.map((p) => p.short),
        all.filter((c) => c.parents.includes(parserCommit.sha)).map((c) => c.sha.slice(0, 7)),
      );
      assert.deepEqual(
        d.containedIn.sort(),
        git(repoDir, 'branch', '--contains', parserCommit.sha, '--format=%(refname:short)')
          .split('\n')
          .filter(Boolean)
          .sort(),
        '"In branches" matches git branch --contains',
      );
      assert.ok(d.hasCta, 'Open on GitHub is offered (the commit has a url)');
      // wide：詳情靠右並排，列表變窄、兩者不重疊
      const detailRect = await rectOf('.agg-detail');
      const mainRect = await rectOf('.agg-main');
      assert.ok(detailRect.left >= mainRect.right - 0.5, 'docked detail must not overlap the list');
      assert.ok(
        (await rectOf('.agg-scroll')).width < wideList - 300,
        'the list narrows when the detail docks',
      );
      await page.screenshot({ path: resolve(artifacts, '5-detail.png') });

      // 點作者名稱 = 以作者搜尋（詳情維持開啟）
      await page.locator('.agg-detail .agg-link--plain').click();
      const byAuthor = expectMatches(repoDir, parserCommit.author);
      assert.ok(byAuthor.length > 10 && byAuthor.length < all.length, `sanity: ${byAuthor.length}`);
      assert.equal(await page.locator('.agg-search input').inputValue(), parserCommit.author);
      await waitLit(byAuthor, 'search by author from the detail');
      assert.equal(await selectedSha(), parserCommit.sha, 'the detail stays open');
      await page.getByRole('button', { name: 'Clear search' }).click();
      await waitLit(
        all.map((c) => c.sha),
        'search cleared',
      );

      // ② parent / child 連結：跳到那個 commit
      await page
        .locator('.agg-detail button.agg-link', { hasText: all[idx + 1].subject })
        .first()
        .click();
      await waitSelected(all[idx + 1].sha, 'parent link');
      assert.equal((await detailInfo()).subject, all[idx + 1].subject);
      // child 連結（回到 parser commit：它是 idx + 1 的 child）
      await page
        .locator('.agg-detail .agg-stack button.agg-link', { hasText: parserCommit.subject })
        .first()
        .click();
      await waitSelected(parserCommit.sha, 'child link');
      // 上一個（較新）/ 下一個（較舊）
      await page.getByRole('button', { name: 'Previous (newer)' }).click();
      await waitSelected(all[idx - 1].sha, 'previous (newer)');
      await page.getByRole('button', { name: 'Next (older)' }).click();
      await waitSelected(parserCommit.sha, 'next (older)');
      await page.getByRole('button', { name: 'Next (older)' }).click();
      await waitSelected(all[idx + 1].sha, 'next (older) again');
      await waitRowVisible(all[idx + 1].sha, 'next row');

      // ③ merge commit（上一步的 parent 連結剛好把我們帶到這裡）：兩個 parent，第二個連結跳到 feat/x 的 tip
      const mergeCommit = all.find((c) => c.parents.length === 2);
      assert.equal(
        mergeCommit.sha,
        all[idx + 1].sha,
        'sanity: the parser commit sits right on top of the merge',
      );
      assert.equal(await selectedSha(), mergeCommit.sha);
      d = await detailInfo();
      assert.equal(d.parents.length, 2);
      assert.match(d.parentText, /merges 2 lines of history/);
      await page.locator('.agg-detail .agg-stack button.agg-link').nth(1).click();
      await waitSelected(mergeCommit.parents[1], 'second parent');
      assert.equal(mergeCommit.parents[1], git(repoDir, 'rev-parse', 'feat/x'));
      d = await detailInfo();
      assert.deepEqual(
        d.refs.map((x) => x.name),
        ['feat/x'],
      );

      // ④ tag 與 root commit
      const tagged = all.find((c) => c.subject === 'feat: two');
      await clickRow(tagged.sha);
      await waitSelected(tagged.sha, 'tagged commit');
      d = await detailInfo();
      assert.ok(d.refs.some((x) => x.name === 'v1' && /agg-ref--tag/.test(x.cls)));
      const rootCommit = all[all.length - 1];
      await clickRow(rootCommit.sha);
      await waitSelected(rootCommit.sha, 'root commit');
      d = await detailInfo();
      assert.match(d.parentText, /Initial commit \(no parent\)/);
      assert.equal(d.parents.length, 0);
      assert.equal(d.nextDisabled, true, 'the oldest commit has no "next (older)"');
      assert.equal(d.prevDisabled, false);
      assert.equal(
        d.containedIn.length,
        gitBranches(repoDir).length,
        'the root is in every branch',
      );

      // ⑤ 再點同一列 → 取消選取
      await clickRow(rootCommit.sha);
      await waitUntil(async () => (await selectedSha()) === null, 5000, 'second click deselects');
      assert.equal(await page.locator('.agg-detail').count(), 0);
      assert.equal(await rootAttr('data-detail'), null);
      assert.equal(
        await page.locator('.agg-scroll').getAttribute('aria-activedescendant'),
        null,
        'aria-activedescendant is dropped with the selection',
      );
      await waitUntil(
        async () => Math.abs((await rectOf('.agg-scroll')).width - wideList) < 1,
        5000,
        'the list gets its width back',
      );
    },
  );

  await step(
    'detail: Open on GitHub opens the commit page in a NEW tab (url derived from origin)',
    async () => {
      await resetView();
      const target = gitLog(repoDir)[5];
      await clickRow(target.sha);
      await waitSelected(target.sha, 'row 5');
      const tabs = ctx.pages().length;
      const [popup] = await Promise.all([
        ctx.waitForEvent('page'),
        page.getByRole('button', { name: 'Open on GitHub' }).click(),
      ]);
      await popup.waitForURL(/github\.com/);
      assert.equal(popup.url(), `https://github.com/octo/cat/commit/${target.sha}`);
      assert.match(popup.url(), /^https:\/\/github\.com\/octo\/cat\/commit\/[0-9a-f]{40}$/);
      assert.equal(ctx.pages().length, tabs + 1, 'a new tab, not a navigation of the viewer');
      assert.equal(new URL(page.url()).origin, base, 'the viewer tab stays where it was');
      await popup.close();
      await page.bringToFront();
      assert.equal(await selectedSha(), target.sha, 'the selection survives opening GitHub');
    },
  );

  await step(
    'detail: Copy SHA (detail + row button) shows the copied state and fills the clipboard',
    async () => {
      await resetView();
      const target = gitLog(repoDir)[3];
      await clickRow(target.sha);
      await waitSelected(target.sha, 'row 3');
      const btn = page.locator('.agg-detail .agg-mini-btn');
      assert.equal(await btn.getAttribute('aria-label'), 'Copy SHA');
      assert.equal(await btn.getAttribute('data-state'), 'idle');
      await page.evaluate(() => navigator.clipboard.writeText('stale'));
      await btn.click();
      await page
        .locator('.agg-detail .agg-mini-btn[data-state="ok"]')
        .waitFor({ timeout: 5000 * SCALE });
      assert.match(await btn.innerText(), /Copied/);
      assert.equal(await readClipboard(), target.sha, 'the full 40-hex sha is in the clipboard');
      await waitUntil(
        async () => (await btn.getAttribute('data-state')) === 'idle',
        5000,
        'copied state resets after ~1.3s',
      );
      assert.match(await btn.innerText(), /Copy SHA/);

      // 列上的 sha 按鈕：複製完整 sha、顯示 ✓、而且不會順便選取那一列
      await resetView();
      const other = gitLog(repoDir)[7];
      await page.evaluate(() => navigator.clipboard.writeText('stale'));
      await rowLoc(other.sha).locator('.agg-sha').click();
      await rowLoc(other.sha)
        .locator('.agg-sha[data-state="ok"]')
        .waitFor({ timeout: 5000 * SCALE });
      assert.equal(await readClipboard(), other.sha);
      assert.equal(await selectedSha(), null, 'copying must not select the row');
      assert.equal(await page.locator('.agg-detail').count(), 0);
      await waitUntil(
        async () =>
          (await rowLoc(other.sha).locator('.agg-sha').getAttribute('data-state')) === 'idle',
        5000,
        'row copy state resets',
      );
    },
  );

  await step(
    'detail: closing it (or running into a disabled Next) gives keyboard focus back to the viewer',
    async () => {
      await resetView();
      const all = gitLog(repoDir);
      await clickRow(all[4].sha);
      await waitSelected(all[4].sha, 'row 4');
      await page.getByRole('button', { name: 'Close details' }).click();
      await waitUntil(async () => (await selectedSha()) === null, 5000, 'detail closed');
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'agg-root');
      await page.keyboard.press('ArrowDown'); // 焦點回到 viewer，快捷鍵才有用
      await waitUntil(
        async () => (await selectedSha()) !== null,
        5000,
        'ArrowDown selects after closing',
      );
      assert.equal(
        await selectedSha(),
        all[0].sha,
        'ArrowDown with no selection takes the first visible row',
      );
      // 走到最後一列：焦點原本在「下一個」按鈕上，按鈕被 disable 之後焦點必須收回來
      await page.keyboard.press('End');
      await waitSelected(all[all.length - 1].sha, 'End');
      await page.keyboard.press('k');
      await waitSelected(all[all.length - 2].sha, 'k');
      await page.getByRole('button', { name: 'Next (older)' }).click();
      await waitSelected(all[all.length - 1].sha, 'Next (older) to the end');
      assert.equal(await page.getByRole('button', { name: 'Next (older)' }).isDisabled(), true);
      await page.keyboard.press('k');
      await waitSelected(all[all.length - 2].sha, 'k after the Next button got disabled');
      await resetView();
    },
  );

  // ═════════════════════════ 鍵盤 ═════════════════════════

  await step(
    'keyboard: j k ↓ ↑ Home End move the selection (and scroll it into view); / focuses search',
    async () => {
      await resetView();
      const all = gitLog(repoDir);
      const press = async (key, wantIdx, what) => {
        await page.keyboard.press(key);
        await waitSelected(all[wantIdx].sha, `${what} → row ${wantIdx}`);
        await waitRowVisible(all[wantIdx].sha, `${what} → row ${wantIdx}`);
      };
      await press('ArrowDown', 0, 'ArrowDown from nothing');
      await press('j', 1, 'j');
      await press('ArrowDown', 2, 'ArrowDown');
      await press('k', 1, 'k');
      await press('ArrowUp', 0, 'ArrowUp');
      await press('ArrowUp', 0, 'ArrowUp at the top clamps');
      await press('End', all.length - 1, 'End');
      await press('ArrowDown', all.length - 1, 'ArrowDown at the end clamps');
      await press('Home', 0, 'Home');
      assert.equal((await scrollTopNow()) <= 4, true, 'Home scrolls back to the top');
      await press('End', all.length - 1, 'End');
      await press('k', all.length - 2, 'k');
      await press('Home', 0, 'Home');
      // 修飾鍵不是快捷鍵；輸入法選字中也不是
      await page.keyboard.press('Control+j');
      await page.keyboard.press('Alt+ArrowDown');
      await page.evaluate(() => {
        document.querySelector('.agg-root').dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'j',
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await sleep(200);
      assert.equal(
        await selectedSha(),
        all[0].sha,
        'modifier / IME keystrokes must not move the selection',
      );

      // 沒有選取時，ArrowDown 選「目前畫面最上面那一列」
      await page.keyboard.press('Escape');
      await waitUntil(async () => (await selectedSha()) === null, 5000, 'Escape closes the detail');
      await scrollTo(1000);
      // 畫面最上面（至少部分可見）的那一列
      const topRow = await page.evaluate(() => {
        const scr = document.querySelector('.agg-scroll').getBoundingClientRect();
        const el = [...document.querySelectorAll('.agg-commit')].find(
          (r) => r.getBoundingClientRect().bottom > scr.top + 1,
        );
        return Number(el.dataset.row);
      });
      assert.ok(topRow > 10);
      await page.keyboard.press('ArrowDown');
      await waitSelected(all[topRow].sha, 'ArrowDown picks the first visible row');
      await waitRowVisible(all[topRow].sha, 'first visible row');
      await page.keyboard.press('Escape');
      await waitUntil(async () => (await selectedSha()) === null, 5000, 'Escape closes the detail');

      // '/' 聚焦搜尋框，而且不會把 '/' 打進去
      await page.keyboard.press('/');
      assert.equal(
        await page.evaluate(
          () => document.activeElement === document.querySelector('.agg-search input'),
        ),
        true,
        '/ focuses the search box',
      );
      assert.equal(await page.locator('.agg-search input').inputValue(), '');
      await page.keyboard.type('j');
      assert.equal(await selectedSha(), null);
      assert.equal(await page.locator('.agg-search input').inputValue(), 'j');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.agg-search input').inputValue(), '');
      await resetView();
    },
  );

  // ═════════════════════════ RWD ═════════════════════════

  await step(
    'responsive: wide / medium / narrow — no horizontal overflow, aligned columns, detail never covers the selected row',
    async () => {
      await resetView();
      const all = gitLog(repoDir);
      const select = async (sha) => {
        await clickRow(sha);
        await waitSelected(sha, 'rwd select');
        await sleep(250);
      };
      const sizeOf = (w, h, size) =>
        page
          .setViewportSize({ width: w, height: h })
          .then(() => page.locator(`.agg-root[data-size="${size}"]`).waitFor())
          .then(() => settleScroll());
      // 欄位對齊：標題列的 作者 / 日期 / commit 與第一列的同名欄位同 left / width
      const columnsAlign = async (names) => {
        const m = await page.evaluate((cols) => {
          const row = document.querySelector('.agg-commit');
          const head = document.querySelector('.agg-colhead');
          return cols.map((c) => {
            const a = row.querySelector(`.${c}`).getBoundingClientRect();
            const b = head.querySelector(`.${c}`).getBoundingClientRect();
            return {
              c,
              dl: Math.abs(a.left - b.left),
              dw: Math.abs(a.width - b.width),
              w: a.width,
            };
          });
        }, names);
        for (const x of m) {
          assert.ok(
            x.dl <= 1 && x.dw <= 1,
            `column ${x.c} drifts from its header (Δleft ${x.dl}, Δwidth ${x.dw})`,
          );
          assert.ok(x.w > 20, `column ${x.c} has no width`);
        }
      };

      // 欄位組合（data-cols）決定哪些欄位看得到：完整 / 只留頭像 + 相對時間 / 只剩 sha（窄螢幕另有兩行式的排法）
      const colsInvariant = async (label) => {
        const cols = await rootAttr('data-cols');
        const vis = await page.evaluate(() => {
          const row = document.querySelector('.agg-commit');
          const shown = (el) =>
            Boolean(el) &&
            getComputedStyle(el).display !== 'none' &&
            el.getBoundingClientRect().width > 0;
          return {
            name: shown(row.querySelector('.agg-author-name')),
            avatar: shown(row.querySelector('.agg-avatar')),
            date: shown(row.querySelector('.agg-c-date')),
            abs: shown(row.querySelector('.agg-date-abs')),
            rel: shown(row.querySelector('.agg-date-rel')),
            sha: shown(row.querySelector('.agg-sha')),
          };
        });
        const want = {
          full: { name: true, avatar: true, date: true, abs: true, rel: false, sha: true },
          compact: { name: false, avatar: true, date: true, abs: false, rel: true, sha: true },
          min: { name: false, avatar: false, date: false, abs: false, rel: false, sha: true },
        }[cols];
        assert.ok(want, `${label}: unknown data-cols ${cols}`);
        assert.deepEqual(vis, want, `${label}: visible columns for data-cols=${cols}`);
        return cols;
      };

      // ── wide（1440）──
      await sizeOf(1440, 900, 'wide');
      assert.deepEqual(await noOverflow(), []);
      assert.equal(await colsInvariant('wide'), 'full');
      assert.ok(
        await page.locator('.agg-colhead').isVisible(),
        'the column header is shown in wide mode',
      );
      await columnsAlign(['agg-c-author', 'agg-c-date', 'agg-c-sha']);
      await graphSync('wide');
      // 版面尺寸改變（列高 44 ↔ 62、視窗高度改變）時，畫面最上面的 commit 不變（以 sha 錨定，不是以像素）
      await scrollTo(1100);
      const topSha = () =>
        page.evaluate(() => {
          const scr = document.querySelector('.agg-scroll').getBoundingClientRect();
          return [...document.querySelectorAll('.agg-commit')].find(
            (r) => r.getBoundingClientRect().bottom > scr.top + 1,
          ).dataset.sha;
        });
      const anchored = await topSha();
      for (const [w, h, size] of [
        [390, 844, 'narrow'],
        [820, 900, 'medium'],
        [1440, 900, 'wide'],
      ]) {
        await sizeOf(w, h, size);
        assert.equal(
          await topSha(),
          anchored,
          `${size}: the commit at the top of the viewport changed when the layout resized`,
        );
      }
      await scrollTo(0);
      await select(all[6].sha);
      assert.deepEqual(await noOverflow(), []);
      await columnsAlign(['agg-c-author', 'agg-c-date', 'agg-c-sha']);
      assert.equal(
        await colsInvariant('wide + detail'),
        'full',
        'plenty of room: still full columns next to the detail',
      );
      const dm = await rectOf('.agg-main');
      const dd = await rectOf('.agg-detail');
      assert.ok(
        dd.left >= dm.right - 0.5 && dd.right <= 1440 + 0.5,
        'wide: list and detail are disjoint and on screen',
      );
      await graphSync('wide + detail');
      await resetView();

      // ── 1100：欄位組合由「列表實際寬度」決定：詳情靠右並排時作者名稱收起來（compact）──
      await sizeOf(1100, 900, 'wide');
      assert.equal(await rootAttr('data-cols'), 'full');
      await select(all[6].sha);
      await waitUntil(
        async () => (await rootAttr('data-cols')) !== 'full',
        5000,
        'columns compact next to the detail',
      );
      assert.equal(
        await colsInvariant('1100 + detail'),
        'compact',
        'the detail takes the room the author column needed',
      );
      await columnsAlign(['agg-c-date', 'agg-c-sha']);
      assert.deepEqual(await noOverflow(), []);
      await graphSync('1100 + detail');
      await resetView();
      await waitUntil(
        async () => (await rootAttr('data-cols')) === 'full',
        5000,
        'columns expand again',
      );

      // ── medium（820）：詳情是浮在右側的抽屜 ──
      await sizeOf(820, 900, 'medium');
      assert.deepEqual(await noOverflow(), []);
      const midCols = await colsInvariant('medium');
      assert.equal(
        await page.locator('.agg-colhead .agg-c-date').isVisible(),
        midCols !== 'min',
        'the DATE header follows the column set',
      );
      if (midCols !== 'min') await columnsAlign(['agg-c-date', 'agg-c-sha']);
      await graphSync('medium');
      await select(all[6].sha);
      assert.deepEqual(await noOverflow(), []);
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.querySelector('.agg-detail')).position),
        'absolute',
      );
      const md = await rectOf('.agg-detail');
      assert.ok(
        md.left >= 0 && md.right <= 820 + 0.5 && md.width <= 400.5,
        `drawer spans ${md.left}–${md.right}`,
      );
      await graphSync('medium + drawer');
      await page.screenshot({ path: resolve(artifacts, '6-medium.png') });
      await resetView();

      // ── narrow（390×844）：兩行式的列、底部面板 ──
      await sizeOf(390, 844, 'narrow');
      assert.deepEqual(await noOverflow(), []);
      assert.equal(await rootAttr('data-cols'), 'min');
      assert.equal(
        await page.locator('.agg-colhead').isVisible(),
        false,
        'narrow has no column header',
      );
      const rowsNow = await visibleGeometry();
      assert.equal(
        rowsNow.rows[1].rowBottom - rowsNow.rows[1].rowTop >= 61,
        true,
        'two-line rows are taller',
      );
      const lines = await page.evaluate(() => {
        const row = document.querySelector('.agg-commit');
        const s = row.querySelector('.agg-subject').getBoundingClientRect();
        const a = row.querySelector('.agg-c-author').getBoundingClientRect();
        const d = row.querySelector('.agg-c-date').getBoundingClientRect();
        const h = row.querySelector('.agg-sha').getBoundingClientRect();
        return { subjectBottom: s.bottom, authorTop: a.top, dateTop: d.top, shaTop: h.top };
      });
      assert.ok(lines.authorTop >= lines.subjectBottom - 2, 'author is on the second line');
      assert.ok(
        lines.dateTop >= lines.subjectBottom - 2 && lines.shaTop >= lines.subjectBottom - 2,
        'date + sha too',
      );
      await graphSync('narrow', { minRows: 5 });
      await page.screenshot({ path: resolve(artifacts, '6-narrow.png') });
      // 選一列：底部面板在 flex 流程裡，被選的列仍然看得到、不被蓋住
      await select(all[6].sha);
      await waitRowVisible(all[6].sha, 'selected row above the sheet');
      const sheet = await rectOf('.agg-detail');
      const sel = await rectOf('.agg-commit[data-selected]');
      assert.ok(
        sel.bottom <= sheet.top + 1,
        `the sheet (top ${sheet.top}) covers the selected row (bottom ${sel.bottom})`,
      );
      assert.ok(
        sheet.bottom <= 844 + 0.5 && sheet.left >= 0 && sheet.right <= 390.5,
        'the sheet is on screen',
      );
      assert.ok(
        sheet.height <= 844 * 0.5 + 1,
        `the sheet is at most half the screen (${sheet.height})`,
      );
      assert.deepEqual(await noOverflow(), []);
      await graphSync('narrow + sheet', { minRows: 3 });
      await page.screenshot({ path: resolve(artifacts, '6-narrow-detail.png') });
      // 鍵盤走到被面板蓋住的列也要捲出來
      await page.keyboard.press('j');
      await waitSelected(all[7].sha, 'j in the narrow layout');
      await waitRowVisible(all[7].sha, 'row 7 above the sheet');
      const sel2 = await rectOf('.agg-commit[data-selected]');
      const sheet2 = await rectOf('.agg-detail');
      assert.ok(
        sel2.bottom <= sheet2.top + 1,
        'the sheet never covers the keyboard selection either',
      );
      // 最後一列（靠近頁尾）也一樣：面板在 flex 流程裡，列表縮小後最後幾列仍然捲得到
      await page.keyboard.press('End');
      await waitSelected(all[all.length - 1].sha, 'End in the narrow layout');
      await waitRowVisible(all[all.length - 1].sha, 'the oldest commit above the sheet');
      const sel3 = await rectOf('.agg-commit[data-selected]');
      const sheet3 = await rectOf('.agg-detail');
      assert.ok(sel3.bottom <= sheet3.top + 1, 'the sheet does not cover the last row');
      await resetView();

      // 回到預設視窗
      await sizeOf(1440, 900, 'wide');
      assert.deepEqual(await noOverflow(), []);
      await graphSync('back to wide');
    },
  );

  // ═════════════════════════ 重新整理（本機）═════════════════════════

  await step(
    'refresh button re-reads the local repository through the dev endpoint and keeps the scroll position and selection',
    async () => {
      await resetView();
      const all = gitLog(repoDir);
      await scrollTo(900);
      const g = await visibleGeometry();
      const pick = g.rows[3];
      await clickRow(pick.sha);
      await waitSelected(pick.sha, 'row to keep');
      await tagScroller();
      const before = await scrollTopNow();
      assert.ok(before >= 800, `scrolled down (${before})`);
      const [req] = await Promise.all([
        page.waitForRequest((r) => r.url().endsWith('/__agg/git-snapshot')),
        page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click(),
      ]);
      assert.equal(req.method(), 'GET');
      const res = await req.response();
      assert.equal(res.status(), 200);
      await sleep(600);
      assert.equal(await commitCount(), expected);
      assert.equal(
        await scrollerTag(),
        'same-element',
        'the list stays mounted (same scroller element)',
      );
      assert.ok(Math.abs((await scrollTopNow()) - before) <= 3, 'scrollTop is kept');
      assert.equal(await selectedSha(), pick.sha, 'the selection is kept');
      assert.equal(await page.locator('.agg-detail').count(), 1);
      assert.equal(await page.locator('.agg-center').count(), 0, 'no loading / error panel');
      assert.equal((await domRows()).length, all.length);
      await resetView();
    },
  );

  // ═════════════════════════ 即時更新 ═════════════════════════

  await step(
    'LIVE: EVERY consecutive commit shows up on top without reloading; only the new one pops (the rest are drawn at once)',
    async () => {
      await resetView();
      await replayDone();
      await page.evaluate(() => (window.__alive = 'yes'));
      let firstRound = true;
      for (const msg of ['live: first', 'live: second', 'live: third', 'live: fourth']) {
        await watchReplay();
        const before = (await domRows()).map((r) => r.sha);
        commit(repoDir, msg);
        expected++;
        await waitForCommits(expected);
        assert.equal(
          await page.evaluate(() => window.__alive),
          'yes',
          'page must not have reloaded',
        );
        const rows = await domRows();
        assert.equal(rows.length, expected);
        assert.equal(rows[0].subject, msg, 'the new commit is the first row');
        assert.equal(rows[0].sha, git(repoDir, 'rev-parse', 'HEAD'));
        assert.deepEqual(
          rows.slice(1).map((r) => r.sha),
          before,
          'every existing commit is still there, in order, below the new one',
        );
        assert.equal(await scrollTopNow(), 0, 'at the top the view stays at the top');
        assert.ok(
          await rowFullyVisible(rows[0].sha),
          'the new commit is visible without scrolling',
        );
        if (firstRound) {
          // 增量更新：既有的小球「立刻」在原位（不是整張重播）。整張重播時第 2 列起要等 ≥ 0.25 秒才會長出來。
          const png = await page.screenshot();
          const geom = await visibleGeometry();
          const rowsToCheck = geom.rows.filter((r) => r.row >= 3 && r.row <= 10);
          const px = await samplePixels(
            decoder,
            png,
            rowsToCheck.flatMap((r) => [
              [r.x, r.y],
              [r.gLeft + r.gWidth - 2, r.y],
            ]),
          );
          rowsToCheck.forEach((r, i) => {
            assert.ok(
              colorDistance(px[2 * i], px[2 * i + 1]) >= 100,
              `row ${r.row}: an existing commit was hidden by the update (it must not replay)`,
            );
          });
          firstRound = false;
        }
        await waitUntil(
          async () => (await replayLog()).includes('playing'),
          10_000,
          'the new commit pops in',
        );
        await replayDone();
        const log = await replayLog();
        assert.deepEqual(log.slice(-2), ['playing', 'done']);
        const geom = await graphSync(`after live commit "${msg}"`);
        assert.equal(geom.samples[0].row, 0, 'the new commit’s own ball is drawn too');
      }
      await sleep(500);
      await page.screenshot({ path: resolve(artifacts, '7-live-update.png') });
      assert.equal(expected, gitCount(repoDir), 'expected-count bookkeeping');
    },
  );

  await step(
    'LIVE: new branch, commit on it, checkout back and forth — rows, branch chips and the HEAD badge follow',
    async () => {
      const headBadge = async () =>
        (await domRows()).flatMap((r) =>
          r.refs
            .filter((x) => /agg-ref--current/.test(x.cls))
            .map((x) => ({ sha: r.sha, name: x.name })),
        );
      const waitHead = async (name) => {
        await waitUntil(
          async () => {
            const h = await headBadge();
            return h.length === 1 && h[0].name === name;
          },
          20_000,
          `HEAD badge on ${name}`,
        );
        const h = await headBadge();
        assert.equal(
          h[0].sha,
          git(repoDir, 'rev-parse', name),
          `the HEAD badge sits on the tip of ${name}`,
        );
      };
      await resetView();
      git(repoDir, 'checkout', '-q', '-b', 'wip/new-idea');
      commit(repoDir, 'feat: idea');
      expected++;
      await waitForCommits(expected);
      assert.equal(await page.locator('.agg-branch', { hasText: 'wip/new-idea' }).count(), 1);
      await waitHead('wip/new-idea');
      git(repoDir, 'checkout', '-q', 'main');
      await waitHead('main'); // 只 checkout、沒有新 commit，標籤也要換
      commit(repoDir, 'docs: back on main'); // 切回 main 之後的 commit 也要收得到
      expected++;
      await waitForCommits(expected);
      git(repoDir, 'checkout', '-q', 'wip/new-idea');
      commit(repoDir, 'feat: idea two');
      expected++;
      await waitForCommits(expected);
      await waitHead('wip/new-idea');
      git(repoDir, 'checkout', '-q', 'main');
      await waitHead('main');
      assert.equal((await domRows()).length, gitCount(repoDir));
      assert.equal(await page.locator('.agg-branch').count(), gitBranches(repoDir).length);
      // 圖仍然與列表對齊（新 branch 多了一條 lane）
      await replayDone();
      await graphSync('after the branch / checkout updates');
    },
  );

  await step(
    'LIVE: scrolled down — an update keeps the commit at the top of the viewport at the same offset, keeps the selection, and does not replay',
    async () => {
      await resetView();
      await replayDone();
      await scrollTo(1100);
      const g = await visibleGeometry();
      const pick = g.rows[4];
      await clickRow(pick.sha);
      await waitSelected(pick.sha, 'row to keep');
      await sleep(400);
      // 畫面最上面（部分可見）的那一列，與它距離捲動容器上緣的偏移
      const topInfo = () =>
        page.evaluate(() => {
          const sc = document.querySelector('.agg-scroll');
          const scr = sc.getBoundingClientRect();
          const el = [...document.querySelectorAll('.agg-commit')].find(
            (r) => r.getBoundingClientRect().bottom > scr.top + 1,
          );
          return {
            sha: el.dataset.sha,
            offset: el.getBoundingClientRect().top - scr.top,
            scrollTop: sc.scrollTop,
            detail: document.querySelector('.agg-detail-subject')?.textContent ?? null,
          };
        });
      const before = await topInfo();
      assert.ok(before.scrollTop > 1000);
      const selectedBefore = await selectedSha();
      await watchReplay();
      commit(repoDir, 'live: while scrolled down');
      expected++;
      await waitForCommits(expected);
      await waitUntil(
        async () => (await scrollTopNow()) !== before.scrollTop,
        10_000,
        'scroll anchoring to move scrollTop by one row',
      );
      await sleep(500);
      const after = await topInfo();
      assert.equal(after.sha, before.sha, 'the same commit is still at the top of the viewport');
      assert.ok(
        Math.abs(after.offset - before.offset) <= 1.5,
        `the top commit moved on screen (${before.offset.toFixed(1)} → ${after.offset.toFixed(1)})`,
      );
      assert.ok(
        Math.abs(after.scrollTop - (before.scrollTop + 44)) <= 1.5,
        'scrollTop grew by exactly one row',
      );
      assert.equal(await selectedSha(), selectedBefore, 'the selection is kept');
      assert.equal(after.detail, before.detail, 'the detail panel still shows the same commit');
      assert.equal((await domRows()).length, expected);
      assert.equal(await page.locator('.agg-center').count(), 0);
      // 新 commit 在畫面外：不會有任何動畫（沒有 playing）
      assert.deepEqual(
        await replayLog(),
        ['done'],
        'an off-screen update must not replay anything',
      );
      await graphSync('after a live update while scrolled down', { minRows: 4 });
      await page.screenshot({ path: resolve(artifacts, '7b-anchored.png') });
      // 往上捲回去可以看到新的 commit（最上面一列）
      await resetView();
      assert.equal((await domRows())[0].subject, 'live: while scrolled down');
    },
  );

  await step('LIVE: at the top — the new commit is right there, no scrolling needed', async () => {
    await resetView();
    await replayDone();
    await watchReplay();
    commit(repoDir, 'live: at the top');
    expected++;
    await waitForCommits(expected);
    let rows = await domRows();
    assert.equal(rows[0].subject, 'live: at the top');
    assert.equal(await scrollTopNow(), 0);
    assert.ok(await rowFullyVisible(rows[0].sha));
    await waitUntil(
      async () => (await replayLog()).includes('playing'),
      10_000,
      'new commit pops in',
    );
    await replayDone();
    await graphSync('after a live update at the top');

    // 一次進來好幾筆（像 git pull）：全部出現、順序正確、原有的列不動，新的由舊到新依序彈出
    const before = rows.map((r) => r.sha);
    await watchReplay();
    for (const m of ['live: burst a', 'live: burst b', 'live: burst c']) {
      commit(repoDir, m);
      expected++;
    }
    await waitForCommits(expected);
    rows = await domRows();
    assert.deepEqual(
      rows.slice(0, 3).map((r) => r.subject),
      ['live: burst c', 'live: burst b', 'live: burst a'],
    );
    assert.deepEqual(
      rows.slice(3).map((r) => r.sha),
      before,
    );
    assert.equal(await scrollTopNow(), 0);
    await waitUntil(async () => (await replayLog()).includes('playing'), 10_000, 'burst pops in');
    await replayDone();
    await graphSync('after a burst of live commits');
    assert.equal(expected, gitCount(repoDir), 'expected-count bookkeeping');
  });

  await step(
    'LIVE: a new tag appears; deleting a branch releases the selection and the branch focus that pointed at it',
    async () => {
      await resetView();
      await replayDone();
      // 新 tag：統計 chip 與列上的標籤都跟著變
      git(repoDir, 'tag', 'v2');
      await waitUntil(
        async () => (await page.locator('.agg-stats .agg-chip').allInnerTexts()).includes('2 tags'),
        20_000,
        'the tags chip to show 2',
      );
      const top = (await domRows())[0];
      assert.ok(top.refs.some((x) => x.name === 'v2' && /agg-ref--tag/.test(x.cls)));

      // 暫時 branch：聚焦它、選取它的 commit，然後把 branch 刪掉（它的 commit 不再被任何 ref 到達）
      git(repoDir, 'checkout', '-q', '-b', 'wip/tmp');
      commit(repoDir, 'wip: temporary');
      expected++;
      await waitForCommits(expected);
      const tmpSha = git(repoDir, 'rev-parse', 'HEAD');
      git(repoDir, 'checkout', '-q', 'main');
      await waitUntil(
        async () => (await branchChip('wip/tmp').count()) === 1,
        20_000,
        'wip/tmp chip',
      );
      await branchChip('wip/tmp').click();
      await waitRowVisible(tmpSha, 'the temporary commit');
      await clickRow(tmpSha);
      await waitSelected(tmpSha, 'temporary commit');
      assert.equal(await branchChip('wip/tmp').getAttribute('aria-pressed'), 'true');
      await tagScroller();
      git(repoDir, 'branch', '-q', '-D', 'wip/tmp');
      expected--;
      await waitForCommits(expected);
      await waitUntil(async () => (await branchChip('wip/tmp').count()) === 0, 20_000, 'chip gone');
      assert.equal((await domRows()).length, expected);
      assert.equal(
        await selectedSha(),
        null,
        'the selected commit vanished: the selection is released',
      );
      assert.equal(await page.locator('.agg-detail').count(), 0);
      assert.equal(
        await page.locator('.agg-branch[aria-pressed="true"]').count(),
        0,
        'focus released',
      );
      assert.equal((await dimmedShas()).length, 0, 'nothing stays dimmed');
      assert.equal(await page.locator('.agg-center').count(), 0, 'no error / loading panel');
      assert.equal(await scrollerTag(), 'same-element', 'the list stayed mounted');
      assert.equal(expected, gitCount(repoDir), 'expected-count bookkeeping');
      await replayDone();
      await graphSync('after deleting a branch');
    },
  );

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
      await sleep(300);
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
        (await cancel.innerText()).trim(),
      );
      // viewer 的快捷鍵不會漏進對話框：在對話框裡按 j 不會選取任何 commit
      await page.keyboard.press('j');
      assert.equal(await selectedSha(), null);
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
    // 同源（頁面自己）仍然可以；內容只有第一行與作者名稱：沒有 commit 本文、沒有 email
    const same = await page.evaluate(async () => {
      const res = await fetch('/__agg/git-snapshot');
      return { status: res.status, body: await res.text() };
    });
    assert.equal(same.status, 200);
    assert.ok(!same.body.includes('Body line'), 'commit bodies are not served');
    assert.ok(!same.body.includes('example.test'), 'e-mail addresses are not served');
    assert.ok(same.body.includes('feat: add parser'), 'sanity: the snapshot is the real one');
  });

  // ═════════════════════════ GitHub 來源 ═════════════════════════

  const srcLocal = () => page.locator('.web-seg button', { hasText: /Local$|本機$/ });
  const srcGitHub = () => page.locator('.web-seg button', { hasText: /GitHub$/ });

  await step(
    'source switch: GitHub 404 / rate limit are friendly; invalid input is rejected client-side',
    async () => {
      await srcGitHub().click();
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
      // 錯誤畫面取代整個列表
      assert.equal(await page.locator('.agg-commit').count(), 0);
      assert.equal(await page.locator('.agg-scroll').count(), 0);
      assert.equal(await page.locator('.agg-search').count(), 0);
      await sleep(700);
      await page.screenshot({ path: resolve(artifacts, '8-github-404.png') });

      // 403 + x-ratelimit-remaining: 0 → 必須被辨識為 rate limit（需要 CORS 有 expose 這些標頭）
      await input.fill('limited/repo');
      await input.press('Enter');
      await page.locator('.agg-center[role="alert"]').getByText(/60/).waitFor();
      assert.match(await page.locator('.agg-center').innerText(), /分鐘|min/);

      // 相同網址再送一次不應多疊一筆歷史
      const before = await page.evaluate(() => history.length);
      await input.press('Enter');
      await sleep(300);
      assert.equal(await page.evaluate(() => history.length), before);
    },
  );

  await step(
    'LIVE: a commit made while viewing GitHub is there when you come back to Local',
    async () => {
      commit(repoDir, 'live: made while on GitHub');
      expected++;
      // 沒有在看本機圖的期間，推送也必須被收下
      await sleep(1500);
      await srcLocal().click();
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await waitForCommits(expected);
      const rows = await domRows();
      assert.equal(rows.length, expected);
      assert.equal(rows[0].subject, 'live: made while on GitHub');
      assert.equal(await scrollTopNow(), 0, 'coming back to Local starts from the top');
      await srcGitHub().click();
    },
  );

  await step(
    'source switch: any GitHub repo renders through the same viewer (rows, badges, avatars, graph); deep link + cache',
    async () => {
      const input = page.locator('.web-input');
      // 抓取期間：loading 面板（role=status）取代列表；API 拖慢一點才看得到
      const slowApi = async (route) => {
        await sleep(400);
        // unroute 之後才醒來的請求已經由 Playwright 接手（"Route is already handled"），不是錯誤
        await route.continue().catch(() => {});
      };
      await page.route(`${apiBase}/**`, slowApi);
      await input.fill('https://github.com/demo/adorable-git-graph/tree/main');
      await input.press('Enter');
      await page.locator('.agg-center[role="status"]').waitFor();
      assert.match(
        await page.locator('.agg-center[role="status"]').innerText(),
        /Counting commits|正在數 commit/,
      );
      assert.equal(await page.locator('.agg-scroll').count(), 0, 'no list while loading');
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor({ timeout: 30_000 * SCALE });
      await page.unroute(`${apiBase}/**`, slowApi);
      assert.equal(await page.locator('.agg-center').count(), 0, 'the loading panel is gone');
      assert.match(await chips(), new RegExp(`^${SPECS.length} `));
      await replayDone();
      await sleep(1000);
      await page.screenshot({ path: resolve(artifacts, '9-github.png') });

      // 列表內容 = mock 的歷史（新 → 舊）
      const rows = await domRows();
      assert.equal(rows.length, SPECS.length);
      const byTime = [...SPECS].sort((a, b) => b[4] - a[4]);
      assert.equal(rows[0].sha, mockSha('m13'), 'first row is the newest commit');
      assert.equal(rows[0].type, 'docs');
      assert.equal(rows[0].subject, 'docsusage gif', 'type chip + the rest of the subject');
      assert.deepEqual(
        rows.map((r) => r.sha),
        byTime.map((s) => mockSha(s[0])),
      );
      const mergeShas = SPECS.filter((s) => s[1].length > 1).map((s) => mockSha(s[0]));
      assert.equal(mergeShas.length, 2);
      assert.ok(
        sameSet(
          rows.filter((r) => r.merge).map((r) => r.sha),
          mergeShas,
        ),
        'merge pills',
      );
      const badge = (id) => rows.find((r) => r.sha === mockSha(id)).refs;
      assert.ok(badge('r2').some((x) => x.name === 'v0.1.0' && /agg-ref--tag/.test(x.cls)));
      assert.ok(badge('r2').some((x) => x.name === 'release/v0.1'));
      assert.ok(badge('m3').some((x) => x.name === 'v0.0.1'));
      assert.ok(badge('m13').some((x) => x.name === 'main' && /agg-ref--default/.test(x.cls)));
      assert.ok(badge('y2').some((x) => x.name === 'feat/dark-mode'));
      assert.equal(
        await page.locator('.agg-ref--current').count(),
        0,
        'no checked-out branch on GitHub',
      );
      assert.equal(rows[0].author, 'amy', 'GitHub login is shown as the author');
      // 頭像：來自 mock 的 SVG（顯示出來的列都載入成功）
      await waitUntil(
        () =>
          page.evaluate(() => {
            const imgs = [...document.querySelectorAll('.agg-commit .agg-avatar')];
            return (
              imgs.length > 5 &&
              imgs.every((i) => i.tagName === 'IMG' && i.complete && i.naturalWidth > 0)
            );
          }),
        10_000,
        'avatars to load',
      ).catch(() => {});
      assert.ok(
        await page.evaluate(() =>
          [...document.querySelectorAll('.agg-commit .agg-avatar')]
            .slice(0, 8)
            .every((i) => i.tagName === 'IMG' && i.complete && i.naturalWidth > 0),
        ),
        'avatars from the mock load',
      );
      // 線圖：頂端與底端都對齊
      await graphSync('github graph (top)');
      await scrollTo(await scrollMax());
      await graphSync('github graph (end)', { minRows: 5 });
      await scrollTo(0);

      // 詳情 → 在 GitHub 開啟（網址來自 API 的 html_url）
      await clickRow(mockSha('m13'));
      await waitSelected(mockSha('m13'), 'github row');
      const [popup] = await Promise.all([
        ctx.waitForEvent('page'),
        page.getByRole('button', { name: 'Open on GitHub' }).click(),
      ]);
      await popup.waitForURL(/github\.com/);
      assert.equal(
        popup.url(),
        `https://github.com/demo/adorable-git-graph/commit/${mockSha('m13')}`,
      );
      await popup.close();
      await page.bringToFront();
      await resetView();

      // deep link 重新整理：第二次要走 sessionStorage 快取，不再打 API
      const requests = apiCalls().length;
      await page.goto(`${base}/?repo=demo/adorable-git-graph`);
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor();
      await sleep(500);
      assert.equal(apiCalls().length, requests, 'the second load must be served from the cache');
      assert.equal((await domRows()).length, SPECS.length);
    },
  );

  await step(
    'GitHub refresh: the list stays mounted (same scroller, scroll, selection) and only the button spins; a failed refresh keeps the graph and shows an error line; the next refresh clears it',
    async () => {
      await replayDone();
      await resetView();
      await scrollTo(150);
      const g = await visibleGeometry();
      const pick = g.rows[3];
      await clickRow(pick.sha);
      await waitSelected(pick.sha, 'row to keep');
      await tagScroller();
      const before = await scrollTopNow();
      assert.ok(before >= 100, `scrolled (${before})`);
      // 把 API 回應拖慢，讓「轉圈」的狀態可以被觀察
      const slow = async (route) => {
        await sleep(900);
        // unroute 之後才醒來的請求已經由 Playwright 接手（"Route is already handled"），不是錯誤
        await route.continue().catch(() => {});
      };
      await page.route(`${apiBase}/**`, slow);
      await page.evaluate(() => {
        const b = document.querySelector('.agg-actions button[aria-label="Refresh"]');
        window.__busy = { started: false, labelOk: b?.getAttribute('aria-label') === 'Refresh' };
        new MutationObserver(() => {
          if (b.getAttribute('aria-busy') === 'true') window.__busy.started = true;
        }).observe(b, { attributes: true, attributeFilter: ['aria-busy'] });
      });
      const calls = apiCalls().length;
      await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click();
      await waitUntil(
        () => page.evaluate(() => window.__busy.started),
        5000,
        'the Refresh button to get aria-busy',
      );
      assert.equal(
        await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).getAttribute('aria-busy'),
        'true',
      );
      assert.match(
        (await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).getAttribute('class')) ??
          '',
        /agg-btn--busy/,
        'the refresh icon spins while busy',
      );
      // 轉圈期間：列表還在、沒有 loading / error 面板
      assert.equal(
        await page.locator('.agg-center').count(),
        0,
        'no loading panel while refreshing in the background',
      );
      assert.equal(await scrollerTag(), 'same-element');
      await waitUntil(
        async () =>
          (await page
            .getByRole('button', { name: /^(重新整理|Refresh)$/ })
            .getAttribute('aria-busy')) === null,
        15_000,
        'the refresh to finish',
      );
      await page.unroute(`${apiBase}/**`, slow);
      assert.ok(apiCalls().length > calls, 'a forced refresh bypasses the cache and hits the API');
      assert.equal(
        await scrollerTag(),
        'same-element',
        'the same scroller element survives the refresh',
      );
      assert.ok(Math.abs((await scrollTopNow()) - before) <= 3, 'scrollTop is kept');
      assert.equal(await selectedSha(), pick.sha, 'selection is kept');
      assert.equal(await page.locator('.agg-detail').count(), 1);
      assert.equal((await domRows()).length, SPECS.length);

      // 失敗的重新整理：保留原本的圖（同一個捲動容器、捲動位置、選取），只多一行錯誤；再按一次成功就消失
      await page.route(`${apiBase}/**`, (r) => r.abort());
      await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click();
      const banner = page.locator('.agg-banner--error[role="alert"]');
      await banner.waitFor({ timeout: 15_000 * SCALE });
      assert.match(await banner.innerText(), /Network error|網路錯誤/);
      assert.match(await banner.innerText(), /previous data|上一次的資料/);
      assert.equal(
        await page.locator('.agg-center').count(),
        0,
        'no error panel replaces the list',
      );
      assert.equal(await scrollerTag(), 'same-element', 'the list survives a failed refresh');
      assert.ok(
        Math.abs((await scrollTopNow()) - before) <= 3,
        'scrollTop is kept after a failure',
      );
      assert.equal(await selectedSha(), pick.sha, 'selection is kept after a failure');
      assert.equal((await domRows()).length, SPECS.length);
      await page.unroute(`${apiBase}/**`);
      await page.getByRole('button', { name: /^(重新整理|Refresh)$/ }).click();
      await banner.waitFor({ state: 'detached', timeout: 15_000 * SCALE });
      assert.equal(await scrollerTag(), 'same-element');
      assert.equal(await selectedSha(), pick.sha);
      await replayDone();
    },
  );

  await step(
    'token dialog: stored locally, sent only as a Bearer header, never in URL or DOM',
    async () => {
      // 換 token 會重新抓取（中間經過 loading 畫面、列表重新掛載）：回來時要停在原本看的那一列，選取也還在
      await page.locator('.agg-scroll').evaluate((el) => el.scrollTo(0, 200));
      await sleep(400);
      const beforeTop = await scrollTopNow();
      assert.ok(beforeTop >= 150, `scrolled before the token change (${beforeTop})`);
      await page.locator('.agg-commit').nth(8).click();
      const picked = await selectedSha();
      assert.ok(picked, 'a row is selected before the token change');

      seen.auth.length = 0;
      await page.getByRole('button', { name: /^(設定|Settings)$/ }).click();
      await page.locator('.web-dialog').waitFor();
      await page.screenshot({ path: resolve(artifacts, '10-token-dialog.png') });
      await page.locator('.web-dialog input[type="password"]').fill('github_pat_web_secret');
      await page.getByRole('button', { name: /^(儲存|Save)$/ }).click();
      await page.locator('.web-dialog').waitFor({ state: 'detached' });
      await waitUntil(() => seen.auth.length > 0, 20_000, 'a request carrying the token');
      assert.ok(seen.auth.every((a) => a === 'Bearer github_pat_web_secret'));
      assert.ok(!page.url().includes('github_pat'), 'token must never appear in the URL');
      await page.locator('.agg-canvas canvas').waitFor();
      await waitUntil(
        async () => (await domRows()).length === SPECS.length,
        10_000,
        'graph with token',
      );
      await waitUntil(
        async () => Math.abs((await scrollTopNow()) - beforeTop) <= 3,
        10_000,
        'the scroll position restored after the token reload',
      );
      assert.equal(await selectedSha(), picked, 'the selection survives the token reload');
      await page.keyboard.press('Escape');
      // DOM（含所有 shadow tree）、輸入框的值、cookie、sessionStorage 都不能有 token
      const exposed = await page.evaluate(() => {
        const found = [];
        const secret = 'github_pat_web_secret';
        const walk = (rootNode, where) => {
          if ((rootNode.innerHTML ?? '').includes(secret)) found.push(`${where} markup`);
          rootNode.querySelectorAll('*').forEach((el) => {
            for (const a of el.attributes)
              if (a.value.includes(secret)) found.push(`${where} attr ${a.name}`);
            if (el.value && String(el.value).includes(secret))
              found.push(`${where} value of <${el.tagName}>`);
            if (el.shadowRoot) walk(el.shadowRoot, `${where}>shadow`);
          });
        };
        walk(document.documentElement, 'document');
        if (document.cookie.includes(secret)) found.push('cookie');
        for (const k of Object.keys(sessionStorage))
          if ((sessionStorage.getItem(k) ?? '').includes(secret)) found.push(`sessionStorage ${k}`);
        if (location.href.includes(secret)) found.push('url');
        return found;
      });
      assert.deepEqual(exposed, [], 'token must not be rendered anywhere in the page');
      assert.ok(
        !(await page.content()).includes('github_pat_web_secret'),
        'token must not be rendered into the DOM',
      );
      assert.ok(seen.paths.every((p) => !p.includes('github_pat')));

      // 帶 token 抓到的快取，token 移除後不可再被拿來顯示
      const cacheEntries = () =>
        page.evaluate(() =>
          Object.keys(sessionStorage)
            .filter((k) => k.startsWith('agg:gh:'))
            .map((k) => JSON.parse(sessionStorage.getItem(k)).authed),
        );
      await waitUntil(
        async () => (await cacheEntries()).includes(true),
        20_000,
        'an authenticated cache entry',
      );
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
      await sleep(500);
      assert.ok(
        !(await cacheEntries()).includes(true),
        'authenticated cache entries must not survive clearing the token',
      );
      await waitUntil(
        async () => (await domRows()).length === SPECS.length,
        10_000,
        'graph without token',
      );
    },
  );

  await step(
    'browser back/forward drive the viewer (not just the URL); Local button returns to the git snapshot',
    async () => {
      const pressed = () =>
        page.locator('.web-seg button[aria-pressed="true"]').first().innerText();
      await srcLocal().click(); // push "/"
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await waitForCommits(expected);
      await srcGitHub().click();
      const input = page.locator('.web-input');
      await input.fill('demo/adorable-git-graph');
      await input.press('Enter'); // push "?repo=demo/adorable-git-graph"
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();

      await page.goBack(); // → Local：畫面本身也必須跟著回去
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      assert.equal(new URL(page.url()).search, '');
      assert.match(await pressed(), /Local|本機/);
      await waitForCommits(expected);
      assert.equal((await domRows()).length, expected);

      await page.goForward(); // → GitHub
      await page.locator('.agg-title-text', { hasText: 'demo/adorable-git-graph' }).waitFor();
      assert.equal(new URL(page.url()).search, '?repo=demo/adorable-git-graph');
      assert.match(await pressed(), /GitHub/);
      await waitUntil(
        async () => (await domRows()).length === SPECS.length,
        10_000,
        'github rows after forward',
      );

      await srcLocal().click();
      await page.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      await page.locator('.agg-canvas canvas').waitFor();
      assert.equal(new URL(page.url()).search, '');
      await waitForCommits(expected);
    },
  );

  await step(
    'theme toggle cycles auto → day → night, persists across reloads, and the graph follows',
    async () => {
      const toggle = page.locator('.web-icon');
      await replayDone();
      const dayBg = (await graphSync('day theme')).samples[0].bg;
      await toggle.click(); // day
      await page.locator('.agg-root[data-theme="day"]').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('agg.theme')), 'day');
      await toggle.click(); // night
      await page.locator('.agg-root[data-theme="night"]').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('agg.theme')), 'night');
      await page.reload();
      await page.locator('.agg-root[data-theme="night"]').waitFor();
      await replayDone();
      await sleep(1000);
      await page.mouse.move(720, 8);
      await page.screenshot({ path: resolve(artifacts, '11-night.png') });
      // 夜間卡片底色與白天明顯不同，而且球仍然對齊 / 畫得出來
      const night = await graphSync('night theme');
      const nightBg = night.samples[0].bg;
      assert.ok(colorDistance(dayBg, nightBg) > 300, `night card ${nightBg} vs day card ${dayBg}`);
      assert.ok(nightBg[0] < 90 && nightBg[2] < 140, `night card should be dark (${nightBg})`);
      // 切到夜間後依然可以操作：選取一列、詳情的底色也是夜間配色
      await clickRow((await domRows())[2].sha);
      await page.locator('.agg-detail').waitFor();
      const detailBg = await page.evaluate(
        () => getComputedStyle(document.querySelector('.agg-detail')).backgroundColor,
      );
      assert.match(detailBg, /^rgb\(4\d, 3\d, 8\d\)$/, 'night detail card color');
      await resetView();
    },
  );

  await step('zh-TW interface: aria labels, chips, search counter, detail buttons', async () => {
    const zhCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-TW',
    });
    zhCtx.setDefaultTimeout(30_000 * SCALE);
    zhCtx.setDefaultNavigationTimeout(30_000 * SCALE);
    try {
      await zhCtx.route('https://github.com/**', (r) =>
        r.fulfill({ status: 200, contentType: 'text/html', body: '<title>fake github</title>' }),
      );
      const zh = await zhCtx.newPage();
      watchErrors(zh, 'zh-TW page');
      await zh.goto(base);
      await zh.locator('.agg-title-text', { hasText: 'octo/cat' }).waitFor();
      assert.equal(await zh.evaluate(() => document.documentElement.lang), 'zh-TW');
      const stats = await zh.locator('.agg-stats .agg-chip').allInnerTexts();
      assert.equal(stats[0], `${expected} 個 commit`);
      assert.equal(stats[1], `${gitBranches(repoDir).length} 條分支`);
      for (const name of ['重播', '回到最新', '重新整理', '設定'])
        assert.equal(
          await zh.getByRole('button', { name, exact: true }).count(),
          1,
          `button ${name}`,
        );
      const input = zh.locator('.agg-search input');
      assert.equal(await input.getAttribute('aria-label'), '搜尋 commit');
      await input.fill('side');
      await zh.locator('.agg-chip--filter').waitFor();
      assert.equal(
        await zh.locator('.agg-chip--filter').innerText(),
        `顯示 4 / ${expected} 個 commit`,
      );
      assert.equal(await zh.locator('.agg-search-count').innerText(), '0 / 4');
      await input.fill('zzzz');
      assert.equal(await zh.locator('.agg-search-count').innerText(), '沒有符合的 commit');
      await input.fill('');
      await zh
        .locator('.agg-commit')
        .nth(2)
        .click({ position: { x: 150, y: 10 } });
      await zh.locator('.agg-detail').waitFor();
      for (const name of [
        '上一個（較新）',
        '下一個（較舊）',
        '關閉詳情',
        '複製 SHA',
        '在 GitHub 開啟',
      ])
        assert.equal(
          await zh.getByRole('button', { name, exact: true }).count(),
          1,
          `button ${name}`,
        );
      assert.match(await zh.locator('.agg-detail').innerText(), /包含於/);
      await zh.getByRole('button', { name: '複製 SHA', exact: true }).click();
      await zh
        .locator('.agg-mini-btn[data-state]')
        .filter({ hasText: /已複製|複製失敗/ })
        .waitFor({ timeout: 5000 * SCALE });
      await zh.close();
    } finally {
      await zhCtx.close();
    }
  });

  await step(
    'other local repositories: no remote → no "Open on GitHub"; empty repo → empty state; not a git repo → error panel',
    async () => {
      const tmp = (name) => mkdtempSync(resolve(tmpdir(), `agg-web-e2e-${name}-`));
      const noRemote = tmp('noremote');
      git(noRemote, 'init', '-q', '-b', 'trunk');
      commit(noRemote, 'feat: only one');
      commit(noRemote, 'fix: only two');
      const empty = tmp('empty');
      git(empty, 'init', '-q', '-b', 'main');
      const notRepo = tmp('nogit');
      // 每個 repo 各起一個 dev server（AGG_REPO_DIR 不同）
      const open = async (dir, fn) => {
        const p = await freePort();
        const v = startVite(['--port', String(p), '--strictPort'], { ...env, AGG_REPO_DIR: dir });
        try {
          await v.ready;
          const pg = await ctx.newPage();
          watchErrors(pg, `repo ${dirBase(dir)}`);
          try {
            await pg.goto(`http://localhost:${p}`);
            await fn(pg);
          } finally {
            await pg.close();
          }
        } finally {
          v.proc.kill();
        }
      };
      try {
        await open(noRemote, async (pg) => {
          await pg.locator('.agg-title-text', { hasText: dirBase(noRemote) }).waitFor();
          await pg.locator('.agg-commit').first().waitFor();
          assert.equal(await pg.locator('.agg-commit').count(), 2);
          await pg
            .locator('.agg-commit')
            .nth(1)
            .click({ position: { x: 150, y: 10 } });
          await pg.locator('.agg-detail').waitFor();
          assert.equal(
            await pg.locator('.agg-cta').count(),
            0,
            'no remote → no commit url → no "Open on GitHub"',
          );
          assert.equal(
            await pg.getByRole('button', { name: /Open on GitHub|在 GitHub 開啟/ }).count(),
            0,
          );
          assert.equal(await pg.locator('.agg-detail-subject').innerText(), 'feat: only one');
        });
        await open(empty, async (pg) => {
          await pg.locator('.agg-center').waitFor();
          assert.match(
            await pg.locator('.agg-center').innerText(),
            /No commits here yet|這裡還沒有 commit/,
          );
          assert.equal(
            await pg.locator('.agg-center').getAttribute('role'),
            null,
            'the empty state is not an alert',
          );
          assert.equal(await pg.locator('.agg-scroll').count(), 0);
          assert.equal(await pg.locator('.agg-search').count(), 0);
          assert.equal(
            await pg.getByRole('button', { name: /^(重播|Replay)$/ }).count(),
            0,
            'nothing to replay',
          );
        });
        await open(notRepo, async (pg) => {
          await pg.locator('.agg-center[role="alert"]').waitFor();
          assert.match(
            await pg.locator('.agg-center[role="alert"]').innerText(),
            /not inside a git repository/,
          );
          assert.equal(await pg.locator('.agg-scroll').count(), 0);
          // 錯誤訊息不含本機路徑
          assert.ok(!(await pg.locator('.agg-center').innerText()).includes(notRepo));
        });
      } finally {
        for (const d of [noRemote, empty, notRepo]) rmSync(d, { recursive: true, force: true });
      }
    },
  );

  await step(
    'production build bakes the snapshot in, hides Refresh, draws the same list and has no dev endpoint',
    async () => {
      const outDir = resolve(artifacts, 'dist');
      execFileSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: 'pipe',
      });
      // 烤進 bundle 的快照只有第一行與作者名稱：沒有 commit 本文、沒有 email
      const baked = readdirSync(outDir, { recursive: true })
        .filter((f) => /\.(js|html|json)$/.test(String(f)))
        .map((f) => readFileSync(resolve(outDir, String(f)), 'utf8'))
        .join('\n');
      assert.ok(
        baked.includes('feat: add parser'),
        'sanity: the snapshot is baked into the bundle',
      );
      assert.ok(!baked.includes('Body line'), 'commit bodies must not be baked into the bundle');
      assert.ok(
        !baked.includes('example.test'),
        'e-mail addresses must not be baked into the bundle',
      );
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
      watchErrors(p2, 'preview page');
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
      // 烤進去的快照與 git 一致：同一份列表（新 → 舊）、畫得出來
      const rows = await domRows(p2);
      assert.deepEqual(
        rows.map((r) => r.sha),
        gitLog(repoDir).map((c) => c.sha),
      );
      await replayDone(p2);
      await sleep(800);
      await graphSync('production build', { pg: p2 });
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
  try {
    await page?.screenshot({ path: resolve(artifacts, 'failure.png') });
    console.error(`failure screenshot → ${resolve(artifacts, 'failure.png')}`);
  } catch {
    /* ignore */
  }
  if (dev) console.error('\n--- vite log ---\n' + dev.log().slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close();
  dev?.proc.kill();
  preview?.proc.kill();
  mock.close();
  rmSync(repoDir, { recursive: true, force: true });
}
