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
//   · 安全性（cross-origin 讀不到 dev endpoint、快照與 bundle 沒有 commit 本文 / email）→ 主題記憶 → zh-TW
//   · 本機 repo 選擇器（AGG_REPO_ROOTS 指向專用的暫時資料夾：清單內容 / 略過的資料夾 / 不跟隨 symlink、切換與上一頁 / 下一頁、
//     鍵盤在關著的選單上瀏覽（↑ ↓ 只改顯示，停 ~700ms 才切換一次：一筆歷史、只讀最後那個 repo；Enter 馬上切換）、
//     深連結、非預設 repo 的即時更新（HMR 只通知 { repo: id }，畫面再向 endpoint 拿）、不認得的 id、
//     選單旁的 ＋（開啟其他路徑…）輸入路徑（錯誤訊息 / Esc / ✕ / 焦點：成功回到選單、失敗留在輸入框；
//     ✕ 在深色系統配色下仍是 --agg-ink；<repo>/.git 打開的是 repo 本身、不會多一筆；
//     由 dev server 記在 AGG_LOCAL_REPOS_FILE（e2e 一律指到暫時檔案）、瀏覽器什麼都不記；
//     同一個檔案重新啟動後仍打得開、換一個空的檔案就不認得，在「不認得」的畫面上用 ＋ 加入同一個路徑就直接顯示、不用重新整理）、
//     跨來源讀不到也加不進 repo、太大的 POST 拿到 413、偽造 Host 被 Vite 擋下、
//     `vite --host` 時非 loopback 的連線只拿得到預設 repo（403 local_only，頁面說明原因、沒有 ＋；沒有非 loopback 介面就略過這一步）、
//     手機寬度沒有橫向溢位、與 GitHub 來源來回切換（GitHub → 本機 回到最後看的本機 repo，不是預設 repo））
//   → 其他本機 repo（沒有 remote / 空的 / 不是 git）→ 本機 build + preview（沒有 git 動作列、不打任何 /__agg/ endpoint）
//   → 以下各自用自己的 dev server / 暫時 repo / browser context，不影響前面的步驟：
//     · infinite scroll（本機：705 個 commit、AGG_MAX_COMMITS=100，捲到底向 dev server 要 ?depth=400 → 700 → 1000：
//       往下接、畫面不動、不重播、選取 / 捲動容器不變、線圖同步、到「最初的 commit」為止；失敗時顯示錯誤 + 再試一次、不自動重試；
//       之後的即時更新保留已載入的深度。GitHub 來源：mock 的 demo/long-history，從缺的 parent 往回抓 /commits?sha=）
//     · 詳情面板大小（加寬 / 還原：aria-pressed、clamp(380px, 50%, 720px)、列表重排沒有溢位、記在 localStorage、
//       中等寬度的抽屜跟著變寬、窄螢幕的底部面板沒有這個按鈕）
//     · git 動作（本機的 bare remote + 另一個 clone 模擬隊友）：動作列（branch、↑↓、變更數、不能用的原因、手機寬度只留圖示）、
//       fetch / pull（只 fast-forward）、push（先確認、被拒絕時不 force、分岔時 pull 拒絕、設定 upstream）、
//       stash（存 / apply / pop / drop 二次確認）、tag（詳情面板的選取 commit / HEAD、名稱檢查、push、刪除）、
//       worktree（新增 → 開啟 → 有未追蹤檔案時拒絕移除 → 移除）；結果一律以 git 本身為準
//     · 安全性：其他來源 / 偽造 Host / 區網的裝置都讀不到 /__agg/status、執行不了 /__agg/git，區網的畫面沒有動作列。
// 軟體 WebGL（SwiftShader）在 CPU 吃緊時很慢：一律等「狀態」（data-replay、定位器、輪詢），不用固定 sleep 當判斷依據；
// 像素判斷失敗時會重截幾次才判定；逾時乘上 E2E_TIMEOUT_SCALE（預設 2）。截圖輸出到 e2e/.artifacts。
//   用法：pnpm e2e        （環境變數 CHROME_PATH 可指定 Chrome）
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';
import {
  LONG,
  SPECS,
  faults,
  gate,
  releaseHeld,
  seen,
  sha as mockSha,
  startMock,
} from '../../../tools/e2e/mock-github-api.mjs';
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

/**
 * 本機 repo 選擇器的掃描範圍（AGG_REPO_ROOTS）：專用的暫時資料夾，清單才是確定的
 * （沒有設定時，掃描的是預設 repo 的上一層，也就是 /tmp，裡面什麼都有）。
 *   roots/beta/                 一般 repo：30 個 commit（捲得動），說明都以 beta: 開頭，另有一條 branch
 *   roots/group/gamma/          第 2 層的 repo
 *   roots/node_modules/hidden/  略過的資料夾裡的 repo：不能出現在清單裡
 *   roots/.hidden/repo/         `.` 開頭的資料夾裡的 repo：不能出現在清單裡
 *   roots/linked → outside/far-away   指到範圍外的 symlink：不跟隨，不能出現在清單裡
 *   roots/plain/                不是 git repo 的資料夾
 *   outside/far-away/           範圍外的 repo：只能用選單旁的 ＋（開啟其他路徑…）輸入絕對路徑打開
 *   outside/sneaky/             跨來源的 POST 想偷偷加進清單的 repo
 */
function makeRepoRoots() {
  const rootsDir = mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-roots-'));
  const outsideDir = mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-outside-'));
  const init = (dir) => {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    return dir;
  };
  const beta = init(resolve(rootsDir, 'beta'));
  for (let i = 1; i <= 26; i++) commit(beta, `beta: lantern ${i}`, 'Dan');
  git(beta, 'checkout', '-q', '-b', 'beta-side');
  commit(beta, 'beta: side path one', 'Eve');
  commit(beta, 'beta: side path two', 'Eve');
  git(beta, 'checkout', '-q', 'main');
  commit(beta, 'beta: lantern 27', 'Dan');
  commit(beta, 'beta: lantern 28', 'Dan');
  const gamma = init(resolve(rootsDir, 'group', 'gamma'));
  commit(gamma, 'gamma: nested one', 'Dan');
  commit(gamma, 'gamma: nested two', 'Dan');
  for (const hidden of [
    resolve(rootsDir, 'node_modules', 'hidden'),
    resolve(rootsDir, '.hidden', 'repo'),
  ]) {
    init(hidden);
    commit(hidden, 'hidden: must not be listed');
  }
  const plain = resolve(rootsDir, 'plain');
  mkdirSync(plain);
  writeFileSync(resolve(plain, 'notes.txt'), 'not a repository\n');
  const far = init(resolve(outsideDir, 'far-away'));
  commit(far, 'far: postcard one', 'Dan');
  commit(far, 'far: postcard two', 'Dan');
  commit(far, 'far: postcard three', 'Dan');
  symlinkSync(far, resolve(rootsDir, 'linked'), 'dir');
  const sneaky = init(resolve(outsideDir, 'sneaky'));
  commit(sneaky, 'sneaky: should never be added cross-origin', 'Dan');
  return { rootsDir, outsideDir, beta, gamma, plain, far, sneaky };
}

/**
 * infinite scroll 用的長歷史（AGG_MAX_COMMITS=100 時要往回載入好幾批）。700 多個 commit 逐一 `git commit` 太慢，
 * 改用 `git fast-import` 一次建好（每個 commit 都比上一個晚一小時：--date-order 的順序就是建立順序倒過來）。
 *   main：d1 ← d2 ← … ← d700（d1 是 root：載到底時頁尾說「最初的 commit 在這裡」）
 *   topic/old：從 d200 分出 t1 ← t2 ← t3，在 d210 合併；wip/deep：從 d650 分出 w1 ← w2（沒有合併）
 *   tag v0.1 在 d30（最後一批才載得到）、v1.0 在 d690（第一批就有）
 * 共 705 個 commit。
 */
function makeDeepRepo() {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-deep-')));
  git(dir, 'init', '-q', '-b', 'main');
  const marks = new Map();
  let at = Math.floor(Date.UTC(2025, 0, 1) / 1000);
  let out = '';
  const add = (ref, id, msg, parents) => {
    marks.set(id, marks.size + 1);
    at += 3600;
    const name = ['Amy', 'Ben', 'Cat'][marks.size % 3];
    const who = `${name} <${name.toLowerCase()}@example.test> ${at} +0000`;
    out += `commit refs/heads/${ref}\nmark :${marks.get(id)}\nauthor ${who}\ncommitter ${who}\n`;
    out += `data ${Buffer.byteLength(msg)}\n${msg}\n`;
    if (parents[0]) out += `from :${marks.get(parents[0])}\n`;
    for (const p of parents.slice(1)) out += `merge :${marks.get(p)}\n`;
    out += '\n';
  };
  const main = (i) => {
    const prev = i > 1 ? [`d${i - 1}`] : [];
    if (i === 1) return add('main', 'd1', 'chore: the very first commit', prev);
    if (i === 210) return add('main', 'd210', "Merge branch 'topic/old'", [...prev, 't3']);
    add('main', `d${i}`, `${TYPES[i % TYPES.length]}: deep step ${i}`, prev);
  };
  for (let i = 1; i <= 700; i++) {
    main(i);
    if (i === 200) add('topic/old', 't1', 'feat: old topic one', ['d200']);
    if (i === 205) {
      add('topic/old', 't2', 'fix: old topic two', ['t1']);
      add('topic/old', 't3', 'test: old topic three', ['t2']);
    }
    if (i === 650) {
      add('wip/deep', 'w1', 'wip: deep side one', ['d650']);
      add('wip/deep', 'w2', 'wip: deep side two', ['w1']);
    }
  }
  out += `reset refs/tags/v0.1\nfrom :${marks.get('d30')}\n\n`;
  out += `reset refs/tags/v1.0\nfrom :${marks.get('d690')}\n\n`;
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, env: gitEnv, input: out });
  // fast-import 不碰工作目錄：全部的 commit 都是空的 tree，HEAD（main）乾乾淨淨
  return dir; // 705 commits, 3 branches, 2 tags, 1 merge
}

/**
 * git 動作用的一組 repo（放在同一個暫時資料夾，新的 worktree 也會建在這裡：相對路徑以 repo 的上一層為基準）：
 *   origin.git / backup.git   本機的 bare「remote」（檔案路徑，不需要網路）
 *   work/                     dev server 的預設 repo（AGG_REPO_DIR）：clone 自 origin，main 追蹤 origin/main，另有 backup remote
 *   mate/                     另一個 clone：模擬隊友在別處 push
 *   roots/                    空的 AGG_REPO_ROOTS（repo 清單是確定的）
 */
function makeGitFixture() {
  const top = realpathSync(mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-git-')));
  const fx = {
    top,
    origin: resolve(top, 'origin.git'),
    backup: resolve(top, 'backup.git'),
    work: resolve(top, 'work'),
    mate: resolve(top, 'mate'),
    roots: resolve(top, 'roots'),
  };
  mkdirSync(fx.roots);
  git(top, 'init', '-q', '--bare', '-b', 'main', fx.origin);
  git(top, 'init', '-q', '--bare', '-b', 'main', fx.backup);
  git(top, 'init', '-q', '-b', 'main', fx.work);
  git(fx.work, 'remote', 'add', 'origin', fx.origin);
  git(fx.work, 'remote', 'add', 'backup', fx.backup);
  writeFileSync(resolve(fx.work, 'notes.txt'), 'notes\n');
  git(fx.work, 'add', 'notes.txt');
  commit(fx.work, 'chore: start the shared repo');
  for (let i = 1; i <= 7; i++) {
    writeFileSync(resolve(fx.work, 'notes.txt'), `notes ${i}\n`);
    git(fx.work, 'add', 'notes.txt');
    commit(fx.work, `${TYPES[i % TYPES.length]}: shared step ${i}`, i % 3 ? 'Amy' : 'Ben');
  }
  git(fx.work, 'push', '-q', '-u', 'origin', 'main');
  git(top, 'clone', '-q', fx.origin, fx.mate);
  return fx;
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
/** 與 dev server 相同的 repo id：realpath 的 sha256 前 12 碼（瀏覽器只會拿到這個，不會拿到路徑）。 */
const repoIdOf = (d) => createHash('sha256').update(realpathSync(d)).digest('hex').slice(0, 12);
/** 與 dev server 相同的顯示位置：家目錄縮寫成 ~。 */
const repoLabelOf = (d) => {
  const real = realpathSync(d);
  const home = homedir();
  return real === home ? '~' : real.startsWith(`${home}/`) ? `~${real.slice(home.length)}` : real;
};
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

/** 停掉 dev server 並等它真的結束（同一個埠馬上要再啟動一個）。 */
async function stopVite(v) {
  if (!v || v.proc.exitCode !== null || v.proc.signalCode !== null) return;
  const exited = new Promise((ok) => v.proc.once('exit', ok));
  v.proc.kill();
  await exited;
}

/** 不經瀏覽器的 HTTP 請求（可以自訂 Host / Origin / fetch metadata，也可以從別的網路介面連過去）。 */
const rawHttp = (host, port, path, { method = 'GET', headers = {}, body } = {}) =>
  new Promise((ok, fail) => {
    const req = httpRequest({ host, port, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* 不是 JSON（例如 Vite 的 Blocked request 頁面） */
        }
        ok({ status: res.statusCode, body: data, json });
      });
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });

/** dev server 記住輸入路徑的檔案（{ paths }）；還沒有檔案 = null。 */
const readState = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

/** 這台機器的非 loopback IPv4（模擬「區網裡的另一台裝置」連到 `vite --host` 的 dev server）；沒有就是 undefined。 */
const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)?.address;

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
const fx = makeRepoRoots();
// dev server 記住「輸入的路徑」的檔案（AGG_LOCAL_REPOS_FILE）：一律放在暫時資料夾，
// 絕不能寫到開發者自己的 apps/web/node_modules/.cache/adorable-git-graph/local-repos.json
const stateDir = mkdtempSync(resolve(tmpdir(), 'agg-web-e2e-state-'));
const stateFileOf = (name) => resolve(stateDir, `${name}.json`);
const mock = await startMock();
const apiBase = `http://127.0.0.1:${mock.address().port}`;
const port = await freePort();
// AGG_REPO_ROOTS：本機 repo 清單只掃描專用的暫時資料夾（預設 repo 仍是 AGG_REPO_DIR 的 88 個 commit）
const env = {
  AGG_REPO_DIR: repoDir,
  VITE_GITHUB_API_BASE: apiBase,
  AGG_REPO_ROOTS: fx.rootsDir,
  AGG_LOCAL_REPOS_FILE: stateFileOf('main'),
};

let dev;
let preview;
let browser;
let page;
// infinite scroll / git 動作的步驟各自有 repo 與 dev server（會改動 repo、提高快照深度，不能影響上面的步驟）
let deepDir;
let gfx;
const sideServers = new Set();
/** 失敗時要截圖的頁面（這些步驟用的是自己的頁面；沒有就截主畫面） */
let shotPage;

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
  const selectedSha = (pg = page) =>
    pg.evaluate(() => document.querySelector('.agg-commit[data-selected]')?.dataset.sha ?? null);
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
  const waitSelected = async (sha, what = '', pg = page) => {
    await waitUntil(async () => (await selectedSha(pg)) === sha, 10_000, `selected ${what}`).catch(
      () => {},
    );
    assert.equal(await selectedSha(pg), sha, `selected row (${what})`);
  };

  // ── 捲動 ──
  const scrollTopNow = (pg = page) =>
    pg.evaluate(() => document.querySelector('.agg-scroll').scrollTop);
  /** 等平滑捲動結束（scrollTop 連續 3 次輪詢都沒變）。 */
  const settleScroll = async (pg = page) => {
    let last = NaN;
    let same = 0;
    const t = Date.now();
    while (same < 3) {
      const cur = await scrollTopNow(pg);
      same = cur === last ? same + 1 : 0;
      last = cur;
      if (Date.now() - t > 20_000) throw new Error('scroll never settled');
      await sleep(80);
    }
    return last;
  };
  const scrollTo = async (top, pg = page) => {
    await pg.evaluate((t) => {
      document.querySelector('.agg-scroll').scrollTop = t;
    }, top);
    return settleScroll(pg);
  };
  const scrollMax = (pg = page) =>
    pg.evaluate(() => {
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
        trackHeight: log.height,
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
      // （列表比畫面短時，視窗只到內容底部為止：planWindow 會把高度夾在捲動內容的高度）
      if (geom.winTop > geom.scrollTop + 0.5)
        problems.push(`canvas window starts at ${geom.winTop}, below scrollTop ${geom.scrollTop}`);
      const wantBottom = Math.min(geom.scrollTop + geom.clientHeight, Math.floor(geom.trackHeight));
      if (geom.winTop + geom.hostHeight < wantBottom - 0.5)
        problems.push(
          `canvas window ends at ${geom.winTop + geom.hostHeight}, above ${wantBottom} (viewport bottom ${geom.scrollTop + geom.clientHeight}, track ${geom.trackHeight})`,
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
  const noOverflow = (pg = page) =>
    pg.evaluate(() => {
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
  const rowFullyVisible = (sha, pg = page) =>
    pg.evaluate((s) => {
      const r = document.querySelector(`.agg-commit[data-sha="${s}"]`)?.getBoundingClientRect();
      const sc = document.querySelector('.agg-scroll').getBoundingClientRect();
      return Boolean(r && r.top >= sc.top - 0.5 && r.bottom <= sc.bottom + 0.5);
    }, sha);
  const waitRowVisible = async (sha, what = '', pg = page) => {
    await waitUntil(
      () => rowFullyVisible(sha, pg),
      12_000,
      `row ${what || sha.slice(0, 7)} scrolled into view`,
    );
    await settleScroll(pg);
    assert.ok(
      await rowFullyVisible(sha, pg),
      `row ${what || sha.slice(0, 7)} must be fully visible`,
    );
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
  const clickRow = (sha, how = {}, pg = page) =>
    rowLoc(sha, pg).click({ position: { x: 150, y: 10 }, ...how });

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
      // 預設 repo 的快照：GET /__agg/git-snapshot?repo=default
      const [req] = await Promise.all([
        page.waitForRequest((r) => {
          const u = new URL(r.url());
          return u.pathname === '/__agg/git-snapshot' && u.searchParams.get('repo') === 'default';
        }),
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
      const toggle = page.locator('.web-theme');
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

  // ═════════════════════════ 本機 repo 選擇器（dev server） ═════════════════════════
  // AGG_REPO_ROOTS = fx.rootsDir：清單只有 預設 repo（★）、beta、group/gamma；其他（略過的資料夾 / symlink / 範圍外）都不能出現。

  const ids = {
    beta: repoIdOf(fx.beta),
    gamma: repoIdOf(fx.gamma),
    far: repoIdOf(fx.far),
    sneaky: repoIdOf(fx.sneaky),
  };
  const PICK_LABEL = 'Choose a local repository';
  const PATH_LABEL = 'Path to a git repository';
  const ADD_LABEL = 'Open another path…';
  /** --agg-ink（#2b2140）：白天 / 夜間主題都一樣 */
  const INK = 'rgb(43, 33, 64)';
  const PICK_SEL = `select.web-select[aria-label="${PICK_LABEL}"]`;
  const picker = (pg = page) => pg.locator(PICK_SEL);
  /** 選單旁的 ＋：「開啟其他路徑…」是獨立的按鈕（不是選單裡的選項） */
  const addBtn = (pg = page) => pg.getByRole('button', { name: ADD_LABEL, exact: true });
  const pathInput = (pg = page) => pg.locator(`input.web-input[aria-label="${PATH_LABEL}"]`);
  const pathError = (pg = page) => pg.locator('.web-error[role="alert"]');
  const ghInput = (pg = page) => pg.locator(`input.web-input:not([aria-label="${PATH_LABEL}"])`);
  /** 選單目前的選項（值 / 文字 / 是否選取）。 */
  const pickerOptions = (pg = page) =>
    picker(pg).evaluate((sel) =>
      [...sel.options].map((o) => ({
        value: o.value,
        text: o.textContent,
        selected: o.selected,
        disabled: o.disabled,
      })),
    );
  const pickerValue = (pg = page) => picker(pg).inputValue();
  /** 清單是非同步抓的：等到選單裡出現 `id`。 */
  const waitPickerHas = (id, pg = page) =>
    waitUntil(
      async () => (await pickerOptions(pg).catch(() => [])).some((o) => o.value === id),
      15_000,
      `the local repo menu to list ${id}`,
    );
  /** 等選單的選項（值、順序）剛好是 `want`；逾時就以實際的清單判定失敗。 */
  const waitPickerValues = async (want, what, pg = page) => {
    const values = async () => (await pickerOptions(pg).catch(() => [])).map((o) => o.value);
    await waitUntil(
      async () => JSON.stringify(await values()) === JSON.stringify(want),
      15_000,
      what,
    ).catch(() => {});
    assert.deepEqual(await values(), want, what);
  };
  /** 清單載入後選單才會選到目前的 repo（之前顯示的是「目前的 repo」占位選項）。 */
  const waitPickerValue = (id, pg = page) =>
    waitUntil(
      async () => (await pickerValue(pg).catch(() => null)) === id,
      15_000,
      `the local repo menu to select ${id}`,
    );
  const activeLabel = (pg = page) =>
    pg.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
  const shasOf = (dir) => gitLog(dir).map((c) => c.sha);
  /** 畫面上的列表 = 這個 repo 的 git log（整串 sha、順序都一樣）。 */
  const waitShowsRepo = async (dir, what, pg = page) => {
    const want = shasOf(dir);
    await waitUntil(
      async () => {
        const got = (await domRows(pg)).map((r) => r.sha);
        return got.length === want.length && got.every((s, i) => s === want[i]);
      },
      20_000,
      `${what}: rows = git log of ${dirBase(dir)}`,
    );
  };
  const searchOf = (pg = page) => new URL(pg.url()).search;
  const waitSearch = (want, pg = page) => pg.waitForURL((u) => new URL(u).search === want);
  const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 標題「剛好是」這個名稱（不是子字串：beta 不能被 alphabeta 之類的騙過）。 */
  const titleIs = (name, pg = page) =>
    pg.locator('.agg-title-text', { hasText: new RegExp(`^${reEscape(name)}$`) }).waitFor();
  const sameOriginRepos = (pg = page) =>
    pg.evaluate(async () => {
      const res = await fetch('/__agg/repos', { cache: 'no-store' });
      return { status: res.status, body: await res.json() };
    });
  const mainState = stateFileOf('main');
  /**
   * 輸入的路徑只由 dev server 記（AGG_LOCAL_REPOS_FILE）：瀏覽器的 localStorage / sessionStorage 裡不能有這些路徑，
   * 也不能再有舊版的 agg.local-paths（localhost:<port> 這個 origin 是所有專案的 dev server 共用的）。
   */
  const assertNoPathsInBrowser = async (dirs, pg, what) => {
    const stored = await pg.evaluate(() => {
      const dump = (s) => Object.fromEntries(Object.keys(s).map((k) => [k, s.getItem(k)]));
      return { local: dump(localStorage), session: dump(sessionStorage) };
    });
    assert.ok(!('agg.local-paths' in stored.local), `${what}: no agg.local-paths in localStorage`);
    const text = JSON.stringify(stored);
    for (const d of dirs)
      for (const form of new Set([d, realpathSync(d)]))
        assert.ok(!text.includes(form), `${what}: the browser must not keep ${form}`);
  };

  /**
   * vite 的 HMR websocket 收到的 agg:git-snapshot 推送：用來確認「推送已經到了」，不用固定 sleep。
   * 預設 repo 是 { repo: 'default', snapshot }；其他 repo 只有 { repo: id }（HMR 會廣播給所有連線，內容要向只回應本機的 endpoint 拿）。
   * `at`：收到的時間（e2e 自己加的）。
   */
  const hmrFrames = [];
  page.on('websocket', (ws) =>
    ws.on('framereceived', ({ payload }) => {
      const text = String(payload);
      if (!text.includes('agg:git-snapshot')) return;
      try {
        const m = JSON.parse(text);
        if (m.event === 'agg:git-snapshot') hmrFrames.push({ ...m.data, at: Date.now() });
      } catch {
        /* 不是 JSON：略過 */
      }
    }),
  );
  const waitPushed = (repo, sha, what) =>
    waitUntil(
      () =>
        hmrFrames.some((f) => f.repo === repo && (JSON.stringify(f.snapshot) ?? '').includes(sha)),
      20_000,
      `HMR push for ${what}`,
    );
  /** 非預設 repo 的 commit 內容永遠不會經由 HMR 廣播出去（只有通知）。 */
  const assertOnlyDefaultSnapshotsBroadcast = () => {
    const leaked = hmrFrames.filter((f) => f.repo !== 'default' && 'snapshot' in f);
    assert.deepEqual(
      leaked.map((f) => f.repo),
      [],
      'HMR frames for non-default repos must not carry a snapshot',
    );
  };

  await step(
    'LOCAL PICKER: the menu lists the default repo (★) first, then beta and group/gamma; node_modules / dot / symlinked / outside repos are not listed; option values are ids, never paths; "Open another path…" is a separate ＋ button, not an option',
    async () => {
      await page.goto(base); // 也讓 websocket 監聽從這裡開始
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'default repo');
      await waitPickerHas(ids.gamma);
      const opts = await pickerOptions();
      assert.deepEqual(
        opts.map((o) => o.value),
        ['default', ids.beta, ids.gamma],
        'menu: the default repo, then the scanned repos by name (and nothing else)',
      );
      assert.deepEqual(
        opts.map((o) => o.text),
        [
          `★ ${dirBase(repoDir)} — ${repoLabelOf(repoDir)}`,
          `beta — ${repoLabelOf(fx.beta)}`,
          `gamma — ${repoLabelOf(fx.gamma)}`,
        ],
      );
      // 「開啟其他路徑…」：選單旁邊獨立的 ＋ 按鈕（鍵盤在選單上瀏覽時不會經過它）
      assert.equal(await addBtn().count(), 1, 'one "Open another path…" button');
      assert.deepEqual(
        await addBtn().evaluate((b) => ({
          cls: b.className,
          text: b.textContent,
          title: b.title,
          type: b.type,
          afterMenu: b.previousElementSibling?.matches('select.web-select') ?? false,
        })),
        { cls: 'web-icon web-add', text: '＋', title: ADD_LABEL, type: 'button', afterMenu: true },
        'the ＋ button sits right after the menu',
      );
      assert.ok(
        !opts.some((o) => o.value === '__add' || o.text.includes(ADD_LABEL)),
        'no "open another path" option inside the menu',
      );
      assert.equal(await pickerValue(), 'default', 'the default repo is selected');
      assert.deepEqual(
        opts.filter((o) => o.selected).map((o) => o.value),
        ['default'],
      );
      assert.equal(
        await picker().getAttribute('title'),
        repoLabelOf(repoDir),
        'the menu tooltip is the location of the selected repo',
      );
      for (const o of opts) {
        assert.match(o.value, /^(default|[0-9a-f]{12})$/, `option value "${o.value}"`);
        assert.ok(!o.value.includes('/'), 'option values never carry a path');
      }
      const texts = opts.map((o) => o.text).join('\n');
      for (const absent of ['hidden', 'node_modules', 'linked', 'far-away', 'plain', 'sneaky'])
        assert.ok(!texts.includes(absent), `"${absent}" must not be listed:\n${texts}`);
      // API 本身：同一份清單；每個 repo 只有 id / name / label / isDefault（沒有資料夾路徑以外的東西，也沒有 dir）
      const api = await sameOriginRepos();
      assert.equal(api.status, 200);
      assert.equal(api.body.truncated, false);
      assert.deepEqual(
        api.body.repos.map((r) => [r.id, r.name, r.isDefault]),
        [
          ['default', dirBase(repoDir), true],
          [ids.beta, 'beta', false],
          [ids.gamma, 'gamma', false],
        ],
      );
      for (const r of api.body.repos)
        assert.deepEqual(Object.keys(r).sort(), ['id', 'isDefault', 'label', 'name']);
      await page.screenshot({ path: resolve(artifacts, '12-picker.png') });
    },
  );

  await step(
    'LOCAL PICKER: choosing beta shows its history (URL ?local=<id>, title, rows, branches, graph) from the top; choosing ★ returns to the 88-commit repo',
    async () => {
      // 預設 repo 先捲下去、選一列：換 repo 時兩者都要重設
      await scrollTo(900);
      const g = await visibleGeometry();
      await clickRow(g.rows[2].sha);
      await waitSelected(g.rows[2].sha, 'a default-repo row');
      const historyBefore = await page.evaluate(() => history.length);
      await picker().selectOption(ids.beta);
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta');
      assert.equal(
        await page.evaluate(() => history.length),
        historyBefore + 1,
        'one history entry per pick',
      );
      assert.match(await page.title(), /^beta · /);
      assert.equal(await pickerValue(), ids.beta);
      assert.equal(await picker().getAttribute('title'), repoLabelOf(fx.beta));
      assert.equal(await commitCount(), gitCount(fx.beta));
      assert.equal(await page.locator('.agg-branch').count(), gitBranches(fx.beta).length);
      const rows = await domRows();
      const defaultShas = new Set(shasOf(repoDir));
      assert.ok(
        rows.every((r) => !defaultShas.has(r.sha)),
        'no row of the 88-commit repo is left',
      );
      assert.ok(
        rows.every((r) => r.subject.startsWith('beta: ')),
        'every row is a beta commit',
      );
      assert.equal(await scrollTopNow(), 0, 'another repo starts at the top');
      assert.equal(await selectedSha(), null, 'the selection made in the other repo is gone');
      assert.equal(await page.locator('.agg-detail').count(), 0);
      assert.ok((await scrollMax()) > 300, 'sanity: beta is long enough to scroll');
      await replayDone();
      await graphSync('beta repo');
      await page.mouse.move(720, 8);
      await page.screenshot({ path: resolve(artifacts, '12-beta.png') });

      // ★ 預設 repo（beta 先捲下去：回來時一樣從頭看）
      await scrollTo(400);
      await picker().selectOption('default');
      await waitSearch('');
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'the default repo again');
      assert.equal(await commitCount(), expected);
      assert.equal(await pickerValue(), 'default');
      assert.match(await page.title(), /^octo\/cat · /);
      assert.equal(await scrollTopNow(), 0, 'back to the default repo: from the top');
      assert.equal(await selectedSha(), null);
      await replayDone();
      await graphSync('default repo after beta');
    },
  );

  await step(
    'LOCAL PICKER: browser Back / Forward switch between the local repos (the view and the menu follow, not just the URL)',
    async () => {
      await page.goBack();
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta after Back');
      assert.equal(await pickerValue(), ids.beta);
      assert.match(
        await page.locator('.web-seg button[aria-pressed="true"]').first().innerText(),
        /Local/,
      );
      assert.equal(await scrollTopNow(), 0);
      await page.goForward();
      await waitSearch('');
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'the default repo after Forward');
      assert.equal(await pickerValue(), 'default');
      await page.goBack();
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta after Back again');
      await page.goForward();
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'the default repo after Forward again');
    },
  );

  await step(
    'LOCAL PICKER keyboard: ↓ ↓ on the closed menu only move the menu (URL, title and history stay put); ~700 ms after the last key it switches ONCE (one history entry, only the final repo is fetched); ↑ + Enter switches right away',
    async () => {
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'the default repo');
      await waitPickerValue('default');
      await replayDone();
      assert.deepEqual(
        (await pickerOptions()).map((o) => o.value),
        ['default', ids.beta, ids.gamma],
        'sanity: ★ → beta → gamma, top to bottom',
      );
      // 頁面這邊的紀錄（performance.now）：每一次 pushState、每一個按鍵、標題的每一次變化
      await page.evaluate(() => {
        window.__nav = [];
        window.__keys = [];
        window.__titleLog = [document.querySelector('.agg-title-text')?.textContent ?? ''];
        if (window.__kbdProbe) return;
        window.__kbdProbe = true;
        const push = history.pushState.bind(history);
        history.pushState = (...args) => {
          window.__nav.push({ url: String(args[2]), t: performance.now() });
          return push(...args);
        };
        document.addEventListener(
          'keydown',
          (e) => window.__keys.push({ key: e.key, t: performance.now() }),
          true,
        );
        new MutationObserver(() => {
          const t = document.querySelector('.agg-title-text')?.textContent;
          if (t && window.__titleLog[window.__titleLog.length - 1] !== t) window.__titleLog.push(t);
        }).observe(document, { subtree: true, childList: true, characterData: true });
      });
      const probe = () =>
        page.evaluate(() => ({
          nav: window.__nav.slice(),
          keys: window.__keys.slice(),
          titles: window.__titleLog.slice(),
        }));
      const resetProbe = () =>
        page.evaluate(() => {
          window.__nav = [];
          window.__keys = [];
          window.__titleLog = [document.querySelector('.agg-title-text')?.textContent ?? ''];
        });
      /** 這一刻的網址 / 標題 / 選單顯示的值 / 歷史筆數（一次讀完，彼此一致） */
      const now = () =>
        page.evaluate(
          (sel) => ({
            search: location.search,
            title: document.querySelector('.agg-title-text')?.textContent ?? '',
            menu: document.querySelector(sel)?.value ?? null,
            history: history.length,
          }),
          PICK_SEL,
        );
      // 向 dev server 要了哪些 repo 的快照
      const fetched = [];
      const onRequest = (r) => {
        if (r.url().startsWith(`${base}/__agg/git-snapshot`))
          fetched.push(new URL(r.url()).searchParams.get('repo') ?? 'default');
      };
      page.on('request', onRequest);
      try {
        const historyBefore = await page.evaluate(() => history.length);
        await page.focus(PICK_SEL);
        assert.equal(await activeLabel(), PICK_LABEL, 'the closed menu has the keyboard focus');

        // ↓ ↓（很快地連按）：每一下只改選單顯示的值，網址、標題、歷史都不動
        await page.keyboard.press('ArrowDown');
        assert.deepEqual(
          await now(),
          { search: '', title: 'octo/cat', menu: ids.beta, history: historyBefore },
          'after ↓: the menu shows beta, nothing else changed yet',
        );
        await page.keyboard.press('ArrowDown');
        assert.deepEqual(
          await now(),
          { search: '', title: 'octo/cat', menu: ids.gamma, history: historyBefore },
          'after ↓ ↓: the menu shows gamma, still no switch (beta was only passed by)',
        );
        let log = await probe();
        const arrows = log.keys.filter((k) => k.key === 'ArrowDown');
        assert.equal(arrows.length, 2, 'sanity: two ArrowDown keys reached the page');
        assert.ok(
          arrows[1].t - arrows[0].t < 700,
          `sanity: the two keys came ${Math.round(arrows[1].t - arrows[0].t)} ms apart (the test needs < 700 ms)`,
        );
        assert.deepEqual(log.nav, [], 'no navigation while the keys are coming');

        // 停下來：~700 ms 後切換「一次」，直接到 gamma
        await waitSearch(`?local=${ids.gamma}`);
        await titleIs('gamma');
        await waitShowsRepo(fx.gamma, 'gamma once the keys settle');
        log = await probe();
        assert.deepEqual(
          log.nav.map((n) => n.url),
          [`/?local=${ids.gamma}`],
          'exactly one navigation, straight to gamma',
        );
        const waited = log.nav[0].t - arrows[1].t;
        assert.ok(
          waited >= 650,
          `it switched ${Math.round(waited)} ms after the last key (it should wait ~700 ms)`,
        );
        assert.equal(
          await page.evaluate(() => history.length),
          historyBefore + 1,
          'one history entry for the whole keyboard browse',
        );
        assert.ok(
          !log.titles.includes('beta'),
          `beta was never shown (titles: ${log.titles.join(' → ')})`,
        );
        assert.ok(
          fetched.length > 0 && fetched.every((id) => id === ids.gamma),
          `only gamma's snapshot was fetched (${fetched.join(', ')})`,
        );
        await waitPickerValue(ids.gamma);
        assert.equal(await activeLabel(), PICK_LABEL, 'the menu keeps the focus after the switch');

        // ↑ + Enter：Enter 馬上切換，不等 700 ms
        await resetProbe();
        fetched.length = 0;
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        await waitSearch(`?local=${ids.beta}`);
        log = await probe();
        const up = log.keys.find((k) => k.key === 'ArrowUp');
        const enter = log.keys.find((k) => k.key === 'Enter');
        assert.ok(up && enter, 'sanity: ArrowUp and Enter reached the page');
        assert.ok(
          enter.t - up.t < 700,
          `sanity: Enter came ${Math.round(enter.t - up.t)} ms after ArrowUp (the test needs < 700 ms)`,
        );
        assert.deepEqual(
          log.nav.map((n) => n.url),
          [`/?local=${ids.beta}`],
          'one navigation, to beta',
        );
        assert.ok(
          log.nav[0].t >= enter.t && log.nav[0].t - enter.t < 300,
          `Enter switched right away (${Math.round(log.nav[0].t - enter.t)} ms after Enter, ${Math.round(log.nav[0].t - up.t)} ms after ArrowUp)`,
        );
        await titleIs('beta');
        await waitShowsRepo(fx.beta, 'beta after ↑ + Enter');
        assert.equal(
          await page.evaluate(() => history.length),
          historyBefore + 2,
          'Enter added exactly one more history entry',
        );
        assert.ok(
          fetched.length > 0 && fetched.every((id) => id === ids.beta),
          `only beta's snapshot was fetched (${fetched.join(', ')})`,
        );
        await waitPickerValue(ids.beta);
        assert.equal(await activeLabel(), PICK_LABEL);
        // 之後不會再因為剛才的按鍵而切換（計時器已經取消）
        await sleep(1000);
        assert.deepEqual(
          (await probe()).nav.map((n) => n.url),
          [`/?local=${ids.beta}`],
          'no late switch after Enter',
        );
        assert.equal(searchOf(), `?local=${ids.beta}`);
      } finally {
        page.off('request', onRequest);
      }
      await replayDone();
    },
  );

  await step(
    'LOCAL PICKER: a deep link ?local=<id> in a fresh tab opens that repo directly (the default repo never flashes first)',
    async () => {
      const deep = await ctx.newPage();
      watchErrors(deep, 'deep-link page');
      try {
        // 記下標題的每一次變化（MutationObserver 從文件建立就開始看）
        await deep.addInitScript(() => {
          window.__titles = [];
          new MutationObserver(() => {
            const t = document.querySelector('.agg-title-text')?.textContent;
            if (t && window.__titles[window.__titles.length - 1] !== t) window.__titles.push(t);
          }).observe(document, { subtree: true, childList: true, characterData: true });
        });
        await deep.goto(`${base}/?local=${ids.beta}`);
        await titleIs('beta', deep);
        await waitShowsRepo(fx.beta, 'beta (deep link)', deep);
        assert.match(await deep.title(), /^beta · /);
        assert.equal(searchOf(deep), `?local=${ids.beta}`);
        await waitPickerValue(ids.beta, deep);
        const titles = await deep.evaluate(() => window.__titles);
        assert.ok(
          !titles.includes('octo/cat'),
          `the default repo was shown before beta (${titles.join(' → ')})`,
        );
        await replayDone(deep);
        await graphSync('beta (deep link)', { pg: deep });
      } finally {
        await deep.close();
      }
      await page.bringToFront();
    },
  );

  await step(
    'LIVE (local picker): a commit in the selected non-default repo pops in without reloading (HMR only notifies { repo: id }, the page re-fetches it); a commit in the default repo meanwhile does not leak into it and is there when switching back',
    async () => {
      await picker().selectOption(ids.beta);
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta');
      await replayDone();
      await page.evaluate(() => (window.__alive = 'beta'));
      await watchReplay();
      // 頁面向 dev server 要 beta 快照的時間：通知到了以後必須再要一次
      const betaFetches = [];
      const onRequest = (r) => {
        if (r.url().startsWith(`${base}/__agg/git-snapshot?repo=${ids.beta}`))
          betaFetches.push(Date.now());
      };
      page.on('request', onRequest);
      const framesBefore = hmrFrames.length;
      commit(fx.beta, 'beta: live from the other repo', 'Dan');
      const betaHead = git(fx.beta, 'rev-parse', 'HEAD');
      try {
        await waitShowsRepo(fx.beta, 'beta after a live commit');
      } finally {
        page.off('request', onRequest);
      }
      assert.equal((await domRows())[0].subject, 'beta: live from the other repo');
      assert.equal((await domRows())[0].sha, betaHead);
      assert.equal(
        await page.evaluate(() => window.__alive),
        'beta',
        'page must not have reloaded',
      );
      const notices = hmrFrames.slice(framesBefore).filter((f) => f.repo === ids.beta);
      assert.ok(
        notices.length > 0,
        'the update was announced by an HMR event tagged with the beta id',
      );
      assert.deepEqual(
        Object.keys(notices[0]).filter((k) => k !== 'at'),
        ['repo'],
        'a non-default repo is only notified (no snapshot over HMR)',
      );
      assert.ok(
        betaFetches.some((t) => t >= notices[0].at - 50),
        'after the notification the page fetched beta again from the loopback-only endpoint',
      );
      assertOnlyDefaultSnapshotsBroadcast();
      assert.equal(await commitCount(), gitCount(fx.beta));
      assert.equal(searchOf(), `?local=${ids.beta}`);
      assert.equal(await scrollTopNow(), 0);
      assert.ok(await rowFullyVisible(betaHead), 'the new commit is visible without scrolling');
      await waitUntil(
        async () => (await replayLog()).includes('playing'),
        10_000,
        'the new beta commit pops in',
      );
      await replayDone();
      await graphSync('beta after a live commit');

      // beta 顯示中，預設 repo 來了一筆：推送到了以後 beta 的畫面也不能變
      const betaRows = (await domRows()).map((r) => r.sha);
      commit(repoDir, 'live: while beta is shown');
      expected++;
      const defHead = git(repoDir, 'rev-parse', 'HEAD');
      await waitPushed('default', defHead, 'the default-repo commit');
      await sleep(400); // 推送已經到了：給 React 一點時間（若有錯）重畫
      assert.deepEqual(
        (await domRows()).map((r) => r.sha),
        betaRows,
        'a default-repo update must not change the beta view',
      );
      assert.equal(await page.locator('.agg-title-text').innerText(), 'beta');
      assert.equal(searchOf(), `?local=${ids.beta}`);
      // 切回 ★：新的 commit 已經在最上面（推送是在看 beta 時收下的）
      await picker().selectOption('default');
      await waitSearch('');
      await titleIs('octo/cat');
      await waitForCommits(expected);
      await waitShowsRepo(repoDir, 'the default repo with the commit made while beta was shown');
      assert.equal((await domRows())[0].subject, 'live: while beta is shown');
      assert.equal(await page.evaluate(() => window.__alive), 'beta', 'still no reload');
      assert.equal(expected, gitCount(repoDir), 'expected-count bookkeeping');
    },
  );

  await step(
    'LOCAL PICKER: an unknown id (?local=0123456789ab) shows the "does not know this local repository" error and "(repository not in the list)" in the menu; picking from the menu recovers; a malformed id falls back to the default repo',
    async () => {
      await page.goto(`${base}/?local=0123456789ab`);
      const panel = page.locator('.agg-center[role="alert"]');
      await panel.waitFor();
      assert.match(await panel.innerText(), /does not know this local repository/);
      assert.ok(!(await panel.innerText()).includes(tmpdir()), 'no local path in the message');
      assert.equal(await page.locator('.agg-scroll').count(), 0, 'no list for an unknown repo');
      assert.equal(searchOf(), '?local=0123456789ab', 'the URL is left alone');
      await waitPickerHas(ids.beta);
      const sel = (await pickerOptions()).filter((o) => o.selected);
      assert.deepEqual(
        sel.map((o) => o.text),
        ['(repository not in the list)'],
        'the menu says the current repo is not in the list',
      );
      assert.equal(await pickerValue(), '__current');
      await page.screenshot({ path: resolve(artifacts, '12-unknown-repo.png') });
      // 從選單挑一個就好了
      await picker().selectOption(ids.beta);
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta after the unknown id');
      assert.equal(await page.locator('.agg-center').count(), 0, 'the error panel is gone');
      assert.deepEqual(
        (await pickerOptions()).map((o) => o.value),
        ['default', ids.beta, ids.gamma],
        'the placeholder option is gone once a listed repo is shown',
      );
      // 格式不對的 id（像路徑）：直接當成預設 repo，不會送到 dev server
      await page.goto(`${base}/?local=..%2F..%2Fetc`);
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'the default repo for a malformed id');
      await waitPickerValue('default');
    },
  );

  await step(
    'LOCAL PICKER: ＋ "Open another path…" — relative / missing / non-git paths get a clear error (focus stays in the path box, even after clicking Open), Esc and ✕ close the form and give focus back to the menu, ✕ keeps the ink color under a dark OS scheme, an absolute path outside the scanned folders opens that repo (focus back on the menu), joins the menu and is remembered by the dev server (state file), not by the browser; <default repo>/.git opens the default repo without a duplicate entry',
    async () => {
      await page.goto(base);
      await titleIs('octo/cat');
      await waitPickerHas(ids.beta);
      assert.equal(readState(mainState), null, 'nothing typed yet: no state file');
      /** 按 ＋ 打開輸入框（`on`：目前顯示的 repo；按 ＋ 本身不會改變選取或網址）。 */
      const openForm = async (on = 'default') => {
        await addBtn().click();
        await pathInput().waitFor();
        assert.equal(await activeLabel(), PATH_LABEL, 'the path box gets the keyboard focus');
        assert.equal(await addBtn().count(), 0, 'the ＋ button makes way for the form');
        assert.equal(await pickerValue(), on, 'the action itself is not a selection');
        assert.equal(searchOf(), on === 'default' ? '' : `?local=${on}`);
      };
      await openForm();
      const openBtn = page.locator('.web-form button[type="submit"]', { hasText: /^Open$/ });
      // 空的時候：aria-disabled（不是 disabled：按鈕不能因為送出中 / 清空就失去焦點）
      assert.equal(
        await openBtn.getAttribute('aria-disabled'),
        'true',
        'Open is marked disabled while the box is empty',
      );
      assert.equal(await openBtn.isDisabled(), true, 'Open is disabled while the box is empty');
      assert.equal(
        await openBtn.evaluate((b) => b.disabled),
        false,
        'aria-disabled, not the disabled attribute (the button stays focusable)',
      );
      assert.equal(await pathInput().getAttribute('placeholder'), '/path/to/repo or ~/code/repo');
      assert.equal(await pathInput().getAttribute('aria-invalid'), 'false');
      // 深色的系統配色（頁面宣告 color-scheme: light dark，按鈕預設的文字顏色會變成淺色，淺色底上就看不到）：
      // ✕（之後的 ＋ 也一樣）的文字顏色要是 --agg-ink
      const iconColor = (sel) =>
        page.evaluate((s) => {
          const el = document.querySelector(s);
          return {
            color: getComputedStyle(el).color,
            text: el.textContent,
            paper: getComputedStyle(el).backgroundColor,
            dark: matchMedia('(prefers-color-scheme: dark)').matches,
          };
        }, sel);
      const CANCEL_SEL = '.web-form button[aria-label="Cancel"]';
      await page.emulateMedia({ colorScheme: 'dark' });
      try {
        const dark = await iconColor(CANCEL_SEL);
        assert.equal(dark.dark, true, 'sanity: the dark scheme is emulated');
        assert.equal(dark.text, '✕');
        assert.equal(dark.color, INK, `✕ under a dark OS scheme (on ${dark.paper})`);
        await page.screenshot({ path: resolve(artifacts, '12-add-path-dark.png') });
      } finally {
        await page.emulateMedia({ colorScheme: 'light' });
      }
      const light = await iconColor(CANCEL_SEL);
      assert.equal(light.dark, false);
      assert.equal(light.color, INK, '✕ under a light OS scheme');
      assert.equal(await activeLabel(), PATH_LABEL, 'still typing in the path box');

      const tryPath = async (value, message, what, { click = false } = {}) => {
        await pathInput().fill(value);
        assert.equal(await pathError().count(), 0, `${what}: typing clears the previous error`);
        assert.equal(await openBtn.getAttribute('aria-disabled'), 'false', what);
        assert.equal(await openBtn.isDisabled(), false);
        if (click) await openBtn.click();
        else await pathInput().press('Enter');
        await pathError().waitFor();
        assert.equal(await pathError().innerText(), message, what);
        assert.equal(await pathError().getAttribute('id'), 'web-path-error');
        assert.equal(await pathInput().getAttribute('aria-invalid'), 'true', what);
        assert.equal(await pathInput().getAttribute('aria-describedby'), 'web-path-error', what);
        assert.equal(await pathInput().inputValue(), value, `${what}: the text stays for fixing`);
        assert.equal(searchOf(), '', `${what}: no navigation`);
        assert.equal(await page.locator('.web-error').count(), 1);
        // 失敗後焦點在輸入框（按 Open 送出時，焦點原本在按鈕上）
        await waitUntil(
          async () => (await activeLabel()) === PATH_LABEL,
          5000,
          `${what}: the focus goes back to the path box`,
        );
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-invalid')),
          'true',
          `${what}: the focused box is the one marked invalid`,
        );
      };
      await tryPath('beta', 'Enter an absolute path (~ for your home folder works).', 'relative');
      await tryPath(
        './group/gamma',
        'Enter an absolute path (~ for your home folder works).',
        './',
      );
      await tryPath(
        resolve(fx.rootsDir, 'no-such-folder'),
        'That folder does not exist.',
        'missing folder (submitted by clicking Open)',
        { click: true },
      );
      await tryPath(
        resolve(fx.plain, 'notes.txt'),
        'That folder does not exist.',
        'a file, not a folder (submitted by clicking Open)',
        { click: true },
      );
      await tryPath(fx.plain, 'That folder is not inside a git repository.', 'not a git repo');
      await page.screenshot({ path: resolve(artifacts, '12-add-path-error.png') });

      // Esc：表單與錯誤都收掉，焦點回到選單，viewer 不受影響（Esc 不會漏到 viewer）
      await pathInput().press('Escape');
      await pathInput().waitFor({ state: 'detached' });
      assert.equal(await pathError().count(), 0, 'Esc also clears the error');
      assert.equal(await activeLabel(), PICK_LABEL, 'Esc gives the focus back to the menu');
      assert.equal(searchOf(), '');
      assert.equal(await pickerValue(), 'default');
      assert.equal(await addBtn().count(), 1, 'the ＋ button is back after Esc');
      await page.emulateMedia({ colorScheme: 'dark' });
      try {
        const plus = await iconColor('button.web-add');
        assert.equal(plus.dark, true, 'sanity: the dark scheme is emulated');
        assert.equal(plus.text, '＋');
        assert.equal(plus.color, INK, `＋ under a dark OS scheme (on ${plus.paper})`);
      } finally {
        await page.emulateMedia({ colorScheme: 'light' });
      }
      await waitShowsRepo(repoDir, 'the default repo after Esc');
      assert.equal(readState(mainState), null, 'failed paths are not remembered');
      // ✕（取消）按鈕也一樣
      await openForm();
      await pathInput().fill('/somewhere');
      await page.locator(`.web-form button[aria-label="Cancel"]`).click();
      await pathInput().waitFor({ state: 'detached' });
      assert.equal(await activeLabel(), PICK_LABEL, '✕ gives the focus back to the menu');
      assert.equal(await addBtn().count(), 1, 'the ＋ button is back after ✕');

      // 範圍外的 repo（絕對路徑）：打開、加進選單、由 dev server 記在 AGG_LOCAL_REPOS_FILE（瀏覽器不記）
      await openForm();
      await pathInput().fill(fx.far);
      await openBtn.click();
      await waitSearch(`?local=${ids.far}`);
      await titleIs('far-away');
      await waitShowsRepo(fx.far, 'far-away');
      assert.match(await page.title(), /^far-away · /);
      await pathInput().waitFor({ state: 'detached' });
      assert.equal(await pathError().count(), 0);
      // 成功：焦點回到選單（按 Open 送出的；表單消失後不能掉回 <body>）
      await waitUntil(
        async () => (await activeLabel()) === PICK_LABEL,
        5000,
        'the focus goes to the menu after a successful add',
      );
      assert.equal(
        await page.evaluate(
          (sel) => document.activeElement === document.querySelector(sel),
          PICK_SEL,
        ),
        true,
        'document.activeElement is the menu',
      );
      await waitPickerHas(ids.far);
      await waitPickerValue(ids.far);
      // 先樂觀地放進清單（排在最後），重新掃描回來後依名稱排序：等清單回來
      await waitPickerValues(
        ['default', ids.beta, ids.far, ids.gamma],
        'the opened repo joins the menu (by name)',
      );
      const opts = await pickerOptions();
      assert.equal(opts.find((o) => o.value === ids.far).text, `far-away — ${repoLabelOf(fx.far)}`);
      // 先回應、再寫檔（暫存檔 + rename）：等檔案出現
      await waitUntil(
        () => readState(mainState) !== null,
        10_000,
        'the dev server writes its state file',
      );
      assert.deepEqual(
        readState(mainState),
        { paths: [realpathSync(fx.far)] },
        'the dev server remembers the typed path (resolved)',
      );
      assert.equal(
        statSync(mainState).mode & 0o777,
        0o600,
        'the state file is private to the user',
      );
      await assertNoPathsInBrowser([fx.far], page, 'after opening a typed path');
      await replayDone();
      // 透過 symlink（在掃描範圍內、但本身不列出）輸入的路徑：同一個 repo、同一個 id，不會多一筆
      await picker().selectOption('default');
      await titleIs('octo/cat');
      await openForm();
      await pathInput().fill(resolve(fx.rootsDir, 'linked'));
      await pathInput().press('Enter');
      await waitSearch(`?local=${ids.far}`);
      await titleIs('far-away');
      await waitShowsRepo(fx.far, 'far-away through the symlink');
      await waitPickerValue(ids.far);
      assert.equal(
        (await pickerOptions()).filter((o) => o.value === ids.far).length,
        1,
        'the symlink resolves to the same repo: no duplicate entry',
      );
      await waitUntil(
        () => !readdirSync(stateDir).some((f) => f.endsWith('.tmp')),
        10_000,
        'the state file write to finish',
      );
      assert.deepEqual(
        readState(mainState),
        { paths: [realpathSync(fx.far)] },
        'still one remembered path (the real location, not the symlink)',
      );
      await assertNoPathsInBrowser(
        [fx.far, resolve(fx.rootsDir, 'linked')],
        page,
        'after the symlink',
      );

      // 預設 repo 的 .git 資料夾（在 git 目錄「裡面」）：打開的是預設 repo 本身（網址沒有 ?local），清單不會多一筆、也不會記下來
      await replayDone();
      const historyBefore = await page.evaluate(() => history.length);
      await openForm(ids.far);
      await pathInput().fill(resolve(repoDir, '.git'));
      await pathInput().press('Enter');
      await waitSearch('');
      await titleIs('octo/cat');
      await waitShowsRepo(repoDir, 'the default repo opened through its .git folder');
      await pathInput().waitFor({ state: 'detached' });
      assert.equal(await pathError().count(), 0, 'no error for <repo>/.git');
      await waitPickerValue('default');
      assert.equal(
        await page.evaluate(() => history.length),
        historyBefore + 1,
        'one history entry (far-away → the default repo)',
      );
      await waitPickerValues(
        ['default', ids.beta, ids.far, ids.gamma],
        '<default repo>/.git adds no entry (no second copy of the default repo)',
      );
      const texts = (await pickerOptions()).map((o) => o.text);
      assert.deepEqual(
        texts.filter((t) => t.endsWith(` — ${repoLabelOf(repoDir)}`)),
        [`★ ${dirBase(repoDir)} — ${repoLabelOf(repoDir)}`],
        `the default repo is listed once:\n${texts.join('\n')}`,
      );
      assert.ok(!texts.some((t) => t.includes('.git')), 'no ".git" entry');
      const listed = await sameOriginRepos();
      assert.deepEqual(
        listed.body.repos.map((r) => r.id),
        ['default', ids.beta, ids.far, ids.gamma],
        'the dev server did not add a second entry either',
      );
      await waitUntil(
        () => !readdirSync(stateDir).some((f) => f.endsWith('.tmp')),
        10_000,
        'the state file write to finish',
      );
      assert.deepEqual(
        readState(mainState),
        { paths: [realpathSync(fx.far)] },
        'the default repo is not remembered as a typed path',
      );
      assert.equal(await activeLabel(), PICK_LABEL, 'the focus is back on the menu');
      await assertNoPathsInBrowser([repoDir], page, 'after <default repo>/.git');
    },
  );

  await step(
    'LOCAL PICKER: a typed path survives a dev server restart through AGG_LOCAL_REPOS_FILE — the same file lists it and opens ?local=<id> directly (even in a fresh browser); a different (empty) file does not know it (even in the browser that typed it)',
    async () => {
      const p = await freePort();
      const origin = `http://localhost:${p}`;
      // 這一步專用的檔案：main 的 dev server 記得 far-away，但那是另一個檔案（不共用）
      const kept = stateFileOf('restart');
      const empty = stateFileOf('restart-empty');
      writeFileSync(empty, '{ "paths": [] }\n');
      const withState = (file) =>
        startVite(['--port', String(p), '--strictPort'], { ...env, AGG_LOCAL_REPOS_FILE: file });
      const values = async (pg) => (await pickerOptions(pg)).map((o) => o.value);
      let side = withState(kept);
      // 什麼都沒記的瀏覽器：證明重新啟動後認得 far-away 是 server 記得，不是瀏覽器幫忙重新登記
      const fresh = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
      });
      fresh.setDefaultTimeout(30_000 * SCALE);
      fresh.setDefaultNavigationTimeout(30_000 * SCALE);
      try {
        await side.ready;
        // ① 第一個 dev server：只認得掃描到的 repo；輸入 far-away 的路徑
        const pg = await ctx.newPage();
        watchErrors(pg, 'restart page (typing)');
        await pg.goto(origin);
        await titleIs('octo/cat', pg);
        await waitPickerHas(ids.beta, pg);
        assert.deepEqual(
          await values(pg),
          ['default', ids.beta, ids.gamma],
          'a dev server with a new state file knows only the scanned repos',
        );
        assert.equal(readState(kept), null, 'no state file before anything is typed');
        await addBtn(pg).click();
        await pathInput(pg).fill(fx.far);
        await pathInput(pg).press('Enter');
        await waitSearch(`?local=${ids.far}`, pg);
        await waitShowsRepo(fx.far, 'far-away before the restart', pg);
        await waitUntil(
          () => readState(kept) !== null,
          10_000,
          'the dev server writes its state file',
        );
        assert.deepEqual(readState(kept), { paths: [realpathSync(fx.far)] });
        assert.equal(statSync(kept).mode & 0o777, 0o600, 'the state file is private to the user');
        await assertNoPathsInBrowser([fx.far], pg, 'restart page after typing');
        await pg.close(); // 關掉，免得 vite client 在 server 重啟時自己重新整理

        // ② 同一個埠、同一個檔案重新啟動：全新的瀏覽器直接打開 ?local=<id>
        await stopVite(side);
        side = withState(kept);
        await side.ready;
        const again = await fresh.newPage();
        watchErrors(again, 'restart page (same state file)');
        await again.addInitScript(() => {
          window.__titles = [];
          new MutationObserver(() => {
            const t = document.querySelector('.agg-title-text')?.textContent;
            if (t && window.__titles[window.__titles.length - 1] !== t) window.__titles.push(t);
          }).observe(document, { subtree: true, childList: true, characterData: true });
        });
        await again.goto(`${origin}/?local=${ids.far}`);
        await titleIs('far-away', again);
        await waitShowsRepo(fx.far, 'far-away after the restart', again);
        assert.equal(await again.locator('.agg-center').count(), 0, 'no error panel');
        await waitPickerHas(ids.far, again);
        await waitPickerValue(ids.far, again);
        assert.deepEqual(
          await values(again),
          ['default', ids.beta, ids.far, ids.gamma],
          'the remembered repo is in the menu right after the restart',
        );
        const titles = await again.evaluate(() => window.__titles);
        assert.ok(
          !titles.includes('octo/cat'),
          `the default repo was shown before far-away (${titles.join(' → ')})`,
        );
        await assertNoPathsInBrowser([fx.far], again, 'fresh browser after the restart');
        await again.close();

        // ③ 同一個埠、不同（空的）檔案：就連當初輸入路徑的那個瀏覽器（同一個 origin）也打不開——瀏覽器不會替 server 記
        await stopVite(side);
        side = withState(empty);
        await side.ready;
        const other = await ctx.newPage();
        watchErrors(other, 'restart page (empty state file)');
        // 瀏覽器不能在背後把路徑送回去（舊版會從 localStorage 重新登記）
        const posted = [];
        other.on('request', (r) => {
          if (r.method() !== 'GET' && r.url().startsWith(`${origin}/__agg/`)) posted.push(r.url());
        });
        await other.goto(`${origin}/?local=${ids.far}`);
        const panel = other.locator('.agg-center[role="alert"]');
        await panel.waitFor();
        assert.match(await panel.innerText(), /does not know this local repository/);
        assert.equal(await other.locator('.agg-scroll').count(), 0, 'no list for an unknown repo');
        assert.equal(searchOf(other), `?local=${ids.far}`, 'the URL is left alone');
        await waitPickerHas(ids.beta, other);
        const opts = await pickerOptions(other);
        assert.deepEqual(
          opts.map((o) => o.value),
          ['__current', 'default', ids.beta, ids.gamma],
        );
        assert.deepEqual(
          opts.filter((o) => o.selected).map((o) => o.text),
          ['(repository not in the list)'],
        );
        assert.deepEqual(posted, [], 'the page posts nothing on its own');
        assert.deepEqual(readState(empty), { paths: [] }, 'nothing was re-registered');
        assert.deepEqual(
          readState(kept),
          { paths: [realpathSync(fx.far)] },
          'the other state file is untouched',
        );
        await other.close();
      } finally {
        await fresh.close();
        await stopVite(side);
      }
      await page.bringToFront();
    },
  );

  await step(
    'LOCAL PICKER + GitHub: Local while a non-default repo is shown keeps it; GitHub and back (Back button, Local button) keep working; GitHub → Local returns to the last local repo (beta / gamma / ★), not always ★; a commit made meanwhile is there',
    async () => {
      await picker().selectOption(ids.beta);
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta');
      // ① GitHub 只是打開輸入框；再按 Local：仍然是 beta（不能被換回預設 repo）
      await srcGitHub().click();
      await ghInput().waitFor();
      assert.equal(await picker().count(), 0, 'the local menu hides while the GitHub box is open');
      assert.equal(
        searchOf(),
        `?local=${ids.beta}`,
        'opening the GitHub box alone does not navigate',
      );
      await srcLocal().click();
      await picker().waitFor();
      assert.equal(await ghInput().count(), 0);
      assert.equal(
        searchOf(),
        `?local=${ids.beta}`,
        'Local while a local repo is shown must not reset to the default repo',
      );
      await waitPickerValue(ids.beta);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'still beta after clicking Local');
      await srcLocal().click(); // 已經在本機：再按一次也一樣
      await sleep(300);
      assert.equal(searchOf(), `?local=${ids.beta}`);
      assert.equal(await page.locator('.agg-title-text').innerText(), 'beta');

      // ② 真的切到 GitHub；那段時間 beta 有新 commit
      await srcGitHub().click();
      await ghInput().fill('demo/adorable-git-graph');
      await ghInput().press('Enter');
      await titleIs('demo/adorable-git-graph');
      assert.equal(searchOf(), '?repo=demo/adorable-git-graph');
      await waitUntil(async () => (await domRows()).length === SPECS.length, 10_000, 'github rows');
      assert.equal(await picker().count(), 0, 'no local menu on GitHub');
      commit(fx.beta, 'beta: made while on GitHub', 'Dan');
      // 上一頁 → beta（含剛才的 commit）
      await page.goBack();
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta after Back from GitHub (with the commit made meanwhile)');
      assert.equal((await domRows())[0].subject, 'beta: made while on GitHub');
      assert.equal(await scrollTopNow(), 0);
      await waitPickerValue(ids.beta);
      // 下一頁 → GitHub；Local 按鈕 → 回到最後看的本機 repo（beta），不是預設 repo；選單照常可用
      await page.goForward();
      await titleIs('demo/adorable-git-graph');
      await srcLocal().click();
      await waitSearch(`?local=${ids.beta}`);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta after GitHub → Local (the last local repo, not ★)');
      await waitPickerHas(ids.far);
      await waitPickerValue(ids.beta);
      assert.equal(await commitCount(), gitCount(fx.beta));
      await picker().selectOption(ids.gamma);
      await waitSearch(`?local=${ids.gamma}`);
      await titleIs('gamma');
      await waitShowsRepo(fx.gamma, 'gamma (nested two levels down)');

      // ③ 中間沒有上一頁 / 下一頁：從選單挑一個 → GitHub → Local = 剛才挑的那個（gamma、beta，★ 也一樣）
      for (const [id, dir, name, search] of [
        [ids.gamma, fx.gamma, 'gamma', `?local=${ids.gamma}`],
        [ids.beta, fx.beta, 'beta', `?local=${ids.beta}`],
        ['default', repoDir, 'octo/cat', ''],
      ]) {
        await picker().selectOption(id);
        await waitSearch(search);
        await titleIs(name);
        await waitShowsRepo(dir, `${name} picked from the menu`);
        await srcGitHub().click();
        await ghInput().fill('demo/adorable-git-graph');
        await ghInput().press('Enter');
        await titleIs('demo/adorable-git-graph');
        assert.equal(searchOf(), '?repo=demo/adorable-git-graph');
        const historyBefore = await page.evaluate(() => history.length);
        await srcLocal().click();
        await waitSearch(search);
        await titleIs(name);
        await waitShowsRepo(dir, `${name} again after GitHub → Local`);
        await waitPickerValue(id);
        assert.equal(
          await page.evaluate(() => history.length),
          historyBefore + 1,
          `GitHub → Local (${name}): one history entry`,
        );
      }
    },
  );

  await step(
    'LOCAL PICKER responsive: 390×800 and 320×640 — the menu, its ＋ button, the path box and its error fit the screen; no horizontal page overflow and nothing scrolls sideways',
    async () => {
      await picker().selectOption(ids.beta);
      await titleIs('beta');
      await waitShowsRepo(fx.beta, 'beta');
      /** 頁面不能橫向捲動；工具列的每一層祖先也不能偷偷被捲（overflow: hidden 的元素用程式捲得動 = 內容被裁掉）。 */
      const sideways = () =>
        page.evaluate(() => {
          const bad = [];
          const se = document.scrollingElement;
          if (se.scrollWidth > innerWidth)
            bad.push(`page scrollWidth ${se.scrollWidth} > ${innerWidth}`);
          if (document.body.scrollWidth > innerWidth)
            bad.push(`body scrollWidth ${document.body.scrollWidth} > ${innerWidth}`);
          const probe = (el, name) => {
            el.scrollLeft = 100_000;
            const left = el.scrollLeft;
            el.scrollLeft = 0;
            if (left !== 0) bad.push(`${name} scrolls sideways by ${left}px`);
          };
          probe(se, 'the page');
          probe(document.querySelector('.web-root'), '.web-root');
          for (
            let el = document.querySelector('.web-bar');
            el && el !== document.body;
            el = el.parentElement
          )
            probe(el, `<${el.tagName.toLowerCase()} class="${el.className}">`);
          if (document.querySelector('.web-root').scrollLeft !== 0)
            bad.push('.web-root scrollLeft ≠ 0');
          return bad;
        });
      /** 這些元素整個在畫面內（左右都不超出），而且不會被擠到不能用。 */
      const inside = (sels) =>
        page.evaluate((list) => {
          const bad = [];
          for (const [sel, minWidth] of list) {
            const el = document.querySelector(sel);
            if (!el) {
              bad.push(`${sel} is missing`);
              continue;
            }
            const r = el.getBoundingClientRect();
            if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5)
              bad.push(
                `${sel} spans ${r.left.toFixed(1)}–${r.right.toFixed(1)} in a ${innerWidth}px viewport`,
              );
            if (r.width < minWidth) bad.push(`${sel} is only ${r.width.toFixed(1)}px wide`);
            if (el.scrollWidth > el.clientWidth + 1 && sel === '.web-error')
              bad.push(`${sel} text is clipped (${el.scrollWidth} > ${el.clientWidth})`);
          }
          return bad;
        }, sels);
      for (const [w, h] of [
        [390, 800],
        [320, 640],
      ]) {
        await page.setViewportSize({ width: w, height: h });
        await page.locator('.agg-root[data-size="narrow"]').waitFor();
        await settleScroll();
        // 選單顯示中
        assert.deepEqual(await sideways(), [], `${w}×${h} with the menu`);
        assert.deepEqual(await noOverflow(), [], `${w}×${h} with the menu`);
        assert.deepEqual(
          await inside([
            ['select.web-select', 120],
            ['button.web-add', 30],
            ['.web-seg', 0],
            ['.web-theme', 0],
          ]),
          [],
          `${w}×${h}: the menu`,
        );
        await page.screenshot({ path: resolve(artifacts, `12-picker-${w}.png`) });
        // 輸入框 + 錯誤訊息
        await addBtn().click();
        await pathInput().waitFor();
        await pathInput().fill('relative/path/that/is/fairly/long/for/a/phone');
        await pathInput().press('Enter');
        await pathError().waitFor();
        assert.deepEqual(await sideways(), [], `${w}×${h} with the path form and an error`);
        assert.deepEqual(await noOverflow(), [], `${w}×${h} with the path form and an error`);
        assert.deepEqual(
          await inside([
            ['select.web-select', 120],
            [`input[aria-label="${PATH_LABEL}"]`, 100],
            ['.web-form button[type="submit"]', 0],
            ['.web-form button[aria-label="Cancel"]', 0],
            ['.web-error', 0],
          ]),
          [],
          `${w}×${h}: the path form`,
        );
        await page.screenshot({ path: resolve(artifacts, `12-add-path-${w}.png`) });
        await pathInput().press('Escape');
        await pathInput().waitFor({ state: 'detached' });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.agg-root[data-size="wide"]').waitFor();
      await settleScroll();
    },
  );

  await step(
    'SECURITY (local picker): other origins (another localhost port, 127.0.0.1) can neither read the repo list / snapshots nor add a repo (cors POST, no-cors POST, form POST); bad requests are rejected (an oversized body gets a real 413 too_large); a forged Host gets 403 from Vite',
    async () => {
      // 別的來源上的空白頁：localhost 的另一個埠（同站不同源：同一台機器上的別的 dev server）與 127.0.0.1（跨站）
      const blankPage = async (host) => {
        const srv = createHttpServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>other origin</title><body></body>');
        });
        await new Promise((ok) => srv.listen(0, host, ok));
        return srv;
      };
      const blanks = [await blankPage('localhost'), await blankPage('127.0.0.1')];
      const origins = [
        `http://localhost:${blanks[0].address().port}/`,
        `http://127.0.0.1:${blanks[1].address().port}/`,
      ];
      try {
        for (const url of origins) {
          const other = await ctx.newPage();
          // 從網路層看 server 的回應碼：no-cors 請求的回應頁面讀不到，但 Playwright 看得到（CORS 擋下的則完全不會回報）。
          // 用來證明不只是瀏覽器不給讀，server 本身就拒絕了。
          const responses = [];
          other.on('response', (r) => {
            if (r.url().startsWith(`${base}/__agg/`))
              responses.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
          });
          try {
            await other.goto(url);
            const out = await other.evaluate(
              async ({ base, path, betaId }) => {
                const read = async (u, init) => {
                  try {
                    const res = await fetch(u, init);
                    return `readable:${res.status}`;
                  } catch {
                    return 'blocked';
                  }
                };
                const body = JSON.stringify({ path });
                const opaque = (u, init) =>
                  fetch(u, { ...init, mode: 'no-cors' }).then(
                    (r) => r.type,
                    () => 'failed',
                  );
                return {
                  list: await read(`${base}/__agg/repos`),
                  snapshot: await read(`${base}/__agg/git-snapshot?repo=${betaId}`),
                  listNoCors: await opaque(`${base}/__agg/repos`),
                  snapshotNoCors: await opaque(`${base}/__agg/git-snapshot?repo=${betaId}`),
                  corsPost: await read(`${base}/__agg/repos`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                  }),
                  // no-cors：請求會送出去（回應讀不到），server 必須自己拒絕
                  noCorsPost: await opaque(`${base}/__agg/repos`, {
                    method: 'POST',
                    headers: { 'content-type': 'text/plain' },
                    body,
                  }),
                };
              },
              { base, path: fx.sneaky, betaId: ids.beta },
            );
            assert.equal(out.list, 'blocked', `${url}: the repo list must not be readable`);
            assert.equal(out.snapshot, 'blocked', `${url}: a repo snapshot must not be readable`);
            assert.equal(out.corsPost, 'blocked', `${url}: a JSON POST must not go through`);
            assert.deepEqual(
              [out.listNoCors, out.snapshotNoCors, out.noCorsPost],
              ['opaque', 'opaque', 'opaque'],
              `${url}: sanity: the no-cors requests were sent`,
            );
            const want = [
              'GET /__agg/repos 403',
              'GET /__agg/git-snapshot 403',
              'POST /__agg/repos 403',
            ];
            await waitUntil(
              () => want.every((w) => responses.includes(w)),
              5000,
              `${url}: the server's answers to the no-cors requests (${responses})`,
            );
            assert.ok(
              responses.every((r) => / 403$/.test(r)),
              `${url}: the server refused every request (${responses})`,
            );
            // 傳統的跨站表單（text/plain 可以拼出 JSON 的樣子）：導覽過去，但 server 拒絕
            await Promise.all([
              other.waitForURL(`${base}/__agg/repos`),
              other.evaluate(
                ({ base, path }) => {
                  const f = document.createElement('form');
                  f.method = 'POST';
                  f.action = `${base}/__agg/repos`;
                  f.enctype = 'text/plain';
                  const i = document.createElement('input');
                  i.name = `{"path":"${path}","x":"`;
                  i.value = '"}';
                  f.append(i);
                  document.body.append(f);
                  f.submit();
                },
                { base, path: fx.sneaky },
              ),
            ]);
            assert.match(await other.locator('body').innerText(), /forbidden/);
            assert.equal(responses.filter((r) => r === 'POST /__agg/repos 403').length, 2);
          } finally {
            await other.close();
          }
        }
      } finally {
        for (const srv of blanks) await new Promise((ok) => srv.close(ok));
      }
      // server 這邊：sneaky 沒有被加進去
      const listed = await sameOriginRepos();
      assert.equal(listed.status, 200);
      assert.ok(
        !listed.body.repos.some((r) => r.id === ids.sneaky || r.name === 'sneaky'),
        'a cross-origin request must not add a repository',
      );
      assert.deepEqual(
        readState(mainState),
        { paths: [realpathSync(fx.far)] },
        'nothing was written to the state file',
      );

      // 同源但格式不對的請求
      const sameOrigin = await page.evaluate(async (sneaky) => {
        const go = async (u, init) => {
          try {
            const res = await fetch(u, init);
            return `${res.status} ${(await res.json().catch(() => ({}))).error ?? ''}`.trim();
          } catch {
            return 'network error';
          }
        };
        const json = { 'content-type': 'application/json' };
        return {
          malformedId: await go('/__agg/git-snapshot?repo=..%2F..%2Fetc'),
          unknownId: await go('/__agg/git-snapshot?repo=0123456789ab'),
          postSnapshot: await go('/__agg/git-snapshot', { method: 'POST' }),
          putRepos: await go('/__agg/repos', { method: 'PUT', headers: json, body: '{}' }),
          textPlain: await go('/__agg/repos', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify({ path: sneaky }),
          }),
          notString: await go('/__agg/repos', {
            method: 'POST',
            headers: json,
            body: '{"path":42}',
          }),
          tooLarge: await go('/__agg/repos', {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ path: `/${'a'.repeat(9000)}` }),
          }),
        };
      }, fx.sneaky);
      // 超過 8KB 的 body：server 把其餘內容讀掉（不是直接斷線）再回 413，瀏覽器拿得到 { error: 'too_large' }
      assert.deepEqual(sameOrigin, {
        malformedId: '400 invalid_repo',
        unknownId: '404 unknown_repo',
        postSnapshot: '405 method_not_allowed',
        putRepos: '405 method_not_allowed',
        textPlain: '415 unsupported_media_type',
        notString: '400 invalid_path',
        tooLarge: '413 too_large',
      });

      // 瀏覽器以外的請求（node http）：偽造的 Host（DNS rebinding）在進到 plugin 之前就被 Vite 擋下
      const raw = (path, opts) => rawHttp('localhost', port, path, opts);
      const post = JSON.stringify({ path: fx.sneaky });
      const jsonHeaders = { 'content-type': 'application/json' };
      for (const path of ['/__agg/repos', `/__agg/git-snapshot?repo=${ids.beta}`]) {
        const r = await raw(path, { headers: { Host: 'evil.example' } });
        assert.equal(r.status, 403, `forged Host → ${path}`);
        assert.match(r.body, /Blocked request/, 'rejected by Vite’s host check');
        assert.ok(!r.body.includes('beta') && !r.body.includes(fx.rootsDir), 'no data leaks');
      }
      const forgedPost = await raw('/__agg/repos', {
        method: 'POST',
        headers: { ...jsonHeaders, Host: `evil.example:${port}`, Origin: 'http://evil.example' },
        body: post,
      });
      assert.equal(forgedPost.status, 403, 'forged Host + POST');
      // 正確的 Host：直接 GET（網址列 / curl）可以；fetch metadata 說是別的站就不行；POST 一定要同源頁面
      assert.equal((await raw('/__agg/repos')).status, 200, 'a direct GET is allowed');
      for (const site of ['same-site', 'cross-site'])
        assert.equal(
          (await raw('/__agg/repos', { headers: { 'Sec-Fetch-Site': site } })).status,
          403,
          `Sec-Fetch-Site: ${site}`,
        );
      assert.equal(
        (await raw('/__agg/repos', { headers: { Origin: 'http://localhost:1' } })).status,
        403,
        'Origin of another port',
      );
      for (const [what, headers] of [
        ['no Origin / fetch metadata', jsonHeaders],
        ['a foreign Origin', { ...jsonHeaders, Origin: 'http://evil.example' }],
        ['Sec-Fetch-Site: same-site', { ...jsonHeaders, 'Sec-Fetch-Site': 'same-site' }],
      ])
        assert.equal(
          (await raw('/__agg/repos', { method: 'POST', headers, body: post })).status,
          403,
          `POST with ${what}`,
        );
      // 同源、路徑本身也加得進去，但 body 超過 8KB：整個請求被拒絕，413 的回應送得到（不是連線被重設）
      const oversized = await raw('/__agg/repos', {
        method: 'POST',
        headers: { ...jsonHeaders, 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ path: fx.sneaky, pad: 'x'.repeat(9000) }),
      });
      assert.equal(oversized.status, 413, 'an oversized same-origin POST');
      assert.deepEqual(oversized.json, { error: 'too_large' }, 'an oversized same-origin POST');
      assert.ok(
        !(await sameOriginRepos()).body.repos.some((r) => r.id === ids.sneaky),
        'still not added',
      );
      assert.deepEqual(
        readState(mainState),
        { paths: [realpathSync(fx.far)] },
        'still not written',
      );

      // 對照組：同一個請求從頁面自己（同源）送出就會成功 → 上面「沒加進去」不是因為這個路徑本來就加不進去
      const added = await page.evaluate(async (path) => {
        const res = await fetch('/__agg/repos', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        return { status: res.status, body: await res.json() };
      }, fx.sneaky);
      assert.equal(added.status, 200);
      assert.deepEqual(added.body.repo, {
        id: ids.sneaky,
        name: 'sneaky',
        label: repoLabelOf(fx.sneaky),
        isDefault: false,
      });
      assert.ok((await sameOriginRepos()).body.repos.some((r) => r.id === ids.sneaky));
      await waitUntil(
        () => (readState(mainState)?.paths ?? []).includes(realpathSync(fx.sneaky)),
        10_000,
        'the same-origin add to be remembered',
      );
      assert.deepEqual(readState(mainState), {
        paths: [realpathSync(fx.far), realpathSync(fx.sneaky)],
      });
    },
  );

  // `vite --host`：手機等區網裡的裝置也連得到 dev server。它們只能看預設 repo（本來就在 bundle 裡）；
  // 清單 / 輸入路徑 / 其他 repo 的快照只回應 loopback（403 local_only）。用這台機器的非 loopback 位址模擬「另一台裝置」。
  const LAN_STEP =
    'SECURITY (vite --host): a client on a non-loopback address gets 403 local_only for the repo list, typed paths and other repos’ snapshots (the default repo still works); its page shows the disabled "local only" option and explains why, with no ＋ "Open another path…" button';
  const lanIp = lanAddress();
  if (!lanIp)
    console.log(`↷ skipped (this machine has no non-loopback IPv4 interface): ${LAN_STEP}`);
  else
    await step(LAN_STEP, async () => {
      const p = await freePort();
      const lanOrigin = `http://${lanIp}:${p}`;
      // 這台 dev server 也記得一個輸入過的路徑：從區網一樣拿不到
      const lanState = stateFileOf('lan');
      writeFileSync(lanState, `${JSON.stringify({ paths: [realpathSync(fx.far)] })}\n`);
      const stateBefore = readFileSync(lanState, 'utf8');
      const lan = startVite(['--host', '0.0.0.0', '--port', String(p), '--strictPort'], {
        ...env,
        AGG_LOCAL_REPOS_FILE: lanState,
      });
      // 這個 context 只連 <ip>：一律直連。機器上若設了 https_proxy 而 no_proxy 沒涵蓋這個位址，
      // Chromium 會把 ws://（HMR）送進那個 proxy 而被拒絕；其他位址送到不存在的 proxy（discard 埠），保證不會連出去
      const lanCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        proxy: { server: 'http://127.0.0.1:9', bypass: lanIp },
      });
      lanCtx.setDefaultTimeout(30_000 * SCALE);
      lanCtx.setDefaultNavigationTimeout(30_000 * SCALE);
      try {
        await lan.ready;
        // node http 直接連 <ip>:<port>（Host = <ip>:<port>：IP 位址 Vite 的 host 檢查本來就放行），來源位址不是 loopback
        const fromLan = (path, opts = {}) =>
          rawHttp(lanIp, p, path, { ...opts, headers: { Host: `${lanIp}:${p}`, ...opts.headers } });
        const fromHere = (path, opts = {}) =>
          rawHttp('127.0.0.1', p, path, {
            ...opts,
            headers: { Host: `localhost:${p}`, ...opts.headers },
          });
        const sameOriginHeaders = {
          'content-type': 'application/json',
          Origin: lanOrigin,
          'Sec-Fetch-Site': 'same-origin',
        };
        const lanAnswers = {
          list: await fromLan('/__agg/repos'),
          listSameOrigin: await fromLan('/__agg/repos', {
            headers: { 'Sec-Fetch-Site': 'same-origin' },
          }),
          add: await fromLan('/__agg/repos', {
            method: 'POST',
            headers: sameOriginHeaders,
            body: JSON.stringify({ path: fx.sneaky }),
          }),
          beta: await fromLan(`/__agg/git-snapshot?repo=${ids.beta}`),
          far: await fromLan(`/__agg/git-snapshot?repo=${ids.far}`),
        };
        for (const [what, r] of Object.entries(lanAnswers)) {
          assert.equal(r.status, 403, `LAN ${what}: status`);
          assert.deepEqual(r.json, { error: 'local_only' }, `LAN ${what}: body`);
          for (const leak of [fx.rootsDir, fx.outsideDir, 'beta', 'far-away', 'lantern'])
            assert.ok(!r.body.includes(leak), `LAN ${what}: must not leak "${leak}"`);
        }
        // 預設 repo（不論有沒有 ?repo=default）照常可以讀
        for (const path of ['/__agg/git-snapshot?repo=default', '/__agg/git-snapshot']) {
          const r = await fromLan(path);
          assert.equal(r.status, 200, `LAN ${path}`);
          assert.ok(r.json?.graph, `LAN ${path}: a snapshot`);
          assert.ok(r.body.includes('feat: add parser'), `LAN ${path}: the default repo`);
        }
        // 對照組：同一台 dev server 從 loopback 問就可以 → 上面的 403 是因為來源位址
        const here = await fromHere('/__agg/repos');
        assert.equal(here.status, 200);
        assert.deepEqual(
          here.json.repos.map((r) => r.id),
          ['default', ids.beta, ids.far, ids.gamma],
          'loopback: the scanned repos and the remembered one',
        );
        const hereBeta = await fromHere(`/__agg/git-snapshot?repo=${ids.beta}`);
        assert.equal(hereBeta.status, 200);
        assert.ok(hereBeta.body.includes('beta: lantern'), 'loopback: the beta snapshot');
        assert.equal(readFileSync(lanState, 'utf8'), stateBefore, 'the LAN POST wrote nothing');

        // 從區網打開的頁面：預設 repo 照常；選單說明原因，沒有其他 repo、也沒有「開啟其他路徑…」
        const lp = await lanCtx.newPage();
        watchErrors(lp, 'LAN page');
        await lp.goto(`${lanOrigin}/`);
        await titleIs('octo/cat', lp);
        await waitShowsRepo(repoDir, 'the default repo from the LAN', lp);
        const LOCAL_ONLY_TEXT =
          'Other local repositories can only be chosen and read on the computer running the dev server.';
        const waitLocalOnlyOption = () =>
          waitUntil(
            async () =>
              (await pickerOptions(lp).catch(() => [])).some(
                (o) => o.disabled && o.text === LOCAL_ONLY_TEXT,
              ),
            15_000,
            'the disabled "local only" option',
          );
        await waitLocalOnlyOption();
        let opts = await pickerOptions(lp);
        assert.deepEqual(
          opts.map((o) => [o.value, o.text, o.disabled]),
          [
            ['__current', 'Local repository', false],
            ['', LOCAL_ONLY_TEXT, true],
          ],
          'LAN menu: only the current (default) repo and why nothing else is offered',
        );
        assert.ok(!opts.some((o) => o.value === '__add' || o.text === '+ Open another path…'));
        // 「開啟其他路徑…」是選單旁的 ＋ 按鈕：從區網打開的頁面上沒有它
        assert.equal(await addBtn(lp).count(), 0, 'LAN page: no ＋ "Open another path…" button');
        assert.equal(await lp.locator('.web-add').count(), 0, 'LAN page: no .web-add');
        assert.equal(await pathInput(lp).count(), 0, 'LAN page: no path box');
        await lp.screenshot({ path: resolve(artifacts, '12-lan-menu.png') });
        // 其他 repo 的深連結：說明原因（不是「不認得」），不顯示列表
        await lp.goto(`${lanOrigin}/?local=${ids.beta}`);
        const panel = lp.locator('.agg-center[role="alert"]');
        await panel.waitFor();
        const panelText = await panel.innerText();
        assert.ok(panelText.includes(LOCAL_ONLY_TEXT), `LAN deep link explains why: ${panelText}`);
        assert.ok(!/does not know/.test(panelText), 'not reported as an unknown repo');
        assert.equal(await lp.locator('.agg-scroll').count(), 0, 'no list');
        assert.equal(await lp.locator('.agg-commit').count(), 0, 'no beta rows');
        await waitLocalOnlyOption();
        opts = await pickerOptions(lp);
        // 清單永遠拿不到（local_only）：占位選項不能說「不在清單中」，只說是本機 repository
        assert.deepEqual(
          opts.map((o) => [o.value, o.text, o.disabled]),
          [
            ['__current', 'Local repository', false],
            ['', LOCAL_ONLY_TEXT, true],
          ],
        );
        assert.equal(await addBtn(lp).count(), 0, 'LAN deep link: no ＋ button either');
        assert.equal(await lp.locator('.web-add').count(), 0);
        await lp.screenshot({ path: resolve(artifacts, '12-lan-other-repo.png') });
        await lp.close();
      } finally {
        await lanCtx.close();
        await stopVite(lan);
      }
      await page.bringToFront();
    });

  await step(
    'LOCAL PICKER (fresh dev server, empty AGG_LOCAL_REPOS_FILE): ?local=<far-away id> says it does not know the repo; adding far-away’s absolute path with ＋ on that very page shows its graph right away (no stale error, no reload, same URL)',
    async () => {
      const p = await freePort();
      const origin = `http://localhost:${p}`;
      const file = stateFileOf('unknown-then-added');
      writeFileSync(file, '{ "paths": [] }\n');
      const side = startVite(['--port', String(p), '--strictPort'], {
        ...env,
        AGG_LOCAL_REPOS_FILE: file,
      });
      let pg;
      try {
        await side.ready;
        pg = await ctx.newPage();
        watchErrors(pg, 'unknown-then-added page');
        // 這台 dev server 不認得 far-away（不在掃描範圍、檔案是空的）
        await pg.goto(`${origin}/?local=${ids.far}`);
        const panel = pg.locator('.agg-center[role="alert"]');
        await panel.waitFor();
        assert.match(await panel.innerText(), /does not know this local repository/);
        assert.equal(await pg.locator('.agg-scroll').count(), 0, 'no list for an unknown repo');
        await waitPickerHas(ids.beta, pg);
        await waitPickerValue('__current', pg);
        assert.deepEqual(
          (await pickerOptions(pg)).map((o) => [o.value, o.selected]),
          [
            ['__current', true],
            ['default', false],
            [ids.beta, false],
            [ids.gamma, false],
          ],
          'the menu: the placeholder for the current repo, then the scanned repos',
        );
        assert.equal(
          (await pickerOptions(pg))[0].text,
          '(repository not in the list)',
          'the menu says the current repo is not in the list',
        );
        await pg.evaluate(() => (window.__alive = 'unknown far-away'));
        const historyBefore = await pg.evaluate(() => history.length);

        // 就在這個畫面上用 ＋ 加入 far-away 的絕對路徑（id 和網址裡的一樣）
        await addBtn(pg).click();
        await pathInput(pg).waitFor();
        await pathInput(pg).fill(fx.far);
        await pathInput(pg).press('Enter');
        await pathInput(pg).waitFor({ state: 'detached' });
        assert.equal(await pathError(pg).count(), 0, 'the path was accepted');
        await waitPickerValue(ids.far, pg);
        // 列表直接出現：不能還留著「不認得」的錯誤（同一個 id 也要重新向 dev server 要快照）
        await waitShowsRepo(
          fx.far,
          'far-away right after adding its path on the unknown-repo page',
          pg,
        ).catch(async (err) => {
          const stale = await pg
            .locator('.agg-center')
            .innerText()
            .catch(() => '');
          throw new Error(`${err.message}\n  the page still shows: ${stale || '(nothing)'}`);
        });
        await titleIs('far-away', pg);
        assert.equal(
          await pg.locator('.agg-center').count(),
          0,
          'the stale "does not know" error is gone',
        );
        assert.equal(searchOf(pg), `?local=${ids.far}`, 'the URL stays the same');
        assert.equal(
          await pg.evaluate(() => history.length),
          historyBefore,
          'no extra history entry (it is the repo already in the URL)',
        );
        assert.equal(
          await pg.evaluate(() => window.__alive),
          'unknown far-away',
          'the page did not reload',
        );
        await waitUntil(
          () => (readState(file)?.paths ?? []).length === 1,
          10_000,
          'the dev server remembers the added path',
        );
        assert.deepEqual(readState(file), { paths: [realpathSync(fx.far)] });
        await assertNoPathsInBrowser([fx.far], pg, 'after adding the path of an unknown repo');
        await replayDone(pg);
        await graphSync('far-away added on the unknown-repo page', { pg, minRows: 3 });
        await pg.screenshot({ path: resolve(artifacts, '12-unknown-then-added.png') });
      } finally {
        await pg?.close();
        await stopVite(side);
      }
      await page.bringToFront();
    },
  );

  await step(
    'other local repositories: no remote → no "Open on GitHub"; empty repo → empty state; not a git repo → error panel with the localised explanation',
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
          const alertText = await pg.locator('.agg-center[role="alert"]').innerText();
          assert.match(alertText, /not inside a git repository/);
          // 快照帶 code: 'not_git'：畫面顯示在地化的說明（en-US），不是 dev server 的英文原文
          assert.ok(
            alertText.includes('This folder is not inside a git repository.'),
            `the localised "not a git repo" text: ${alertText}`,
          );
          assert.ok(
            !alertText.includes('The configured directory'),
            `not the raw server message: ${alertText}`,
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
      // 靜態建置沒有 dev server：不能有任何 /__agg/ 請求（git 狀態 / 動作、更早的歷史都不存在）
      const aggRequests = [];
      p2.on('request', (r) => {
        if (new URL(r.url()).pathname.startsWith('/__agg/')) aggRequests.push(r.url());
      });
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
      // git 動作只屬於 dev server：沒有動作列、詳情面板裡沒有 Tag… / Worktree…；頁尾沒有「載入更早的歷史」
      assert.equal(await p2.locator('.web-git').count(), 0, 'no git actions bar in a build');
      await clickRow(rows[3].sha, {}, p2);
      await p2.locator('.agg-detail').waitFor();
      assert.equal(
        await p2.locator('.web-detail-btn').count(),
        0,
        'no Tag… / Worktree… in a build',
      );
      assert.equal(await p2.locator('.agg-footer').getAttribute('data-state'), 'end');
      assert.equal(await p2.locator('.agg-footer button').count(), 0, 'nothing to load in a build');
      assert.deepEqual(aggRequests, [], 'a build never calls the dev endpoints');
      await p2.close();
    },
  );

  // ═════════════════════════ infinite scroll / 詳情面板大小 ═════════════════════════
  // 以下的步驟各自用自己的 dev server、暫時 repo 與 browser context（localStorage / sessionStorage 分開），
  // 不改動上面步驟用的 repo、快照深度與設定。

  const newContext = async () => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    c.setDefaultTimeout(30_000 * SCALE);
    c.setDefaultNavigationTimeout(30_000 * SCALE);
    await c.route('https://github.com/**', (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: '<title>fake github</title>' }),
    );
    return c;
  };
  const xctx = await newContext();
  /** 這一頁也是失敗時的截圖對象 */
  const openPage = async (tag) => {
    const pg = await xctx.newPage();
    watchErrors(pg, tag);
    shotPage = pg;
    return pg;
  };
  // 前面步驟的主畫面用不到了：它的 WebGL 場景會一直跟下面的頁面搶 CPU（軟體 WebGL），先停在空白頁
  await page.goto('about:blank');
  // 側邊 dev server 的 repo 清單只掃描空資料夾（預設會掃描 repo 的上一層，也就是整個暫存目錄）
  const emptyRoots = resolve(stateDir, 'empty-roots');
  mkdirSync(emptyRoots);
  /** 另起一個 dev server（`pnpm start` 同一份設定，只換環境變數）；結束時由 finally 收掉。 */
  const startSide = async (name, extraEnv, args = []) => {
    const p = await freePort();
    const v = startVite([...args, '--port', String(p), '--strictPort'], {
      ...env,
      AGG_REPO_ROOTS: emptyRoots,
      AGG_LOCAL_REPOS_FILE: stateFileOf(name),
      ...extraEnv,
    });
    sideServers.add(v);
    await v.ready;
    return { v, port: p, origin: `http://localhost:${p}` };
  };
  const stopSide = async (v) => {
    await stopVite(v);
    sideServers.delete(v);
  };

  const rowShas = (pg) =>
    pg.evaluate(() => [...document.querySelectorAll('.agg-commit')].map((r) => r.dataset.sha));
  /** 列表最後一列（頁尾）：狀態、訊息（role=status 的 live region）、轉圈、按鈕。 */
  const footerOf = (pg) =>
    pg.evaluate(() => {
      const f = document.querySelector('.agg-footer');
      if (!f) return null;
      const msg = f.querySelector('.agg-footer-msg');
      return {
        state: f.dataset.state ?? null,
        text: msg?.textContent ?? '',
        role: msg?.getAttribute('role') ?? null,
        live: msg?.getAttribute('aria-live') ?? null,
        spinner: Boolean(f.querySelector('.agg-spinner')),
        button: f.querySelector('button')?.textContent ?? null,
        height: f.getBoundingClientRect().height,
      };
    });
  const waitFooter = async (pg, state, what) => {
    await waitUntil(
      async () => (await footerOf(pg))?.state === state,
      30_000,
      `${what}: footer data-state=${state}`,
    );
    return footerOf(pg);
  };
  /** 畫面最上面（完整看得到的第一列）是哪個 commit、離捲動區頂端多遠；用來證明「畫面沒有動」。 */
  const viewAnchor = (pg) =>
    pg.evaluate(() => {
      const sc = document.querySelector('.agg-scroll');
      const top = sc.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.agg-commit')].find(
        (r) => r.getBoundingClientRect().top >= top - 0.5,
      );
      return {
        scrollTop: sc.scrollTop,
        sha: row?.dataset.sha ?? null,
        offset: row ? row.getBoundingClientRect().top - top : NaN,
      };
    });
  /** 記下捲動容器的每一次 scrollTop（載入期間畫面若跳了一下又跳回來，只看前後兩點會漏掉） */
  const recordScrolls = (pg) =>
    pg.evaluate(() => {
      const sc = document.querySelector('.agg-scroll');
      window.__scrollStop?.();
      window.__scrollLog = [];
      const on = () => window.__scrollLog.push(sc.scrollTop);
      sc.addEventListener('scroll', on);
      window.__scrollStop = () => sc.removeEventListener('scroll', on);
    });
  const recordedScrolls = (pg) =>
    pg.evaluate(() => {
      window.__scrollStop?.();
      window.__scrollStop = null;
      return window.__scrollLog;
    });
  const commitChip = (pg) => pg.locator('.agg-chip--commits').first().innerText();
  const tagScrollerOf = (pg) =>
    pg.evaluate(() => {
      document.querySelector('.agg-scroll').__tag = 'same-element';
    });
  const scrollerTagOf = (pg) =>
    pg.evaluate(() => document.querySelector('.agg-scroll')?.__tag ?? null);
  /** 欄位對齊（看得到的欄位）：標題列與第一列的同名欄位同 left / width。 */
  const columnsAlignOn = async (pg, label) => {
    const m = await pg.evaluate(() => {
      const row = document.querySelector('.agg-commit');
      const head = document.querySelector('.agg-colhead');
      return ['agg-c-author', 'agg-c-date', 'agg-c-sha'].flatMap((c) => {
        const a = row.querySelector(`.${c}`).getBoundingClientRect();
        const b = head.querySelector(`.${c}`).getBoundingClientRect();
        if (a.width === 0 && b.width === 0) return [];
        return [{ c, dl: Math.abs(a.left - b.left), dw: Math.abs(a.width - b.width) }];
      });
    });
    assert.ok(m.length >= 1, `${label}: no visible columns`);
    for (const x of m)
      assert.ok(
        x.dl <= 1 && x.dw <= 1,
        `${label}: column ${x.c} drifts from its header (Δleft ${x.dl}, Δwidth ${x.dw})`,
      );
  };

  let deepOrigin;
  let deepServer;
  await step(
    'INFINITE SCROLL (local; its own dev server on a 705-commit repo, AGG_MAX_COMMITS=100): nothing loads until you scroll; at the bottom the footer spins and the next 300 come from the dev server (?depth=400 → 700 → 1000), appended below without moving the view, losing the selection, recreating the scroller or replaying, the graph in sync — until "the first commit lives here"; a failed batch says so with Try again and never retries by itself; a live commit afterwards keeps the loaded history',
    async () => {
      deepDir = makeDeepRepo();
      const all = gitLog(deepDir).map((c) => c.sha);
      assert.equal(all.length, 705, 'sanity: the long repo');
      const side = await startSide('deep', { AGG_REPO_DIR: deepDir, AGG_MAX_COMMITS: '100' });
      deepOrigin = side.origin;
      deepServer = side.v;
      const pg = await openPage('deep page');
      try {
        // 這一頁向 dev server 要更深的快照（?depth=）的請求
        const depths = [];
        pg.on('request', (r) => {
          const u = new URL(r.url());
          if (u.pathname === '/__agg/git-snapshot' && u.searchParams.has('depth'))
            depths.push(Number(u.searchParams.get('depth')));
        });
        // 攔住要更深快照的請求：在「這一批一定還沒回來」的狀態下量畫面（不靠時間差）；也可以讓下一批失敗（連線中斷）
        let hold = false;
        let failNext = false;
        const held = [];
        await pg.route(
          (u) => u.pathname === '/__agg/git-snapshot' && u.searchParams.has('depth'),
          async (route) => {
            if (failNext) {
              failNext = false;
              return route.abort('failed');
            }
            if (hold) await new Promise((ok) => held.push(ok));
            await route.continue().catch(() => {});
          },
        );
        const release = () => {
          hold = false;
          for (const ok of held.splice(0)) ok();
        };

        await pg.goto(side.origin);
        await titleIs(dirBase(deepDir), pg);
        await waitUntil(async () => (await rowShas(pg)).length === 100, 25_000, 'the first 100');
        assert.deepEqual(await rowShas(pg), all.slice(0, 100), 'the newest 100, newest first');
        assert.match(await commitChip(pg), /^100 commits$/);
        await replayDone(pg);
        let f = await footerOf(pg);
        assert.equal(f.state, 'idle', 'more history exists: the footer waits for the scroll');
        assert.equal(f.button, 'Load older history', 'a keyboard / manual fallback');
        assert.equal(f.role, 'status');
        await sleep(1000);
        assert.deepEqual(depths, [], 'nothing more is loaded before scrolling down');
        const v01 = git(deepDir, 'rev-parse', 'v0.1');
        assert.ok(!(await rowShas(pg)).includes(v01), 'sanity: the old tag is not loaded yet');

        // 選一列（詳情面板打開）；之後每一批都不能把選取弄丟、不能重播、不能換掉捲動容器
        const picked = all[5];
        await clickRow(picked, {}, pg);
        await waitSelected(picked, 'deep: select a row', pg);
        await settleScroll(pg);
        await watchReplay(pg);
        await tagScrollerOf(pg);

        /** 觸發下一批（預設：捲到底）→ 頁尾轉圈（請求被攔住）→ 量畫面 → 放行 → 列數變成 `want`，畫面沒有動 */
        const batch = async (want, label, trigger) => {
          hold = true;
          if (trigger) await trigger();
          else await scrollTo(await scrollMax(pg), pg);
          await waitUntil(
            () => held.length > 0,
            20_000,
            `${label}: the request for the next batch`,
          );
          f = await footerOf(pg);
          assert.equal(f.state, 'loading', `${label}: the footer while loading`);
          assert.equal(f.text, 'Loading older history…', `${label}: the loading text`);
          assert.ok(f.spinner, `${label}: a spinner`);
          assert.deepEqual([f.role, f.live], ['status', 'polite'], `${label}: announced politely`);
          await settleScroll(pg);
          const before = await viewAnchor(pg);
          await recordScrolls(pg);
          release();
          await waitUntil(
            async () => (await rowShas(pg)).length === want,
            30_000,
            `${label}: ${want} rows`,
          );
          await waitUntil(
            async () => (await footerOf(pg)).state !== 'loading',
            10_000,
            `${label}: loaded`,
          );
          await sleep(300);
          const after = await viewAnchor(pg);
          const jumps = (await recordedScrolls(pg)).filter(
            (t) => Math.abs(t - before.scrollTop) > 1,
          );
          assert.deepEqual(jumps, [], `${label}: scrollTop never moved while the batch came in`);
          assert.equal(after.sha, before.sha, `${label}: the commit at the top of the view`);
          assert.ok(
            Math.abs(after.offset - before.offset) <= 1 &&
              Math.abs(after.scrollTop - before.scrollTop) <= 1,
            `${label}: the view must not move (offset ${before.offset} → ${after.offset}, scrollTop ${before.scrollTop} → ${after.scrollTop})`,
          );
          assert.deepEqual(
            await rowShas(pg),
            all.slice(0, want),
            `${label}: older commits are appended below, in git order`,
          );
          assert.deepEqual(await replayLog(pg), ['done'], `${label}: the scene does not replay`);
          assert.equal(await scrollerTagOf(pg), 'same-element', `${label}: same scroller`);
          assert.equal(await selectedSha(pg), picked, `${label}: the selection survives`);
          assert.equal(await pg.locator('.agg-detail').count(), 1, `${label}: detail still open`);
          assert.match(await commitChip(pg), new RegExp(`^${want} commits$`));
        };

        // ── 第 1 批：捲到底 → 100 → 400 ──
        await batch(400, 'batch 1');
        f = await footerOf(pg);
        assert.equal(f.state, 'idle');
        assert.equal(f.text, 'Loaded 300 older commits', 'the footer says what came in');
        // 接縫（第 100 列附近）與新的一批中間：線圖跟列表對齊
        await graphSync('deep: around the seam of batch 1', { pg });
        await pg.screenshot({ path: resolve(artifacts, '14-deep-batch1.png') });
        const rowH = Number(await pg.locator('.agg-canvas').getAttribute('data-row-h'));
        await scrollTo(Math.round(250 * rowH), pg);
        await graphSync('deep: the middle of batch 1', { pg });

        // ── 第 2 批：連線失敗 → 錯誤 + 再試一次（不會自己重試）→ 再試一次 → 700 ──
        failNext = true;
        await scrollTo(await scrollMax(pg), pg);
        f = await waitFooter(pg, 'error', 'a failed batch');
        assert.equal(
          f.text,
          'Could not load older history · Could not load older history (the dev server did not respond).',
        );
        assert.equal(f.button, 'Try again');
        assert.equal(f.role, 'status', 'the failure is announced');
        assert.equal(f.spinner, false);
        const tries = depths.length;
        assert.deepEqual(depths, [400, 700], 'the failed request asked for 700');
        await sleep(1500);
        await scrollTo((await scrollMax(pg)) - 3000, pg);
        await scrollTo(await scrollMax(pg), pg);
        await sleep(1500);
        assert.equal(depths.length, tries, 'no automatic retry (not even when scrolling again)');
        assert.equal((await rowShas(pg)).length, 400, 'a failed batch changes nothing');
        assert.equal((await footerOf(pg)).state, 'error', 'the error stays until Try again');
        // Try again 用鍵盤（Enter）：按鈕在載入中消失，焦點回到列表（不會掉到 body）
        const retry = pg.locator('.agg-footer').getByRole('button', { name: 'Try again' });
        await batch(700, 'batch 2 (Try again)', async () => {
          await retry.focus();
          await pg.keyboard.press('Enter');
        });
        await waitUntil(
          () =>
            pg.evaluate(() => document.activeElement?.classList.contains('agg-scroll') ?? false),
          5000,
          'keyboard focus back on the list after Try again',
        );
        await graphSync('deep: around the seam of batch 2', { pg });

        // ── 第 3 批：剩下的 5 個 → 歷史的起點 ──
        await batch(705, 'batch 3');
        f = await footerOf(pg);
        assert.equal(f.state, 'end');
        assert.equal(f.text, 'the first commit lives here', 'the root commit is loaded');
        assert.equal(f.button, null, 'nothing left to load');
        assert.equal(f.spinner, false);
        assert.deepEqual(await rowShas(pg), all, 'every commit, in git order');
        const oldTag = (await domRows(pg)).find((r) => r.sha === v01);
        assert.ok(
          oldTag?.refs.some((r) => r.name === 'v0.1' && /agg-ref--tag/.test(r.cls)),
          'the old tag shows up once its commit is loaded',
        );
        assert.deepEqual(depths, [400, 700, 700, 1000], 'one request per batch (+ the retry)');
        await sleep(1500);
        assert.equal(depths.length, 4, 'no more requests at the start of history');
        await scrollTo(await scrollMax(pg), pg);
        await graphSync('deep: the very first commit', { pg });
        await pg.screenshot({ path: resolve(artifacts, '14-deep-end.png') });

        // ── 載完之後來一個新 commit：即時更新帶著同樣的深度（不會縮回第一批的 100 個）──
        commit(deepDir, 'feat: live after paging');
        const fresh = git(deepDir, 'rev-parse', 'HEAD');
        await waitUntil(
          async () => (await rowShas(pg))[0] === fresh,
          20_000,
          'the live commit on top',
        );
        assert.equal((await rowShas(pg)).length, 706, 'the loaded history is kept');
        assert.equal((await footerOf(pg)).state, 'end');
        assert.equal(await selectedSha(pg), picked, 'the selection survives the live update');
      } finally {
        await pg.close();
      }
    },
  );

  await step(
    'DETAIL SIZE: a toggle next to prev / next / close widens the docked panel to clamp(380px, 50%, 720px) and back (aria-pressed, label, title); the list and graph re-lay out (no horizontal overflow, aligned columns, selected row visible, no replay); Esc still closes the panel in one step; the choice is remembered across reloads; medium widens the drawer, the narrow bottom sheet has no toggle',
    async () => {
      const pg = await openPage('detail size page');
      try {
        await pg.goto(deepOrigin);
        await titleIs(dirBase(deepDir), pg);
        await pg.locator('.agg-commit').first().waitFor();
        await replayDone(pg);
        const shas = await rowShas(pg);
        const panel = () =>
          pg.evaluate(() => {
            const root = document.querySelector('.agg-root');
            const d = document.querySelector('.agg-detail');
            const b = d?.querySelector('.agg-detail-size');
            const r = d?.getBoundingClientRect();
            const m = document.querySelector('.agg-main').getBoundingClientRect();
            return {
              size: root.dataset.size,
              detailSize: root.dataset.detailSize,
              cssW: root.style.getPropertyValue('--agg-detail-w'),
              rootW: root.getBoundingClientRect().width,
              open: Boolean(d),
              position: d ? getComputedStyle(d).position : null,
              left: r?.left ?? NaN,
              right: r?.right ?? NaN,
              width: r?.width ?? NaN,
              mainRight: m.right,
              nav: d
                ? [...d.querySelectorAll('.agg-detail-nav button')].map((x) =>
                    x.getAttribute('aria-label'),
                  )
                : [],
              button: b
                ? {
                    pressed: b.getAttribute('aria-pressed'),
                    label: b.getAttribute('aria-label'),
                    title: b.title,
                  }
                : null,
              stored: localStorage.getItem('agg.detail-size'),
            };
          });
        const wideW = (rootW) => Math.round(Math.min(720, Math.max(380, rootW * 0.5)));
        const toggle = () => pg.locator('.agg-detail .agg-detail-size');
        const sizeTo = async (w, h, size) => {
          await pg.setViewportSize({ width: w, height: h });
          await pg.locator(`.agg-root[data-size="${size}"]`).waitFor();
          await settleScroll(pg);
        };
        const select = async (sha) => {
          await clickRow(sha, {}, pg);
          await waitSelected(sha, 'detail size: select', pg);
          await pg.locator('.agg-detail').waitFor();
          await sleep(250);
        };

        // ── wide（1440）：預設 normal = 380px，按鈕在 上一個 / 下一個 與 關閉 之間 ──
        await select(shas[4]);
        let s = await panel();
        assert.deepEqual(s.nav, [
          'Previous (newer)',
          'Next (older)',
          'Widen the details panel',
          'Close details',
        ]);
        assert.deepEqual(s.button, {
          pressed: 'false',
          label: 'Widen the details panel',
          title: 'Widen the details panel',
        });
        assert.equal(s.size, 'wide');
        assert.equal(s.detailSize, 'normal');
        assert.equal(s.cssW, '380px');
        assert.ok(Math.abs(s.width - 380) <= 1, `normal docked width ${s.width}`);
        assert.ok(s.mainRight <= s.left + 0.5, 'list and panel side by side');
        assert.equal(s.stored, null, 'nothing stored until the user picks a size');
        assert.deepEqual(await noOverflow(pg), []);
        const normalList = (await rectOf('.agg-main', pg)).width;

        // ── 加寬：clamp(380, 50%, 720)；列表與線圖重新排版，不重播 ──
        await watchReplay(pg);
        await toggle().click();
        await waitUntil(
          async () => (await panel()).detailSize === 'wide',
          5000,
          'data-detail-size=wide',
        );
        await sleep(300);
        s = await panel();
        const want = wideW(s.rootW);
        assert.ok(want > 380, `sanity: the wide width (${want}) is wider at 1440px`);
        assert.deepEqual(s.button, {
          pressed: 'true',
          label: 'Restore the details panel width',
          title: 'Restore the details panel width',
        });
        assert.equal(s.cssW, `${want}px`, '--agg-detail-w');
        assert.ok(Math.abs(s.width - want) <= 1, `wide docked width ${s.width} ≠ ${want}`);
        assert.ok(s.mainRight <= s.left + 0.5, 'still side by side, no overlap');
        assert.ok(
          (await rectOf('.agg-main', pg)).width < normalList - (want - 380) + 2,
          'the list gave the room to the panel',
        );
        assert.equal(s.stored, 'wide', 'remembered in this browser');
        assert.deepEqual(await noOverflow(pg), [], 'wide panel: no horizontal overflow');
        await columnsAlignOn(pg, 'wide panel');
        await waitRowVisible(shas[4], 'the selected row next to the wide panel', pg);
        await graphSync('wide detail panel', { pg });
        assert.deepEqual(await replayLog(pg), ['done'], 'resizing the panel does not replay');
        await pg.screenshot({ path: resolve(artifacts, '15-detail-wide.png') });

        // Esc 一次就關掉面板（焦點在剛按的按鈕上）
        assert.equal(
          await pg.evaluate(() => document.activeElement?.classList.contains('agg-detail-size')),
          true,
        );
        await pg.keyboard.press('Escape');
        await waitUntil(async () => (await selectedSha(pg)) === null, 5000, 'Esc closes the panel');
        assert.equal(await pg.locator('.agg-detail').count(), 0);
        assert.deepEqual(await noOverflow(pg), []);

        // ── 重新載入：還是 wide ──
        await pg.reload();
        await titleIs(dirBase(deepDir), pg);
        await pg.locator('.agg-commit').first().waitFor();
        await select(shas[2]);
        s = await panel();
        assert.equal(s.detailSize, 'wide', 'the size survives a reload');
        assert.equal(s.button.pressed, 'true');
        assert.ok(Math.abs(s.width - wideW(s.rootW)) <= 1, `wide after reload (${s.width})`);
        assert.deepEqual(await noOverflow(pg), []);

        // ── medium（820）：浮動抽屜跟著變寬，列表版面不變 ──
        await sizeTo(820, 900, 'medium');
        s = await panel();
        assert.equal(s.position, 'absolute', 'medium: a drawer');
        assert.ok(s.button, 'medium: the toggle is there (it widens the drawer)');
        assert.ok(s.width > 400.5, `medium + wide: a wider drawer (${s.width})`);
        assert.ok(s.left >= 0 && s.right <= 820 + 0.5, `drawer on screen ${s.left}–${s.right}`);
        assert.deepEqual(await noOverflow(pg), []);
        const listMid = (await rectOf('.agg-main', pg)).width;
        await toggle().click();
        await waitUntil(async () => (await panel()).detailSize === 'normal', 5000, 'medium normal');
        await sleep(200);
        s = await panel();
        assert.ok(s.width <= 400.5, `medium + normal: the usual drawer (${s.width})`);
        assert.equal(s.button.pressed, 'false');
        assert.equal(
          (await rectOf('.agg-main', pg)).width,
          listMid,
          'the drawer floats: the list keeps its layout',
        );
        await toggle().click();
        await waitUntil(async () => (await panel()).detailSize === 'wide', 5000, 'medium wide');
        await graphSync('medium + wide drawer', { pg, minRows: 4 });

        // ── narrow（390）：底部面板本來就是全寬，沒有切換按鈕 ──
        await sizeTo(390, 844, 'narrow');
        s = await panel();
        assert.equal(s.button, null, 'narrow: no size toggle on the bottom sheet');
        assert.deepEqual(s.nav, ['Previous (newer)', 'Next (older)', 'Close details']);
        assert.ok(s.left >= 0 && s.right <= 390.5, `the sheet fits (${s.left}–${s.right})`);
        assert.deepEqual(await noOverflow(pg), [], 'narrow + wide setting: no overflow');
        await pg.screenshot({ path: resolve(artifacts, '15-detail-narrow.png') });

        // ── 回到 wide：還原成 normal（也記住）──
        await sizeTo(1440, 900, 'wide');
        s = await panel();
        assert.equal(s.detailSize, 'wide');
        await toggle().click();
        await waitUntil(
          async () => (await panel()).detailSize === 'normal',
          5000,
          'back to normal',
        );
        await sleep(300);
        s = await panel();
        assert.ok(Math.abs(s.width - 380) <= 1, `normal again (${s.width})`);
        assert.equal(s.cssW, '380px');
        assert.equal(s.stored, 'normal');
        assert.deepEqual(await noOverflow(pg), []);
        await columnsAlignOn(pg, 'normal panel again');
        await graphSync('normal detail panel again', { pg });
      } finally {
        await pg.close();
      }
      await stopSide(deepServer);
    },
  );

  await step(
    'INFINITE SCROLL (GitHub source, mock API): demo/long-history shows one page per branch; scrolling to the bottom fetches /commits?sha=<missing parent> and appends the older commits without moving the view or replaying, the graph in sync; a failed request says so with Try again (no automatic retry); it ends at the first commit with every commit newest first and the old tag on its commit',
    async () => {
      // 與 graph-core 相同的取法：每條 branch 從 tip 往回一頁（60 筆，時間倒序）；缺的 parent 再往回抓一頁
      const byId = new Map(
        LONG.specs.map(([id, parents, , , hours]) => [id, { id, parents, hours }]),
      );
      const back = (id) => {
        const seenIds = new Set();
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop();
          if (seenIds.has(cur)) continue;
          seenIds.add(cur);
          stack.push(...byId.get(cur).parents);
        }
        return [...seenIds].sort((a, b) => byId.get(b).hours - byId.get(a).hours);
      };
      const first = new Set(Object.values(LONG.heads).flatMap((h) => back(h).slice(0, 60)));
      const missing = (have) => [
        ...new Set([...have].flatMap((id) => byId.get(id).parents).filter((p) => !have.has(p))),
      ];
      assert.deepEqual(missing(first), ['L88'], 'sanity: the first batch stops at L88');
      const second = new Set([...first, ...back('L88').slice(0, 60)]);
      assert.deepEqual(missing(second), ['L31'], 'sanity: the second batch stops at L31');
      const shaToId = new Map(LONG.specs.map(([id]) => [mockSha(id), id]));
      const moreCalls = () =>
        seen.paths.filter((p) => /^\/repos\/demo\/long-history\/commits\?sha=[0-9a-f]{40}/.test(p));
      const idsOnScreen = async (pg) => (await rowShas(pg)).map((s) => shaToId.get(s));
      const newestFirst = async (pg) => {
        const t = (await domRows(pg)).map((r) => Date.parse(r.datetime));
        return t.every((x, i) => i === 0 || t[i - 1] >= x);
      };

      const pg = await openPage('GitHub paging page');
      try {
        await pg.goto(`${base}/?repo=demo/long-history`);
        await titleIs('demo/long-history', pg);
        await waitUntil(
          async () => (await rowShas(pg)).length === first.size,
          25_000,
          `the first batch (${first.size})`,
        );
        assert.ok(sameSet(await idsOnScreen(pg), [...first]), 'one page per branch');
        assert.ok(await newestFirst(pg), 'newest first');
        await replayDone(pg);
        let f = await footerOf(pg);
        assert.equal(f.state, 'idle', 'GitHub: older history exists');
        await sleep(800);
        assert.deepEqual(moreCalls(), [], 'nothing more is fetched before scrolling');
        await watchReplay(pg);
        await tagScrollerOf(pg);

        // ── 第 1 批：mock 先攔住 sha= 的請求（這一批一定還沒回來時量畫面）──
        gate.hold = true;
        await scrollTo(await scrollMax(pg), pg);
        await waitUntil(() => gate.queue.length > 0, 20_000, 'the request from the missing parent');
        f = await footerOf(pg);
        assert.equal(f.state, 'loading');
        assert.equal(f.text, 'Loading older history…');
        await settleScroll(pg);
        const before = await viewAnchor(pg);
        await recordScrolls(pg);
        releaseHeld();
        await waitUntil(
          async () => (await rowShas(pg)).length === second.size,
          30_000,
          `the second batch (${second.size})`,
        );
        await waitUntil(async () => (await footerOf(pg)).state === 'idle', 10_000, 'idle again');
        await sleep(300);
        const after = await viewAnchor(pg);
        const jumps = (await recordedScrolls(pg)).filter((t) => Math.abs(t - before.scrollTop) > 1);
        assert.deepEqual(jumps, [], 'GitHub: scrollTop never moved while the batch came in');
        assert.equal(after.sha, before.sha, 'GitHub: the commit at the top of the view');
        assert.ok(
          Math.abs(after.offset - before.offset) <= 1 &&
            Math.abs(after.scrollTop - before.scrollTop) <= 1,
          `GitHub: the view must not move (${JSON.stringify({ before, after })})`,
        );
        assert.deepEqual(
          moreCalls(),
          [`/repos/demo/long-history/commits?sha=${mockSha('L88')}&per_page=60`],
          'one page back from the only missing parent',
        );
        assert.ok(sameSet(await idsOnScreen(pg), [...second]));
        assert.ok(await newestFirst(pg), 'still newest first');
        assert.deepEqual(await replayLog(pg), ['done'], 'GitHub: no replay');
        assert.equal(await scrollerTagOf(pg), 'same-element');
        await graphSync('GitHub: around the seam', { pg });

        // ── 第 2 批：502 → 錯誤 + 再試一次（不會自己重試）→ 再試一次 → 全部 ──
        faults.more = 1;
        await scrollTo(await scrollMax(pg), pg);
        f = await waitFooter(pg, 'error', 'GitHub: a failed batch');
        assert.equal(f.text, 'Could not load older history · Unknown error.');
        assert.equal(f.button, 'Try again');
        const calls = moreCalls().length;
        await sleep(1500);
        await scrollTo((await scrollMax(pg)) - 1500, pg);
        await scrollTo(await scrollMax(pg), pg);
        await sleep(1500);
        assert.equal(moreCalls().length, calls, 'GitHub: no automatic retry');
        assert.equal((await rowShas(pg)).length, second.size, 'a failed batch changes nothing');
        await pg.locator('.agg-footer').getByRole('button', { name: 'Try again' }).click();
        await waitFooter(pg, 'end', 'GitHub: the start of history');
        f = await footerOf(pg);
        assert.equal(f.text, 'the first commit lives here');
        assert.equal(f.button, null);
        assert.equal((await rowShas(pg)).length, LONG.total, 'every commit of demo/long-history');
        assert.ok(
          sameSet(
            await idsOnScreen(pg),
            LONG.specs.map(([id]) => id),
          ),
        );
        assert.ok(await newestFirst(pg), 'newest first to the end');
        assert.deepEqual(
          moreCalls().slice(-2),
          Array(2).fill(`/repos/demo/long-history/commits?sha=${mockSha('L31')}&per_page=60`),
          'the failed request and Try again both start from L31',
        );
        const l40 = (await domRows(pg)).find((r) => r.sha === mockSha('L40'));
        assert.ok(
          l40?.refs.some((r) => r.name === 'v1.0' && /agg-ref--tag/.test(r.cls)),
          'tag v1.0 appears on its (old) commit',
        );
        assert.deepEqual(await replayLog(pg), ['done'], 'GitHub: no replay after Try again');
        const total = moreCalls().length;
        await sleep(1500);
        assert.equal(moreCalls().length, total, 'nothing more to fetch');
        await scrollTo(await scrollMax(pg), pg);
        await graphSync('GitHub: the first commit', { pg });
      } finally {
        gate.hold = false;
        faults.more = 0;
        releaseHeld();
        await pg.close();
      }
    },
  );

  // ═════════════════════════ git 動作（本機 repo、dev server） ═════════════════════════
  // 專用的 dev server 與一組暫時 repo（makeGitFixture）：work 是 origin.git 的 clone，mate 是另一個 clone（隊友）。
  // 每個動作都從畫面上操作，結果以 git 本身為準（rev-parse / for-each-ref / stash list / worktree list）。

  const BAR_NOTICE = '.web-git-notice--bar';
  const DIALOG_NOTICE = '.web-git-dialog .web-git-notice';
  const gitBtn = (pg, a) => pg.locator(`.web-git-btn[data-action="${a}"]`);
  /** 動作列：branch、↑↓、變更數、給螢幕報讀器的完整說明，以及每個按鈕的狀態（不能用的原因 = aria-describedby 的文字）。 */
  const barOf = (pg) =>
    pg.evaluate(() => {
      const bar = document.querySelector('.web-git');
      if (!bar) return null;
      const btns = {};
      for (const b of bar.querySelectorAll('.web-git-btn')) {
        const why = b.getAttribute('aria-describedby');
        btns[b.dataset.action] = {
          label: b.getAttribute('aria-label'),
          disabled: b.getAttribute('aria-disabled') === 'true',
          busy: b.getAttribute('aria-busy') === 'true',
          title: b.title,
          why: why ? (document.getElementById(why)?.textContent ?? null) : null,
          badge: b.querySelector('.web-git-badge')?.textContent ?? null,
        };
      }
      return {
        order: [...bar.querySelectorAll('.web-git-btn')].map((b) => b.dataset.action),
        branch: bar.querySelector('.web-git-branch')?.textContent ?? null,
        sync: bar.querySelector('.web-git-sync')?.textContent ?? '',
        dirty: bar.querySelector('.web-git-dirty')?.textContent ?? '',
        op: bar.querySelector('.web-git-op')?.textContent ?? null,
        sr: bar.querySelector('.web-git-status .web-sr')?.textContent ?? '',
        btns,
      };
    });
  const waitBar = async (pg, pred, what) => {
    await waitUntil(
      async () => {
        const b = await barOf(pg);
        return Boolean(b && pred(b));
      },
      20_000,
      what,
    ).catch(() => {});
    const b = await barOf(pg);
    assert.ok(b && pred(b), `${what}: ${JSON.stringify(b)}`);
    return b;
  };
  /** 使用者回到瀏覽器視窗（focus）：畫面重新讀 git 狀態（在編輯器 / 終端機改了東西之後） */
  const backToWindow = (pg) => pg.evaluate(() => window.dispatchEvent(new Event('focus')));
  const noticeOf = (pg, sel) =>
    pg.evaluate((s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      return {
        tone: n.dataset.tone ?? null,
        progress: n.hasAttribute('data-progress'),
        status: n.querySelector('[role="status"]')?.textContent ?? '',
        alert: n.querySelector('[role="alert"]')?.textContent ?? '',
        output: n.querySelector('.web-git-output pre')?.textContent ?? '',
      };
    }, sel);
  /**
   * 等動作的結果（不是進度）：語氣與文字都要對；逾時就以實際的訊息判定失敗。
   * 成功 / 沒事可做唸在 role=status（polite），失敗唸在 role=alert；另一個 live region 是空的。
   */
  const expectNotice = async (pg, sel, tone, text, what) => {
    const said = (n) => (tone === 'error' ? n.alert : n.status);
    const matches = (n) => Boolean(n && !n.progress && n.tone === tone && said(n) === text);
    await waitUntil(async () => matches(await noticeOf(pg, sel)), 30_000, what).catch(() => {});
    const n = await noticeOf(pg, sel);
    assert.ok(matches(n), `${what}: expected ${tone} “${text}”, got ${JSON.stringify(n)}`);
    assert.equal(tone === 'error' ? n.status : n.alert, '', `${what}: only one live region speaks`);
    return n;
  };
  /** 這一頁送出的 git 動作（POST /__agg/git 的 body） */
  const recordActions = (pg) => {
    const list = [];
    pg.on('request', (r) => {
      if (r.method() !== 'POST' || new URL(r.url()).pathname !== '/__agg/git') return;
      try {
        list.push(JSON.parse(r.postData() ?? 'null'));
      } catch {
        list.push({ unparsable: r.postData() }); // 安全性步驟故意送的壞 body
      }
    });
    return list;
  };
  const dialogNamed = (pg, name) => pg.getByRole('dialog', { name, exact: true });
  const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');
  const writeIn = (dir, file, text) => writeFileSync(resolve(dir, file), text);
  const commitFile = (dir, file, text, msg, author = 'Amy') => {
    writeIn(dir, file, text);
    git(dir, 'add', file);
    commit(dir, msg, author);
    return headOf(dir);
  };
  const activeText = (pg) => pg.evaluate(() => document.activeElement?.textContent ?? null);
  const stashCount = () => gitWork('stash', 'list').split('\n').filter(Boolean).length;
  // dev server 執行的 git（stash、tag -a、push）不能受開發者自己的 ~/.gitconfig 影響（簽章、hooksPath、alias…）
  const hermeticGit = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...identity('Amy'),
  };

  let gitSide;
  let gpg;
  let gitActions;
  const gitWork = (...args) => git(gfx.work, ...args);

  await step(
    'GIT ACTIONS (its own dev server on a clone of a local bare remote, plus a teammate’s clone): a bar in the source row shows the branch, ↑ahead ↓behind its upstream and the change count (the status endpoint = git); Fetch / Pull / Push / Stash / Tag / Worktree are labelled buttons and the unavailable ones say why; on phones they become icons without overflowing',
    async () => {
      gfx = makeGitFixture();
      gitSide = await startSide('git', {
        AGG_REPO_DIR: gfx.work,
        AGG_REPO_ROOTS: gfx.roots,
        ...hermeticGit,
      });
      gpg = await openPage('git page');
      gitActions = recordActions(gpg);
      await gpg.goto(gitSide.origin);
      await titleIs('work', gpg);
      await waitShowsRepo(gfx.work, 'the work clone', gpg);
      await gpg.locator('.web-bar .web-git').waitFor();

      const head = headOf(gfx.work);
      const status = await gpg.evaluate(async () => {
        const res = await fetch('/__agg/status?repo=default', { cache: 'no-store' });
        return { code: res.status, body: await res.json() };
      });
      assert.equal(status.code, 200);
      assert.deepEqual(status.body, {
        branch: 'main',
        head,
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        remotes: ['backup', 'origin'],
        stashes: [],
        worktrees: [
          {
            id: 'default',
            label: repoLabelOf(gfx.work),
            branch: 'main',
            head,
            current: true,
            main: true,
            locked: false,
            prunable: false,
          },
        ],
        operation: null,
        bare: false,
      });

      let b = await waitBar(gpg, (x) => x.branch === 'main', 'the bar shows main');
      assert.deepEqual(b.order, ['fetch', 'pull', 'push', 'stash', 'tag', 'worktree']);
      assert.deepEqual(
        Object.values(b.btns).map((x) => x.label),
        ['Fetch', 'Pull', 'Push', 'Stash', 'Tag', 'Worktree'],
      );
      for (const a of ['fetch', 'pull', 'stash', 'tag', 'worktree'])
        assert.equal(b.btns[a].disabled, false, `${a} is available`);
      assert.deepEqual(
        [b.btns.push.disabled, b.btns.push.title, b.btns.push.why],
        [true, 'Nothing to push', 'Nothing to push'],
        'in sync with the upstream: Push says why it is unavailable',
      );
      assert.deepEqual([b.sync, b.dirty, b.op], ['', '', null]);
      assert.equal(b.sr, '0 ahead of and 0 behind origin/main; No uncommitted changes');
      await gitBtn(gpg, 'push').click({ force: true }); // aria-disabled：Playwright 預設不點
      await sleep(400);
      assert.equal(
        await gpg.locator('.web-git-dialog').count(),
        0,
        'a disabled button does nothing',
      );

      // 在編輯器改檔案（staged / unstaged / untracked 各一）→ 回到瀏覽器時重新讀狀態
      writeIn(gfx.work, 'notes.txt', 'edited in an editor\n');
      writeIn(gfx.work, 'staged.txt', 'staged\n');
      gitWork('add', 'staged.txt');
      writeIn(gfx.work, 'scratch.txt', 'untracked\n');
      await backToWindow(gpg);
      b = await waitBar(gpg, (x) => x.dirty === '●3', 'three changed files');
      assert.equal(
        b.sr,
        '0 ahead of and 0 behind origin/main; 3 changed files (1 staged, 1 unstaged, 1 untracked)',
      );
      gitWork('reset', '-q', '--hard');
      rmSync(resolve(gfx.work, 'scratch.txt'));
      await backToWindow(gpg);
      await waitBar(gpg, (x) => x.dirty === '', 'clean again');
      await gpg.screenshot({ path: resolve(artifacts, '16-git-bar-1440.png') });

      // 手機寬度：按鈕只留圖示（名稱在 aria-label / title），不會橫向溢位
      for (const [w, h] of [
        [390, 844],
        [320, 640],
      ]) {
        await gpg.setViewportSize({ width: w, height: h });
        await gpg.locator('.agg-root[data-size="narrow"]').waitFor();
        await sleep(300);
        const lay = await gpg.evaluate(() =>
          [...document.querySelectorAll('.web-git-btn, .web-git-status')].map((el) => {
            const r = el.getBoundingClientRect();
            const label = el.querySelector('.web-git-label');
            return {
              what: el.dataset.action ?? 'status',
              left: r.left,
              right: r.right,
              w: r.width,
              h: r.height,
              label: label ? getComputedStyle(label).display !== 'none' : null,
            };
          }),
        );
        for (const x of lay) {
          assert.ok(
            x.left >= -0.5 && x.right <= w + 0.5,
            `${w}px: ${x.what} spans ${x.left}–${x.right}`,
          );
          if (x.what === 'status') continue;
          assert.equal(x.label, false, `${w}px: ${x.what} is icon-only`);
          assert.ok(x.w >= 24 && x.h >= 24, `${w}px: ${x.what} is still a target (${x.w}×${x.h})`);
        }
        assert.deepEqual(await noOverflow(gpg), [], `${w}px with the git bar`);
        await gpg.screenshot({ path: resolve(artifacts, `16-git-bar-${w}.png`) });
      }
      await gpg.setViewportSize({ width: 1440, height: 900 });
      await gpg.locator('.agg-root[data-size="wide"]').waitFor();
      assert.ok(await gitBtn(gpg, 'fetch').locator('.web-git-label').isVisible(), 'wide: labels');
      assert.deepEqual(gitActions, [], 'looking around sends no git action');
    },
  );

  await step(
    'GIT ACTIONS: Fetch brings in what the teammate pushed (the button spins and the others wait meanwhile; ↓2 on the bar, origin/main on the graph, the branch untouched); Pull fast-forwards to it without a merge commit; doing either again says there is nothing new',
    async () => {
      const mine = headOf(gfx.work);
      commitFile(gfx.mate, 'mate.txt', 'one\n', 'feat: teammate one', 'Ben');
      const theirs = commitFile(gfx.mate, 'mate.txt', 'two\n', 'fix: teammate two', 'Ben');
      git(gfx.mate, 'push', '-q', 'origin', 'main');
      assert.ok(!(await rowShas(gpg)).includes(theirs), 'nothing is known before fetching');

      // 先攔住請求：看得到執行中的樣子（按鈕轉圈、其他按鈕說「另一個動作正在執行」、狀態列「正在 fetch…」）
      let letGo;
      const gateOpen = new Promise((ok) => (letGo = ok));
      const held = [];
      const isGitPost = (u) => u.pathname === '/__agg/git';
      const holdGit = async (route) => {
        held.push(route);
        await gateOpen;
        await route.continue().catch(() => {});
      };
      await gpg.route(isGitPost, holdGit);
      await gitBtn(gpg, 'fetch').click();
      await waitUntil(() => held.length > 0, 10_000, 'the fetch request');
      const busy = await waitBar(gpg, (x) => x.btns.fetch.busy, 'Fetch is running');
      assert.equal(busy.btns.fetch.title, 'Fetching…');
      for (const a of ['pull', 'stash', 'tag', 'worktree'])
        assert.deepEqual(
          [busy.btns[a].disabled, busy.btns[a].why],
          [true, 'Another git action is running'],
          `${a} waits for the fetch`,
        );
      const progress = await noticeOf(gpg, BAR_NOTICE);
      assert.deepEqual(
        [progress.tone, progress.progress, progress.status],
        ['info', true, 'Fetching…'],
        'the bar status line says what is running',
      );
      letGo();
      await gpg.unroute(isGitPost, holdGit);
      await expectNotice(gpg, BAR_NOTICE, 'ok', 'Fetched new commits from every remote.', 'fetch');
      assert.equal(gitWork('rev-parse', 'origin/main'), theirs, 'origin/main moved');
      assert.equal(headOf(gfx.work), mine, 'fetch leaves the branch alone');
      let b = await waitBar(
        gpg,
        (x) => x.sync === '↓2' && x.btns.pull.badge === '↓2' && !x.btns.fetch.busy,
        'behind 2 after the fetch',
      );
      assert.equal(b.sr, '0 ahead of and 2 behind origin/main; No uncommitted changes');
      await waitUntil(
        async () => (await rowShas(gpg))[0] === theirs,
        20_000,
        'the fetched commits on top of the graph',
      );
      const top = (await domRows(gpg))[0];
      assert.ok(
        top.refs.some((r) => r.name === 'origin/main' && /agg-ref--remote/.test(r.cls)),
        `origin/main on the newest row: ${JSON.stringify(top.refs)}`,
      );

      await gitBtn(gpg, 'fetch').click();
      await expectNotice(gpg, BAR_NOTICE, 'info', 'No new commits.', 'fetch again');

      await gitBtn(gpg, 'pull').click();
      await expectNotice(
        gpg,
        BAR_NOTICE,
        'ok',
        'Fast-forwarded to the latest commit of the upstream.',
        'pull',
      );
      assert.equal(headOf(gfx.work), theirs, 'main is at the teammate’s commit');
      assert.equal(gitWork('rev-list', '--merges', '--count', 'HEAD'), '0', 'no merge commit');
      await waitBar(gpg, (x) => x.sync === '' && x.btns.pull.badge === null, 'in sync again');
      await waitUntil(
        async () => {
          const r = (await domRows(gpg))[0];
          return r.sha === theirs && r.refs.some((x) => /agg-ref--current/.test(x.cls));
        },
        20_000,
        'HEAD ➜ main moved to the newest row',
      );
      await gitBtn(gpg, 'pull').click();
      await expectNotice(gpg, BAR_NOTICE, 'info', 'Already up to date.', 'pull again');
      assert.deepEqual(
        gitActions.map((a) => a.action.type),
        ['fetch', 'fetch', 'pull', 'pull'],
      );
      assert.ok(gitActions.every((a) => a.repo === 'default'));
    },
  );

  await step(
    'GIT ACTIONS: Push asks first (N commits of the branch → its upstream; Esc cancels, focus returns) and pushes only the current branch; a push the remote rejects (non-fast-forward) is never forced; a diverged Pull refuses to merge; after a rebase in the terminal the push goes through',
    async () => {
      const remoteBefore = git(gfx.origin, 'rev-parse', 'main');
      const one = commitFile(gfx.work, 'local.txt', 'one\n', 'feat: local one');
      let b = await waitBar(
        gpg,
        (x) => x.sync === '↑1' && !x.btns.push.disabled && x.btns.push.badge === '↑1',
        'ahead 1 after a local commit',
      );
      assert.equal(b.sr, '1 ahead of and 0 behind origin/main; No uncommitted changes');
      const dlg = dialogNamed(gpg, 'Push main');
      await gitBtn(gpg, 'push').click();
      await dlg.waitFor();
      assert.equal(
        await dlg.locator('.web-git-lead').innerText(),
        '1 commit of main will be pushed to origin/main.',
      );
      assert.match(await dlg.innerText(), /Never uses --force/);
      assert.equal(await activeText(gpg), 'Push', 'focus starts on the Push button');
      const sent = gitActions.length;
      await gpg.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      assert.equal(gitActions.length, sent, 'Esc sends nothing');
      assert.equal(
        await gpg.evaluate(() => document.activeElement?.dataset.action ?? null),
        'push',
        'focus is back on the bar’s Push button',
      );
      assert.equal(git(gfx.origin, 'rev-parse', 'main'), remoteBefore, 'the remote is untouched');

      await gitBtn(gpg, 'push').click();
      await dlg.waitFor();
      await dlg.getByRole('button', { name: 'Push', exact: true }).click();
      await dlg.waitFor({ state: 'detached' });
      await expectNotice(gpg, BAR_NOTICE, 'ok', 'Pushed main to origin/main.', 'push');
      assert.equal(git(gfx.origin, 'rev-parse', 'main'), one, 'the remote has the commit');
      b = await waitBar(gpg, (x) => x.sync === '' && x.btns.push.disabled, 'nothing left to push');
      assert.equal(b.btns.push.why, 'Nothing to push');

      // 隊友先 push 了（這邊還沒 fetch），這邊又 commit 一個 → push 被拒絕，絕不 force
      git(gfx.mate, 'pull', '-q', '--ff-only');
      const teammate = commitFile(gfx.mate, 'mate.txt', 'three\n', 'fix: teammate three', 'Ben');
      git(gfx.mate, 'push', '-q', 'origin', 'main');
      const two = commitFile(gfx.work, 'local.txt', 'two\n', 'feat: local two');
      await waitBar(gpg, (x) => x.sync === '↑1' && !x.btns.push.disabled, 'ahead 1 (not fetched)');
      await gitBtn(gpg, 'push').click();
      await dlg.waitFor();
      await dlg.getByRole('button', { name: 'Push', exact: true }).click();
      const rejected = await expectNotice(
        gpg,
        BAR_NOTICE,
        'error',
        'The remote rejected the push because it has commits you do not have. Pull first.',
        'a non-fast-forward push',
      );
      assert.match(rejected.output, /rejected/, 'git’s own output can be expanded');
      assert.equal(git(gfx.origin, 'rev-parse', 'main'), teammate, 'never forced');
      assert.equal(headOf(gfx.work), two);

      await gitBtn(gpg, 'fetch').click();
      await expectNotice(gpg, BAR_NOTICE, 'ok', 'Fetched new commits from every remote.', 'fetch');
      b = await waitBar(gpg, (x) => x.sync === '↑1↓1', 'diverged: ahead 1 and behind 1');
      assert.equal(b.sr, '1 ahead of and 1 behind origin/main; No uncommitted changes');
      await gitBtn(gpg, 'push').click();
      await dlg.waitFor();
      assert.equal(
        await dlg.locator('.web-warn').first().innerText(),
        'origin/main has 1 commit you do not have: this push will be rejected. Pull first.',
      );
      await dlg.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dlg.waitFor({ state: 'detached' });

      // pull 只會 fast-forward：分岔時拒絕，不建立 merge commit、不留下衝突
      await gitBtn(gpg, 'pull').click();
      await expectNotice(
        gpg,
        BAR_NOTICE,
        'error',
        'Cannot fast-forward: this branch and its upstream have diverged. Merge or rebase in a terminal.',
        'a diverged pull',
      );
      assert.equal(headOf(gfx.work), two, 'the branch stays where it was');
      assert.equal(gitWork('rev-list', '--merges', '--count', 'HEAD'), '0', 'no merge commit');
      assert.equal(gitWork('status', '--porcelain'), '', 'nothing half-merged');

      // 在終端機 rebase 之後再 push
      execFileSync('git', ['rebase', '-q', 'origin/main'], { cwd: gfx.work, env: stamped('Amy') });
      const rebased = headOf(gfx.work);
      await waitBar(gpg, (x) => x.sync === '↑1', 'ahead 1 after the rebase');
      await gitBtn(gpg, 'push').click();
      await dlg.waitFor();
      await dlg.getByRole('button', { name: 'Push', exact: true }).click();
      await expectNotice(gpg, BAR_NOTICE, 'ok', 'Pushed main to origin/main.', 'push after rebase');
      assert.equal(git(gfx.origin, 'rev-parse', 'main'), rebased);
      assert.equal(
        git(gfx.origin, 'rev-parse', 'main~1'),
        teammate,
        'linear history on the remote',
      );
      assert.equal(git(gfx.backup, 'for-each-ref'), '', 'only the upstream remote was pushed to');
      const pushes = gitActions.filter((a) => a.action.type === 'push');
      assert.equal(pushes.length, 3);
      for (const p of pushes) assert.deepEqual(p.action, { type: 'push', confirm: true });
    },
  );

  await step(
    'GIT ACTIONS: a branch without an upstream — Pull says why it is unavailable; Push offers a remote picker (origin preselected), pushes to the chosen one and sets it as the upstream',
    async () => {
      gitWork('checkout', '-q', '-b', 'topic/e2e');
      const tip = commitFile(gfx.work, 'topic.txt', 'topic\n', 'feat: topic work');
      let b = await waitBar(gpg, (x) => x.branch === 'topic/e2e', 'the bar follows the checkout');
      assert.deepEqual(
        [b.btns.pull.disabled, b.btns.pull.why],
        [true, 'This branch has no upstream'],
      );
      assert.equal(b.btns.push.disabled, false, 'Push is offered (it sets the upstream)');
      assert.equal(b.sr, 'no upstream set; No uncommitted changes');
      await gitBtn(gpg, 'push').click();
      const dlg = dialogNamed(gpg, 'Push topic/e2e');
      await dlg.waitFor();
      assert.equal(
        await dlg.locator('.web-git-lead').innerText(),
        'topic/e2e has no upstream yet. Pick a remote; after the push it becomes the upstream:',
      );
      const remote = dlg.getByLabel('Remote', { exact: true });
      assert.equal(await remote.inputValue(), 'origin', 'origin is preselected');
      assert.deepEqual(await remote.locator('option').allInnerTexts(), ['backup', 'origin']);
      await dlg.getByText('Pushed as origin/topic/e2e', { exact: true }).waitFor();
      await remote.selectOption('backup');
      await dlg.getByText('Pushed as backup/topic/e2e', { exact: true }).waitFor();
      await dlg.getByRole('button', { name: 'Push and set upstream', exact: true }).click();
      await expectNotice(
        gpg,
        BAR_NOTICE,
        'ok',
        'Pushed topic/e2e to backup/topic/e2e and set it as the upstream.',
        'a set-upstream push',
      );
      assert.equal(git(gfx.backup, 'rev-parse', 'refs/heads/topic/e2e'), tip);
      assert.equal(
        gitWork('rev-parse', '--abbrev-ref', 'topic/e2e@{upstream}'),
        'backup/topic/e2e',
      );
      assert.equal(git(gfx.origin, 'for-each-ref', 'refs/heads/topic'), '', 'origin got nothing');
      b = await waitBar(
        gpg,
        (x) =>
          x.sr === '0 ahead of and 0 behind backup/topic/e2e; No uncommitted changes' &&
          !x.btns.pull.disabled &&
          x.btns.push.disabled,
        'the new upstream',
      );
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'push',
        confirm: true,
        setUpstream: { remote: 'backup' },
      });
      gitWork('checkout', '-q', 'main');
      await waitBar(gpg, (x) => x.branch === 'main', 'back on main');
    },
  );

  await step(
    'GIT ACTIONS: a detached HEAD and a merge stopped by a conflict (both made in the terminal) — the bar says so ("(detached HEAD) <sha>", "⚠ Merge in progress", the conflicted file) and Pull / Push / Stash changes say why they are unavailable',
    async () => {
      const main = headOf(gfx.work);
      gitWork('checkout', '-q', '--detach', 'HEAD~1');
      const detachedAt = headOf(gfx.work);
      await backToWindow(gpg);
      let b = await waitBar(gpg, (x) => x.branch !== 'main', 'the bar notices the detached HEAD');
      assert.equal(b.branch, `(detached HEAD) ${detachedAt.slice(0, 7)}`);
      for (const a of ['pull', 'push'])
        assert.deepEqual(
          [b.btns[a].disabled, b.btns[a].why],
          [true, 'HEAD is detached: check out a branch first'],
          `${a} on a detached HEAD`,
        );
      assert.equal(b.btns.fetch.disabled, false, 'fetch still works');

      // 兩條 branch 改同一行 → merge 停在衝突
      gitWork('checkout', '-q', '-b', 'conflict-a', main);
      commitFile(gfx.work, 'notes.txt', 'version a\n', 'docs: notes a');
      gitWork('checkout', '-q', '-b', 'conflict-b', main);
      commitFile(gfx.work, 'notes.txt', 'version b\n', 'docs: notes b');
      assert.throws(() =>
        execFileSync('git', ['merge', '-q', 'conflict-a'], {
          cwd: gfx.work,
          env: stamped('Amy'),
          stdio: 'pipe',
        }),
      );
      await backToWindow(gpg);
      b = await waitBar(gpg, (x) => x.op !== null, 'the in-progress merge');
      assert.equal(b.op, '⚠ Merge in progress');
      assert.equal(b.branch, 'conflict-b');
      assert.equal(b.dirty, '●1');
      assert.equal(
        b.sr,
        'no upstream set; 1 changed file (0 staged, 0 unstaged, 0 untracked, 1 conflicted)',
      );
      assert.deepEqual(
        [b.btns.pull.disabled, b.btns.pull.why],
        [true, 'This branch has no upstream'],
      );
      await gitBtn(gpg, 'stash').click();
      const dlg = dialogNamed(gpg, 'Stash');
      await dlg.waitFor();
      const save = dlg.getByRole('button', { name: 'Stash changes', exact: true });
      assert.equal(await save.getAttribute('aria-disabled'), 'true', 'no stash during a merge');
      assert.equal(
        await save.getAttribute('title'),
        'A merge / rebase is in progress: finish it in a terminal first',
      );
      await gpg.screenshot({ path: resolve(artifacts, '16-git-merge-in-progress.png') });
      await gpg.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });

      // 在終端機放棄 merge、回到 main
      gitWork('merge', '--abort');
      gitWork('checkout', '-q', 'main');
      gitWork('branch', '-q', '-D', 'conflict-a', 'conflict-b');
      await backToWindow(gpg);
      b = await waitBar(
        gpg,
        (x) => x.branch === 'main' && x.op === null && x.dirty === '',
        'back on a clean main',
      );
      assert.equal(b.btns.pull.disabled, false);
      assert.equal(headOf(gfx.work), main);
    },
  );

  await step(
    'GIT ACTIONS: Stash — save with a message (untracked files on request) leaves a clean tree; Apply keeps the stash; Pop drops it; Drop asks a second time (focus on Keep; Esc and Keep keep it)',
    async () => {
      writeIn(gfx.work, 'notes.txt', 'half-done edit\n');
      writeIn(gfx.work, 'idea.txt', 'untracked idea\n');
      await backToWindow(gpg);
      await waitBar(gpg, (x) => x.dirty === '●2', 'two changed files');
      await gitBtn(gpg, 'stash').click();
      const dlg = dialogNamed(gpg, 'Stash');
      await dlg.waitFor();
      assert.equal(
        await dlg.locator('.web-git-lead').innerText(),
        '2 changed files (0 staged, 1 unstaged, 1 untracked)',
      );
      assert.equal(await dlg.locator('.web-git-empty').innerText(), 'No stashes.');
      const message = dlg.getByLabel('Stash message (optional)');
      assert.equal(
        await gpg.evaluate(() => document.activeElement?.id ?? null),
        await message.getAttribute('id'),
        'focus starts in the message box',
      );
      await message.fill('wip: e2e stash');
      const untracked = dlg.getByLabel('Include untracked files');
      assert.equal(await untracked.isChecked(), false, 'untracked files are opt-in');
      await untracked.check();
      const save = dlg.getByRole('button', { name: 'Stash changes', exact: true });
      await save.click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Stashed your changes.', 'stash save');
      assert.equal(gitWork('status', '--porcelain'), '', 'a clean working tree');
      assert.equal(gitWork('stash', 'list', '--format=%gs'), 'On main: wip: e2e stash');
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'stash-save',
        message: 'wip: e2e stash',
        includeUntracked: true,
      });
      const items = dlg.locator('.web-git-li');
      await waitUntil(async () => (await items.count()) === 1, 10_000, 'one stash listed');
      assert.match(await items.first().innerText(), /stash@\{0\}[\s\S]*wip: e2e stash/);
      assert.equal(await message.inputValue(), '', 'the message box is cleared');
      await waitBar(gpg, (x) => x.dirty === '' && x.btns.stash.badge === '1', 'clean, 1 stash');
      // 沒有變更時「Stash changes」不能用，原因寫在按鈕上
      assert.equal(await save.getAttribute('aria-disabled'), 'true');
      assert.equal(await save.getAttribute('title'), 'There are no changes to stash');

      // Apply：變更回來，stash 還在
      await items.first().getByRole('button', { name: 'Apply', exact: true }).click();
      await expectNotice(
        gpg,
        DIALOG_NOTICE,
        'ok',
        'Applied stash@{0} (the stash is kept).',
        'stash apply',
      );
      assert.equal(readFileSync(resolve(gfx.work, 'notes.txt'), 'utf8'), 'half-done edit\n');
      assert.equal(readFileSync(resolve(gfx.work, 'idea.txt'), 'utf8'), 'untracked idea\n');
      assert.equal(stashCount(), 1, 'apply keeps the stash');

      // 再存一個（沒有訊息）；Pop 比較舊的那個（stash@{1}）
      await save.click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Stashed your changes.', 'a second stash');
      await waitUntil(async () => (await items.count()) === 2, 10_000, 'two stashes listed');
      assert.equal(gitWork('status', '--porcelain'), '');
      await items.nth(1).getByRole('button', { name: 'Pop', exact: true }).click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Applied and dropped stash@{1}.', 'stash pop');
      assert.equal(readFileSync(resolve(gfx.work, 'notes.txt'), 'utf8'), 'half-done edit\n');
      const left = gitWork('stash', 'list', '--format=%gs').split('\n');
      assert.equal(left.length, 1, 'pop drops the stash');
      assert.notEqual(left[0], 'On main: wip: e2e stash', 'the popped one is gone');
      await waitUntil(async () => (await items.count()) === 1, 10_000, 'one stash left');

      // Drop：列內第二次確認，焦點在 Keep；Esc / Keep 都保留
      const confirmRow = dlg.locator('.web-git-confirm');
      const sent = gitActions.length;
      await items.first().getByRole('button', { name: 'Drop', exact: true }).click();
      await confirmRow.waitFor();
      assert.equal(
        await confirmRow.locator('.web-git-confirm-text').innerText(),
        'Drop stash@{0}? It cannot be recovered afterwards.',
      );
      assert.equal(await activeText(gpg), 'Keep', 'focus starts on Keep');
      await gpg.keyboard.press('Escape');
      await confirmRow.waitFor({ state: 'detached' });
      assert.equal(await dlg.count(), 1, 'Esc closes only the confirmation');
      await items.first().getByRole('button', { name: 'Drop', exact: true }).click();
      await confirmRow.getByRole('button', { name: 'Keep', exact: true }).click();
      await confirmRow.waitFor({ state: 'detached' });
      assert.equal(gitActions.length, sent, 'Esc and Keep send nothing');
      assert.equal(stashCount(), 1, 'still there');
      await items.first().getByRole('button', { name: 'Drop', exact: true }).click();
      await confirmRow.getByRole('button', { name: 'Drop', exact: true }).click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Dropped stash@{0}.', 'stash drop');
      assert.equal(gitWork('stash', 'list'), '', 'no stashes left');
      assert.deepEqual(gitActions.at(-1).action, { type: 'stash-drop', index: 0, confirm: true });
      await dlg.locator('.web-git-empty').waitFor();
      await gpg.screenshot({ path: resolve(artifacts, '16-git-stash.png') });
      await gpg.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      assert.equal(
        await gpg.evaluate(() => document.activeElement?.dataset.action ?? null),
        'stash',
        'focus is back on the bar’s Stash button',
      );

      gitWork('checkout', '--', 'notes.txt');
      rmSync(resolve(gfx.work, 'idea.txt'));
      await backToWindow(gpg);
      await waitBar(gpg, (x) => x.dirty === '' && x.btns.stash.badge === null, 'clean again');
    },
  );

  await step(
    'GIT ACTIONS: Tag… in the detail panel tags the selected commit — names are checked like git check-ref-format before anything is sent; the annotated tag appears on its row; Push sends it to the upstream remote; Delete (confirmed) removes only the local tag; Tag on the bar tags HEAD and can push it at once; Esc in a dialog leaves the detail panel open',
    async () => {
      const row = (await domRows(gpg))[3];
      // 對話框顯示完整的第一行（列表把 conventional 的類型拆成標籤）
      const target = { sha: row.sha, subject: gitWork('log', '-1', '--format=%s', row.sha) };
      await clickRow(target.sha, {}, gpg);
      await waitSelected(target.sha, 'tag: select a commit', gpg);
      await gpg.locator('.agg-detail .web-detail-btn', { hasText: 'Tag…' }).click();
      const dlg = dialogNamed(gpg, 'Create a tag');
      await dlg.waitFor();
      assert.equal(
        await dlg.locator('.web-git-where').innerText(),
        `${target.sha.slice(0, 7)} · ${target.subject}`,
      );
      assert.equal(await dlg.locator('.web-git-empty').innerText(), 'This commit has no tags yet.');
      const name = dlg.getByLabel('Tag name');
      const create = dlg.getByRole('button', { name: 'Create tag', exact: true });
      const err = dlg.locator('.web-error[role="alert"]');
      const sent = gitActions.length;
      for (const [bad, why] of [
        ['bad name', 'Spaces and the characters ~ ^ : ? * [ \\ are not allowed.'],
        ['-x', 'It cannot start with -.'],
        [
          'a..b',
          'Invalid format (no .., @{ or //; it cannot start or end with / or ., or end with .lock).',
        ],
      ]) {
        await name.fill(bad);
        await create.click();
        await waitUntil(
          async () => (await err.count()) === 1 && (await err.innerText()) === why,
          5000,
          `“${bad}” is refused with “${why}”`,
        );
        assert.equal(await name.getAttribute('aria-invalid'), 'true');
      }
      assert.equal(gitActions.length, sent, 'invalid names never reach the dev server');
      assert.equal(gitWork('tag', '-l'), '', 'no tag yet');

      await name.fill('v0.9.0');
      await waitUntil(async () => (await err.count()) === 0, 5000, 'a valid name clears the error');
      await dlg.getByLabel('Message (optional; makes an annotated tag)').fill('e2e release');
      await create.click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Created tag v0.9.0.', 'tag create');
      assert.equal(gitWork('cat-file', '-t', 'v0.9.0'), 'tag', 'an annotated tag');
      assert.equal(gitWork('rev-parse', 'v0.9.0^{commit}'), target.sha, 'on the selected commit');
      assert.equal(gitWork('tag', '-l', '--format=%(contents:subject)', 'v0.9.0'), 'e2e release');
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'tag-create',
        name: 'v0.9.0',
        target: target.sha,
        message: 'e2e release',
      });
      const rowTags = async () =>
        ((await domRows(gpg)).find((r) => r.sha === target.sha)?.refs ?? [])
          .filter((r) => /agg-ref--tag/.test(r.cls))
          .map((r) => r.name);
      await waitUntil(
        async () => (await rowTags()).includes('v0.9.0'),
        20_000,
        'the tag badge on its row',
      );
      const item = dlg.locator('.web-git-li', { hasText: 'v0.9.0' });
      await item.waitFor();

      await item.getByRole('button', { name: 'Push', exact: true }).click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Pushed tag v0.9.0.', 'tag push');
      assert.equal(git(gfx.origin, 'rev-parse', 'v0.9.0^{commit}'), target.sha, 'origin has it');
      assert.deepEqual(gitActions.at(-1).action, { type: 'tag-push', name: 'v0.9.0' });

      await item.getByRole('button', { name: 'Delete', exact: true }).click();
      const confirmRow = dlg.locator('.web-git-confirm');
      await confirmRow.waitFor();
      assert.equal(
        await confirmRow.locator('.web-git-confirm-text').innerText(),
        'Delete the local tag v0.9.0? The remote tag is not touched.',
      );
      assert.equal(await activeText(gpg), 'Keep', 'focus starts on Keep');
      await confirmRow.getByRole('button', { name: 'Delete', exact: true }).click();
      await expectNotice(
        gpg,
        DIALOG_NOTICE,
        'ok',
        'Deleted the local tag v0.9.0 (the remote is untouched).',
        'tag delete',
      );
      assert.equal(gitWork('tag', '-l', 'v0.9.0'), '', 'the local tag is gone');
      assert.equal(git(gfx.origin, 'rev-parse', 'v0.9.0^{commit}'), target.sha, 'remote kept');
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'tag-delete',
        name: 'v0.9.0',
        confirm: true,
      });
      await waitUntil(async () => !(await rowTags()).includes('v0.9.0'), 20_000, 'badge gone');
      await dlg.locator('.web-git-empty').waitFor();
      await gpg.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      assert.equal(
        await selectedSha(gpg),
        target.sha,
        'Esc in the dialog does not reach the viewer',
      );
      assert.equal(await gpg.locator('.agg-detail').count(), 1, 'the detail panel stays open');

      // 動作列的 Tag：在 HEAD 上，建立後馬上 push 到 origin
      const head = headOf(gfx.work);
      await gitBtn(gpg, 'tag').click();
      await dlg.waitFor();
      assert.equal(
        await dlg.locator('.web-git-where').innerText(),
        `HEAD · main · ${head.slice(0, 7)}`,
      );
      await dlg.getByLabel('Tag name').fill('v1.0.0');
      await dlg.getByLabel('Push it to origin afterwards').check();
      await dlg.getByRole('button', { name: 'Create tag', exact: true }).click();
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', 'Created and pushed tag v1.0.0.', 'tag + push');
      assert.equal(gitWork('cat-file', '-t', 'v1.0.0'), 'commit', 'a lightweight tag');
      assert.equal(gitWork('rev-parse', 'v1.0.0'), head, 'on HEAD');
      assert.equal(git(gfx.origin, 'rev-parse', 'v1.0.0'), head, 'pushed to origin');
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'tag-create',
        name: 'v1.0.0',
        target: head,
        push: true,
      });
      await gpg.screenshot({ path: resolve(artifacts, '16-git-tag.png') });
      await gpg.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      await gpg.evaluate(() => document.querySelector('.agg-root').focus({ preventScroll: true }));
      await gpg.keyboard.press('Escape');
      await waitUntil(async () => (await selectedSha(gpg)) === null, 5000, 'detail closed');
    },
  );

  await step(
    'GIT ACTIONS: Worktree — the list marks the main / viewed worktree (not removable, and says why); Add checks out a new branch in a folder next to the repo; "Open the new worktree" shows it (?local=<id>, its own bar); a worktree with untracked files is not removed (never --force), a clean one is (its branch stays)',
    async () => {
      await gitBtn(gpg, 'worktree').click();
      const dlg = dialogNamed(gpg, 'Worktrees');
      await dlg.waitFor();
      const items = dlg.locator('.web-git-li');
      assert.equal(await items.count(), 1);
      assert.match(
        await items.first().innerText(),
        /work[\s\S]*main[\s\S]*viewing[\s\S]*main worktree/,
      );
      const removeMain = items.first().getByRole('button', { name: 'Remove', exact: true });
      assert.equal(await removeMain.getAttribute('aria-disabled'), 'true');
      assert.equal(await removeMain.getAttribute('title'), 'The main worktree cannot be removed');

      assert.equal(await dlg.getByLabel('A new branch').isChecked(), true, 'new branch by default');
      await dlg.getByLabel('New branch name').fill('wt-feature');
      const folder = dlg.getByLabel('Folder', { exact: true });
      assert.equal(await folder.inputValue(), 'work-wt-feature', 'a folder name from the branch');
      await dlg.getByText('Starting at HEAD (main)', { exact: true }).waitFor();
      await dlg.getByRole('button', { name: 'Add worktree', exact: true }).click();
      const wtDir = resolve(gfx.top, 'work-wt-feature');
      await waitUntil(
        async () => {
          const n = await noticeOf(gpg, DIALOG_NOTICE);
          return Boolean(n?.tone && !n.progress);
        },
        30_000,
        'the result of adding the worktree',
      );
      const wtLabel = repoLabelOf(wtDir);
      await expectNotice(gpg, DIALOG_NOTICE, 'ok', `Added worktree ${wtLabel}`, 'worktree add');
      assert.ok(statSync(wtDir).isDirectory(), 'a folder next to the repo');
      assert.equal(git(wtDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt-feature');
      assert.equal(headOf(wtDir), headOf(gfx.work), 'starting at HEAD');
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'worktree-add',
        path: 'work-wt-feature',
        newBranch: 'wt-feature',
      });
      await waitUntil(async () => (await items.count()) === 2, 10_000, 'two worktrees listed');

      const wtId = repoIdOf(wtDir);
      await dlg.getByRole('button', { name: 'Open the new worktree', exact: true }).click();
      await waitSearch(`?local=${wtId}`, gpg);
      await titleIs('work-wt-feature', gpg);
      await dlg.waitFor({ state: 'detached' });
      await waitShowsRepo(wtDir, 'the new worktree', gpg);
      await waitBar(gpg, (x) => x.branch === 'wt-feature', 'the bar of the new worktree');

      await gitBtn(gpg, 'worktree').click();
      await dlg.waitFor();
      const viewed = items.filter({ hasText: 'wt-feature' });
      assert.match(await viewed.innerText(), /viewing/);
      assert.equal(
        await viewed.getByRole('button', { name: 'Remove', exact: true }).getAttribute('title'),
        'You are viewing this worktree: open another one first',
      );
      writeIn(wtDir, 'leftover.txt', 'not committed\n');
      await items
        .filter({ hasText: 'main worktree' })
        .getByRole('button', { name: 'Open', exact: true })
        .click();
      await waitSearch('', gpg);
      await titleIs('work', gpg);
      await waitBar(gpg, (x) => x.branch === 'main', 'back in the main worktree');

      // Remove：先確認；有未追蹤的檔案 → 拒絕（不會 --force），資料夾還在
      await gitBtn(gpg, 'worktree').click();
      await dlg.waitFor();
      const wt = items.filter({ hasText: 'wt-feature' });
      const confirmRow = dlg.locator('.web-git-confirm');
      await wt.getByRole('button', { name: 'Remove', exact: true }).click();
      await confirmRow.waitFor();
      assert.equal(
        await confirmRow.locator('.web-git-confirm-text').innerText(),
        `Remove the worktree ${wtLabel}? Its folder is deleted (git refuses if it has modified or untracked files).`,
      );
      await confirmRow.getByRole('button', { name: 'Remove', exact: true }).click();
      await expectNotice(
        gpg,
        DIALOG_NOTICE,
        'error',
        'This worktree has modified or untracked files. Clean them up first (it is never removed with --force here).',
        'removing a dirty worktree',
      );
      assert.equal(readFileSync(resolve(wtDir, 'leftover.txt'), 'utf8'), 'not committed\n');
      const worktrees = () =>
        gitWork('worktree', 'list', '--porcelain').match(/^worktree /gm).length;
      assert.equal(worktrees(), 2, 'still two worktrees');
      assert.deepEqual(gitActions.at(-1).action, {
        type: 'worktree-remove',
        id: wtId,
        confirm: true,
      });

      rmSync(resolve(wtDir, 'leftover.txt'));
      await wt.getByRole('button', { name: 'Remove', exact: true }).click();
      await confirmRow.getByRole('button', { name: 'Remove', exact: true }).click();
      await expectNotice(
        gpg,
        DIALOG_NOTICE,
        'ok',
        `Removed worktree ${wtLabel}`,
        'worktree remove',
      );
      assert.throws(() => statSync(wtDir), /ENOENT/, 'the folder is gone');
      assert.equal(worktrees(), 1);
      assert.equal(gitWork('rev-parse', 'wt-feature'), headOf(gfx.work), 'the branch stays');
      await waitUntil(async () => (await items.count()) === 1, 10_000, 'one worktree left');
      await gpg.screenshot({ path: resolve(artifacts, '16-git-worktree.png') });
      await gpg.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
    },
  );

  await step(
    'SECURITY (git actions): pages on other origins (another localhost port, 127.0.0.1) can neither read /__agg/status nor run /__agg/git (cors, no-cors, form POST — the server itself answers 403); same-origin requests are validated too (405, 415, 413, unknown repo / action, destructive actions without confirm, a name starting with -); a forged Host is blocked by Vite; nothing in the repo changed',
    async () => {
      const snapshotOfRepo = () => ({
        refs: gitWork('for-each-ref'),
        origin: git(gfx.origin, 'for-each-ref'),
        backup: git(gfx.backup, 'for-each-ref'),
        status: gitWork('status', '--porcelain'),
        stash: gitWork('stash', 'list'),
        worktrees: gitWork('worktree', 'list', '--porcelain'),
      });
      const before = snapshotOfRepo();
      const gbase = gitSide.origin;
      const evil = JSON.stringify({
        repo: 'default',
        action: { type: 'tag-create', name: 'evil', target: headOf(gfx.work) },
      });
      const blankPage = async (host) => {
        const srv = createHttpServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>other origin</title><body></body>');
        });
        await new Promise((ok) => srv.listen(0, host, ok));
        return srv;
      };
      const blanks = [await blankPage('localhost'), await blankPage('127.0.0.1')];
      try {
        for (const url of [
          `http://localhost:${blanks[0].address().port}/`,
          `http://127.0.0.1:${blanks[1].address().port}/`,
        ]) {
          const other = await xctx.newPage();
          const responses = [];
          other.on('response', (r) => {
            if (r.url().startsWith(`${gbase}/__agg/`))
              responses.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
          });
          try {
            await other.goto(url);
            const out = await other.evaluate(
              async ({ gbase, body }) => {
                const read = async (u, init) => {
                  try {
                    const res = await fetch(u, init);
                    return `readable:${res.status}`;
                  } catch {
                    return 'blocked';
                  }
                };
                const opaque = (u, init) =>
                  fetch(u, { ...init, mode: 'no-cors' }).then(
                    (r) => r.type,
                    () => 'failed',
                  );
                return {
                  status: await read(`${gbase}/__agg/status?repo=default`),
                  post: await read(`${gbase}/__agg/git`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                  }),
                  statusNoCors: await opaque(`${gbase}/__agg/status?repo=default`),
                  postNoCors: await opaque(`${gbase}/__agg/git`, {
                    method: 'POST',
                    headers: { 'content-type': 'text/plain' },
                    body,
                  }),
                };
              },
              { gbase, body: evil },
            );
            assert.deepEqual(
              out,
              { status: 'blocked', post: 'blocked', statusNoCors: 'opaque', postNoCors: 'opaque' },
              `${url}: nothing readable, the JSON POST does not go through`,
            );
            const want = ['GET /__agg/status 403', 'POST /__agg/git 403'];
            await waitUntil(
              () => want.every((w) => responses.includes(w)),
              5000,
              `${url}: the server's answers (${responses})`,
            );
            assert.ok(
              responses.every((r) => / 403$/.test(r)),
              `${url}: all refused (${responses})`,
            );
            // 傳統的跨站表單（text/plain 拼出 JSON 的樣子）
            await Promise.all([
              other.waitForURL(`${gbase}/__agg/git`),
              other.evaluate(
                ({ gbase }) => {
                  const f = document.createElement('form');
                  f.method = 'POST';
                  f.action = `${gbase}/__agg/git`;
                  f.enctype = 'text/plain';
                  const i = document.createElement('input');
                  i.name = '{"repo":"default","action":{"type":"stash-save"},"x":"';
                  i.value = '"}';
                  f.append(i);
                  document.body.append(f);
                  f.submit();
                },
                { gbase },
              ),
            ]);
            assert.match(await other.locator('body').innerText(), /forbidden/);
          } finally {
            await other.close();
          }
        }
      } finally {
        for (const srv of blanks) await new Promise((ok) => srv.close(ok));
      }

      // 同源，但請求本身不對：一律拒絕（破壞性的動作沒有 confirm: true 也不行）
      const same = await gpg.evaluate(async (head) => {
        const go = async (url, init) => {
          const res = await fetch(url, init);
          const j = await res.json().catch(() => ({}));
          return `${res.status} ${j.code ?? j.error ?? ''}`.trim();
        };
        const json = { 'content-type': 'application/json' };
        const post = (body) =>
          go('/__agg/git', { method: 'POST', headers: json, body: JSON.stringify(body) });
        return {
          get: await go('/__agg/git', { method: 'GET' }),
          statusPost: await go('/__agg/status?repo=default', { method: 'POST' }),
          textPlain: await go('/__agg/git', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: JSON.stringify({ repo: 'default', action: { type: 'fetch' } }),
          }),
          tooLarge: await post({
            repo: 'default',
            action: { type: 'stash-save', message: 'x'.repeat(9000) },
          }),
          notJson: await go('/__agg/git', { method: 'POST', headers: json, body: '{nope' }),
          badRepo: await post({ repo: '../etc', action: { type: 'fetch' } }),
          unknownRepo: await post({ repo: '0123456789ab', action: { type: 'fetch' } }),
          unknownAction: await post({ repo: 'default', action: { type: 'reset-hard' } }),
          pushNoConfirm: await post({ repo: 'default', action: { type: 'push' } }),
          dropNoConfirm: await post({ repo: 'default', action: { type: 'stash-drop', index: 0 } }),
          tagDeleteNoConfirm: await post({
            repo: 'default',
            action: { type: 'tag-delete', name: 'v1.0.0' },
          }),
          worktreeRemoveNoConfirm: await post({
            repo: 'default',
            action: { type: 'worktree-remove', id: 'default' },
          }),
          dashName: await post({
            repo: 'default',
            action: { type: 'tag-create', name: '-x', target: head },
          }),
        };
      }, headOf(gfx.work));
      assert.deepEqual(same, {
        get: '405 method_not_allowed',
        statusPost: '405 method_not_allowed',
        textPlain: '415 unsupported_media_type',
        tooLarge: '413 too_large',
        notJson: '400 invalid',
        badRepo: '400 invalid',
        unknownRepo: '404 not_found',
        unknownAction: '400 invalid',
        pushNoConfirm: '400 invalid',
        dropNoConfirm: '400 invalid',
        tagDeleteNoConfirm: '400 invalid',
        worktreeRemoveNoConfirm: '400 invalid',
        dashName: '400 invalid',
      });

      // 瀏覽器以外（node http）：偽造的 Host 被 Vite 擋下；Host 對了但說是別的站 / 別的 Origin 也不行
      const raw = (path, opts) => rawHttp('localhost', gitSide.port, path, opts);
      const jsonHeaders = { 'content-type': 'application/json' };
      for (const [path, opts] of [
        ['/__agg/status?repo=default', {}],
        ['/__agg/git', { method: 'POST', headers: jsonHeaders, body: evil }],
      ]) {
        const r = await raw(path, { ...opts, headers: { ...opts.headers, Host: 'evil.example' } });
        assert.equal(r.status, 403, `forged Host → ${path}`);
        assert.match(r.body, /Blocked request/, 'rejected by Vite’s host check');
        assert.ok(!r.body.includes(gfx.top), 'no paths leak');
      }
      for (const [what, path, opts] of [
        [
          'status, Sec-Fetch-Site: cross-site',
          '/__agg/status?repo=default',
          { headers: { 'Sec-Fetch-Site': 'cross-site' } },
        ],
        [
          'status, Origin of another port',
          '/__agg/status?repo=default',
          { headers: { Origin: 'http://localhost:1' } },
        ],
        [
          'POST without Origin / fetch metadata',
          '/__agg/git',
          { method: 'POST', headers: jsonHeaders, body: evil },
        ],
        [
          'POST with a foreign Origin',
          '/__agg/git',
          {
            method: 'POST',
            headers: { ...jsonHeaders, Origin: 'http://evil.example' },
            body: evil,
          },
        ],
        [
          'POST, Sec-Fetch-Site: same-site',
          '/__agg/git',
          {
            method: 'POST',
            headers: { ...jsonHeaders, 'Sec-Fetch-Site': 'same-site' },
            body: evil,
          },
        ],
      ]) {
        const r = await raw(path, opts);
        assert.equal(r.status, 403, what);
        assert.equal(r.json?.error, 'forbidden', what);
      }
      // 對照組：這台電腦上直接讀狀態（網址列 / curl）可以
      const direct = await raw('/__agg/status?repo=default');
      assert.equal(direct.status, 200, 'a direct GET from this machine');
      assert.equal(direct.json.branch, 'main');

      assert.deepEqual(snapshotOfRepo(), before, 'none of these requests changed anything');
      assert.equal(gitWork('tag', '-l', 'evil'), '', 'no tag from another origin');
    },
  );

  const GIT_LAN_STEP =
    'SECURITY (git actions, vite --host): a client on a non-loopback address gets 403 local_only from /__agg/status and /__agg/git (the same server answers loopback); its page shows the graph but no git actions bar and no Tag… / Worktree… in the detail panel';
  if (!lanIp)
    console.log(`↷ skipped (this machine has no non-loopback IPv4 interface): ${GIT_LAN_STEP}`);
  else
    await step(GIT_LAN_STEP, async () => {
      const p = await freePort();
      const lanOrigin = `http://${lanIp}:${p}`;
      const lan = startVite(['--host', '0.0.0.0', '--port', String(p), '--strictPort'], {
        ...env,
        AGG_REPO_DIR: gfx.work,
        AGG_REPO_ROOTS: gfx.roots,
        AGG_LOCAL_REPOS_FILE: stateFileOf('git-lan'),
        ...hermeticGit,
      });
      sideServers.add(lan);
      const lanCtx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        proxy: { server: 'http://127.0.0.1:9', bypass: lanIp },
      });
      lanCtx.setDefaultTimeout(30_000 * SCALE);
      lanCtx.setDefaultNavigationTimeout(30_000 * SCALE);
      try {
        await lan.ready;
        const fromLan = (path, opts = {}) =>
          rawHttp(lanIp, p, path, { ...opts, headers: { Host: `${lanIp}:${p}`, ...opts.headers } });
        const st = await fromLan('/__agg/status?repo=default');
        assert.equal(st.status, 403, 'LAN status');
        assert.deepEqual(st.json, { error: 'local_only' });
        const act = await fromLan('/__agg/git', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Origin: lanOrigin,
            'Sec-Fetch-Site': 'same-origin',
          },
          body: JSON.stringify({ repo: 'default', action: { type: 'stash-save' } }),
        });
        assert.equal(act.status, 403, 'LAN git action');
        assert.equal(act.json?.error, 'local_only');
        for (const r of [st, act])
          for (const leak of [gfx.top, 'main', 'origin'])
            assert.ok(!r.body.includes(leak), `LAN answer must not leak "${leak}"`);
        const here = await rawHttp('127.0.0.1', p, '/__agg/status?repo=default', {
          headers: { Host: `localhost:${p}` },
        });
        assert.equal(here.status, 200, 'loopback: the same server answers');

        const lp = await lanCtx.newPage();
        watchErrors(lp, 'git LAN page');
        const answers = [];
        lp.on('response', (r) => {
          if (new URL(r.url()).pathname === '/__agg/status') answers.push(r.status());
        });
        await lp.goto(`${lanOrigin}/`);
        await titleIs('work', lp);
        await lp.locator('.agg-commit').first().waitFor();
        await waitUntil(() => answers.length > 0, 15_000, 'the LAN page asked for the status');
        await sleep(500);
        assert.deepEqual([...new Set(answers)], [403]);
        assert.equal(await lp.locator('.web-git').count(), 0, 'no git actions bar from the LAN');
        await clickRow((await rowShas(lp))[1], {}, lp);
        await lp.locator('.agg-detail').waitFor();
        assert.equal(await lp.locator('.web-detail-btn').count(), 0, 'no Tag… / Worktree…');
        await lp.screenshot({ path: resolve(artifacts, '16-git-lan.png') });
        await lp.close();
      } finally {
        await lanCtx.close();
        await stopSide(lan);
      }
    });

  await gpg?.close();
  if (gitSide) await stopSide(gitSide.v);
  await xctx.close();

  assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join('\n')}`);
  console.log(`\nAll ${results.length} web e2e steps passed. Screenshots → ${artifacts}`);
} catch (err) {
  console.error('\n✘ web e2e failed:', err);
  if (errors.length) console.error('browser errors:\n' + errors.join('\n'));
  try {
    const shot = shotPage && !shotPage.isClosed() ? shotPage : page;
    await shot?.screenshot({ path: resolve(artifacts, 'failure.png') });
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
  for (const v of sideServers) v.proc.kill();
  mock.close();
  if (deepDir) rmSync(deepDir, { recursive: true, force: true });
  if (gfx) rmSync(gfx.top, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(fx.rootsDir, { recursive: true, force: true });
  rmSync(fx.outsideDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
