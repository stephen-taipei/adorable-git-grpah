// 在「真正的 Firefox」裡載入 MV3 extension 並操作它的測試輔助。
// 驅動方式：puppeteer-core 經 WebDriver BiDi（browser.installExtension = about:debugging 的「載入暫時性附加元件」）。
// 已驗證版本：Firefox 157.0.1 / puppeteer-core 25.12.0（已鎖定版本：下面的 chrome 範圍操作依賴 puppeteer 與 Firefox 的內部細節，
// 升級時要重新驗證）。
//
// 內容：啟動（findFirefox / startXvfb / launchFirefox）、瀏覽器 UI（chrome 範圍）操作（工具列按鈕、event page 控制、extension 的
// console 錯誤、剪貼簿讀寫）、組合鍵、content script 畫面（open shadow root）的查詢 / 點擊（shadowKit）、分頁與 extension 頁面的輔助。
// Firefox 的幾個限制（e2e 都繞過了，改動前先讀）：
//   - moz-extension:// 頁面是特權範圍：BiDi 不能對它截圖、不接受真實的滑鼠 / 鍵盤輸入（所以設定頁用 JS 操作 DOM）
//   - 內容頁的 navigator.clipboard 需要 user activation + 貼上提示：剪貼簿改在 chrome 範圍（system principal）讀寫
//   - 封閉網路：外部網址（例如 commit 頁）會變成 about:neterror，網址要用 realUrl() 還原
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

/** 找得到的第一個 Firefox：FIREFOX_PATH → 常見位置 → PATH。找不到回傳 undefined。 */
export function findFirefox() {
  const explicit = process.env.FIREFOX_PATH;
  if (explicit && !existsSync(explicit)) {
    // 明確指定卻打錯路徑時，不要默默改用別的 Firefox（或在沒有 CI 變數的環境「略過」而回報成功）
    throw new Error(`FIREFOX_PATH 指向不存在的檔案：${explicit}`);
  }
  const candidates = [
    explicit,
    '/opt/ff-env/bin/firefox',
    '/usr/bin/firefox',
    '/usr/lib/firefox/firefox',
    '/usr/lib/firefox-esr/firefox-esr',
    '/snap/bin/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (hit) return hit;
  const which = spawnSync('which', ['firefox']);
  return which.status === 0 ? which.stdout.toString().trim() : undefined;
}

/**
 * Headless Firefox 在沒有顯示器時無法建立 WebGL context（沒有 EGL）。
 * 用虛擬 X server（Xvfb）提供 GLX + Mesa 軟體繪圖，--headless 照開也能跑 WebGL 2。已有 DISPLAY（例如 xvfb-run）就沿用。
 */
export function startXvfb() {
  if (process.env.DISPLAY) return Promise.resolve({ display: process.env.DISPLAY, stop() {} });
  return new Promise((resolve, reject) => {
    const p = spawn(
      'Xvfb',
      ['-displayfd', '3', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'], // fd 3 = -displayfd；其餘的 xkbcomp 雜訊全部丟掉
      },
    );
    p.on('error', (e) =>
      reject(
        new Error(
          `無法啟動 Xvfb（WebGL 需要虛擬顯示器）：${e.message}。請安裝 xvfb，或在 xvfb-run 底下執行。`,
        ),
      ),
    );
    p.on('exit', (c) => reject(new Error(`Xvfb 提早結束 (${c})`)));
    let buf = '';
    p.stdio[3].on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        p.removeAllListeners('exit');
        const stop = () => p.kill();
        // Ctrl-C / 被 kill 時別留下孤兒 Xvfb（puppeteer 自己只管 Firefox）
        process.once('exit', stop);
        for (const sig of ['SIGINT', 'SIGTERM']) {
          process.once(sig, () => {
            stop();
            process.exit(130);
          });
        }
        resolve({ display: `:${buf.trim()}`, stop });
      }
    });
  });
}

/**
 * @param {{ firefox: string, extDir: string, geckoId: string, uuid: string, display?: string, prefs?: object }} o
 * `uuid` 固定住 extension 內部的 moz-extension://<uuid>/ 主機名，才能直接開 options.html。
 */
export async function launchFirefox({ firefox, extDir, geckoId, uuid, display, prefs = {} }) {
  const browser = await puppeteer.launch({
    browser: 'firefox', // 預設走 WebDriver BiDi
    executablePath: firefox,
    headless: true,
    // 必要：沒有它 BiDi 不允許操作 moz-extension:// 頁面（"System access is required"），也沒有瀏覽器 UI（chrome）範圍可以按工具列按鈕
    args: ['--remote-allow-system-access'],
    env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
    extraPrefsFirefox: {
      'extensions.webextensions.uuids': JSON.stringify({ [geckoId]: uuid }),
      // event page 預設閒置 30 秒就會停止；測試期間拉長，避免背景狀態在步驟之間被重設
      'extensions.background.idle.timeout': 600000,
      'intl.accept_languages': 'en-US',
      // 封閉的網路：不是 127.0.0.1 / localhost 的請求一律立刻失敗（死掉的 proxy），測試不依賴也不碰外網；本機位址預設不走 proxy
      'network.proxy.type': 1,
      'network.proxy.http': '127.0.0.1',
      'network.proxy.http_port': 9,
      'network.proxy.ssl': '127.0.0.1',
      'network.proxy.ssl_port': 9,
      ...prefs,
    },
  });
  let extId;
  try {
    extId = await browser.installExtension(extDir); // 暫時性附加元件；MV3 的 host 權限會自動授予
  } catch (err) {
    await browser.close();
    throw err;
  }
  return { browser, extId };
}

// ---- 瀏覽器 UI（chrome）範圍：直接送 BiDi ----------------------------------------------------
// `browser.connection` 是 puppeteer BidiBrowser 的執行期屬性（型別宣告裡沒有）。
const send = (browser, method, params = {}) =>
  browser.connection.send(method, params).then((r) => r.result ?? r);

const chromeContexts = new WeakMap(); // 每個 browser 各自的 browser.xhtml 頂層視窗
export async function chromeEval(browser, fn, ...args) {
  let ctx = chromeContexts.get(browser);
  if (!ctx) {
    const tree = await send(browser, 'browsingContext.getTree', { 'moz:scope': 'chrome' });
    chromeContexts.set(browser, (ctx = tree.contexts[0].context));
  }
  const r = await send(browser, 'script.callFunction', {
    functionDeclaration: `async (j) => JSON.stringify(await (${fn.toString()})(...JSON.parse(j)))`,
    arguments: [{ type: 'string', value: JSON.stringify(args) }],
    awaitPromise: true,
    target: { context: ctx },
    resultOwnership: 'none',
  });
  if (r.type === 'exception')
    throw new Error(`chromeEval: ${r.exceptionDetails?.text ?? JSON.stringify(r)}`);
  return r.result.value === undefined ? undefined : JSON.parse(r.result.value);
}

/**
 * 按下 extension 的工具列按鈕 → 觸發真正的 action.onClicked（對目前選取的分頁）。
 * 按鈕預設在「附加元件」面板裡（面板沒打開時沒有 DOM），所以先搬到 nav-bar。呼叫前先 page.bringToFront()。
 */
export async function clickToolbarButton(browser, geckoId) {
  const widgetId = `${geckoId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}-browser-action`;
  return chromeEval(
    browser,
    async (id) => {
      CustomizableUI.addWidgetToArea(id, 'nav-bar'); // CustomizableUI 是 browser.xhtml 的全域物件
      for (let i = 0; i < 50 && !document.getElementById(id); i++)
        await new Promise((r) => setTimeout(r, 50));
      const btn = document
        .getElementById(id)
        .querySelector('toolbarbutton.webextension-browser-action');
      btn.click();
      return btn.id;
    },
    widgetId,
  );
}

/**
 * 在瀏覽器內部（chrome 範圍）取得 extension 物件並對 event page 做事。
 *   'terminate' : 立刻停掉 event page（等同閒置逾時；`extensions.background.idle.timeout` 的計時器只在背景啟動時武裝一次，
 *                 事後改 pref 不會生效，所以不能靠縮短逾時來測 suspend）
 *   'state'     : 'running' | 'stopped' | …（ext.backgroundState）
 * 用到 Firefox 內部 API（ExtensionParent）：升級 Firefox 時要重新驗證。
 */
export function backgroundControl(browser, geckoId, op) {
  return chromeEval(
    browser,
    async (id, what) => {
      const { ExtensionParent } = ChromeUtils.importESModule(
        'resource://gre/modules/ExtensionParent.sys.mjs',
      );
      const ext = ExtensionParent.GlobalManager.getExtension(id);
      if (!ext) throw new Error(`extension ${id} not found`);
      if (what === 'terminate') await ext.terminateBackground();
      return ext.backgroundState;
    },
    geckoId,
    op,
  );
}

/** extension 自己的頁面 / event page 丟出的 console 錯誤（content script 的在 page 的 console 事件裡，這裡抓不到的那一半）。 */
export function extensionConsoleErrors(browser, uuid) {
  return chromeEval(
    browser,
    (u) =>
      (Services.console.getMessageArray() ?? [])
        .filter(
          (m) =>
            m instanceof Ci.nsIScriptError &&
            !(m.flags & Ci.nsIScriptError.warningFlag) &&
            (m.sourceName ?? '').startsWith(`moz-extension://${u}/`),
        )
        .map((m) => `${m.sourceName}:${m.lineNumber} ${m.errorMessage}`),
    uuid,
  );
}

// ---- 剪貼簿 / 組合鍵 ----------------------------------------------------------------------------
// 內容頁的 navigator.clipboard 需要 user activation（而且 Firefox 會跳出「貼上」的提示），BiDi 也沒有 clipboard 權限可以授予；
// 瀏覽器 UI（chrome 範圍）是 system principal，不受這些限制，所以讀 / 寫剪貼簿都在那邊做（Xvfb 底下是真正的 X 剪貼簿）。
/** 目前剪貼簿的文字；讀不到（例如沒有剪貼簿服務）回傳 null。 */
export const readClipboard = (browser) =>
  chromeEval(browser, () => navigator.clipboard.readText()).catch(() => null);

export const writeClipboard = (browser, text) =>
  chromeEval(browser, (t) => navigator.clipboard.writeText(t), text);

/**
 * 按組合鍵（puppeteer 的 keyboard.press 只吃單一按鍵）：`chord(page, ['Shift'], 'Enter')`、`chord(page, ['Control'], 'a')`。
 * 不管按鍵成不成功，修飾鍵一定會放開，免得影響後面的步驟。
 */
export async function chord(page, modifiers, key) {
  for (const m of modifiers) await page.keyboard.down(m);
  try {
    await page.keyboard.press(key);
  } finally {
    for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
  }
}

// ---- content script 的畫面（Shadow DOM） ---------------------------------------------------------
/**
 * content script 的所有畫面都在 open shadow root（#adorable-git-graph-host）裡，puppeteer 的一般選擇器 / page.content() 看不到。
 * 回傳一組查詢與操作函式：
 *   shadow(fn, ...args) / ui(fn, ...args)  在頁面裡執行 `fn(shadowRoot, ...args)` / `fn(.agg-root 元素, ...args)`
 *                                          （fn 會被序列化，不能引用外部變數；window / document 是頁面的）
 *   exists / count / textOf / text         selector 是否存在 / 有幾個 / textContent / innerText
 *   waitFor / waitGone                     等 selector 出現 / 消失（以間隔輪詢，分頁在背景時也不會停）
 *   find(selector, pattern?, by?)          回傳 ElementHandle；pattern 是 regex，比對 textContent 或 `by` 指定的屬性
 *   click(selector, pattern?, by?)         真的滑鼠點擊（puppeteer 會先把元素捲進可視範圍、算出點擊座標）
 */
export function shadowKit(page, hostId = 'adorable-git-graph-host') {
  const sr$ = `document.getElementById(${JSON.stringify(hostId)})?.shadowRoot`;
  const shadow = (fn, ...args) =>
    page.evaluate(
      new Function('...args', `const sr = ${sr$}; return (${fn.toString()})(sr, ...args);`),
      ...args,
    );
  const ui = (fn, ...args) =>
    page.evaluate(
      new Function(
        '...args',
        `const r = ${sr$}?.querySelector('.agg-root'); return (${fn.toString()})(r, ...args);`,
      ),
      ...args,
    );
  const exists = (sel) => shadow((sr, s) => Boolean(sr?.querySelector(s)), sel);
  const count = (sel) => shadow((sr, s) => sr?.querySelectorAll(s).length ?? 0, sel);
  const textOf = (sel) => shadow((sr, s) => sr?.querySelector(s)?.textContent ?? null, sel);
  const text = (sel) => shadow((sr, s) => sr?.querySelector(s)?.innerText ?? null, sel);
  const waitFor = (sel, timeout = 20_000) =>
    page.waitForFunction(
      new Function('s', `return Boolean(${sr$}?.querySelector(s));`),
      { timeout, polling: 100 },
      sel,
    );
  const waitGone = (sel, timeout = 20_000) =>
    page.waitForFunction(
      new Function('s', `return !${sr$}?.querySelector(s);`),
      { timeout, polling: 100 },
      sel,
    );
  const find = async (selector, pattern, by = 'textContent') => {
    const h = await page.evaluateHandle(
      new Function(
        's',
        'src',
        'by',
        `const sr = ${sr$};
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
  const click = async (selector, pattern, by) => {
    const el = await find(selector, pattern, by);
    try {
      await el.click();
    } finally {
      await el.dispose().catch(() => {}); // 點擊可能已經讓元素 / 頁面消失
    }
  };
  return { shadow, ui, exists, count, textOf, text, waitFor, waitGone, find, click };
}

// ---- 分頁 --------------------------------------------------------------------------------------
/** 被擋掉的網路請求會變成 about:neterror / about:certerror?...&u=<原網址>：還原成原本要去的網址，其他網址不變。 */
export function realUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'about:' && /^(neterror|certerror)$/.test(x.pathname))
      return x.searchParams.get('u') ?? u;
  } catch {
    /* 不是合法網址：原樣回傳 */
  }
  return u;
}

/** 分頁目前的網址。moz-extension:// 分頁的 page.url() 會一直是過期的 about:blank，所以直接問文件本身。 */
export async function tabUrl(page) {
  let u;
  try {
    u = await page.evaluate(() => location.href);
  } catch {
    u = page.url();
  }
  return realUrl(u);
}

/** 執行 `action`，回傳它開出來的第一個分頁（window.open、runtime.openOptionsPage…）。 */
export async function newTabFrom(browser, action, timeout = 10000) {
  let timer;
  let onCreated;
  const created = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no new tab within ${timeout}ms`)), timeout);
    onCreated = (target) => {
      clearTimeout(timer);
      resolve(target);
    };
    browser.once('targetcreated', onCreated);
  });
  try {
    await action();
  } catch (err) {
    // action 本身失敗：收掉計時器與監聽，否則 10 秒後會再冒出一個誤導的 "no new tab" 未處理 rejection
    clearTimeout(timer);
    browser.off('targetcreated', onCreated);
    created.catch(() => {});
    throw err;
  }
  return (await created).page();
}

export async function waitForTabUrl(page, re, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    const u = await tabUrl(page);
    if (re.test(u)) return u;
    if (Date.now() - start > timeout) throw new Error(`tab url never matched ${re}; last: ${u}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 開 moz-extension://<uuid>/<path>。對這種網址 goto() 永遠不會 resolve（特權頁面沒有 load 事件），所以忽略逾時、改為輪詢文件狀態。 */
export async function openExtensionPage(browser, uuid, path) {
  const page = await browser.newPage();
  await page.goto(`moz-extension://${uuid}/${path}`, { timeout: 500 }).catch(() => {});
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
  return page;
}

/**
 * background（event page）的 window 控制代碼；需要先有一個 extension 頁面（例如 options）。
 * 用法：`bg.evaluate((w, ...a) => …, ...a)` — callback 跑在 extension 頁面的 realm，但拿到的 `w` 是 background 的 window（同源），
 * 所以 w.chrome.* 與 w.<全域變數> 都是 background 的。
 */
export const backgroundHandle = (extPage) =>
  extPage.evaluateHandle(() => chrome.runtime.getBackgroundPage());

// moz-extension:// 頁面不接受真正的滑鼠 / 鍵盤輸入（input.performActions 會被拒絕），所以在 extension 頁面用 JS 直接操作 DOM。
// 對 React 受控的 input 也有效（原生 value setter + 會冒泡的 input 事件）。
export const fillExt = (page, selector, value) =>
  page.$eval(
    selector,
    (el, v) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value,
  );

export const clickExtByText = (page, selector, pattern) =>
  page.evaluate(
    (sel, src) => {
      const re = new RegExp(src);
      const el = [...document.querySelectorAll(sel)].find((e) => re.test(e.textContent ?? ''));
      if (!el) throw new Error(`no ${sel} matching ${src}`);
      el.click();
    },
    selector,
    pattern.source,
  );
