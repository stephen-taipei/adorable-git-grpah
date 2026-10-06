// 兩個瀏覽器的 manifest 只在「背景頁形式」與 Firefox 專屬欄位上不同；其餘（權限、content script、options）完全一致。
//   chrome  : background.service_worker
//   firefox : background.scripts（event page；Firefox 的 MV3 不支援 service_worker）+ browser_specific_settings.gecko

/**
 * Firefox 的 add-on ID。上架 AMO 之後就是這個 extension 的永久身分（更換 = 另一個 add-on，使用者資料與更新都不會延續），
 * 因此首次上架前可以改成自己的；用 GUID 而不是 email 形式，避免宣稱擁有某個網域。
 */
export const GECKO_ID = '{a7e41ba9-0aed-427f-8ecb-26518af4920a}';

export const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * URL → match pattern。**ポートは含めない**：Firefox は `http://127.0.0.1:1234/*` のようなポート付きパターンを
 * エラーも警告も出さずに受け付け、そして決してマッチしない（host 許可としても効かない）。
 * `http://127.0.0.1/*` なら任意のポートにマッチする。
 */
export function hostPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/**
 * @param {object} o
 * @param {'chrome' | 'firefox'} o.target
 * @param {string} o.version
 * @param {string} [o.apiBase]       覆寫 GitHub API 位址（僅 e2e；會一併加入 host_permissions）
 * @param {string[]} [o.extraMatches] 額外讓 content script 注入的網址樣式（僅 e2e：本機假的 github 頁面）
 */
export function createManifest({
  target,
  version,
  apiBase = GITHUB_API_ORIGIN,
  extraMatches = [],
}) {
  // Set で重複を排除（e2e では apiBase と extraMatches が同じホストになる）
  const hostPermissions = new Set([
    `${GITHUB_API_ORIGIN}/*`,
    hostPattern(apiBase),
    ...extraMatches,
  ]);

  const manifest = {
    manifest_version: 3,
    name: 'Adorable Git Graph',
    version,
    description: 'Cartoon-style animated git graph for any GitHub repository, powered by three.js.',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Toggle Git Graph',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    content_scripts: [
      {
        matches: ['https://github.com/*', ...extraMatches],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage'],
    host_permissions: [...hostPermissions],
  };

  if (target === 'chrome') {
    manifest.minimum_chrome_version = '116';
    manifest.background = { service_worker: 'background.js' };
  } else if (target === 'firefox') {
    manifest.background = { scripts: ['background.js'] };
    // data_collection_permissions は Firefox 140（Android は 142）で導入されたキー。宣言するなら最低版もそれ以上にする
    // （web-ext lint の KEY_FIREFOX_*_UNSUPPORTED_BY_MIN_VERSION）。140 は現行の ESR。
    manifest.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  } else {
    throw new Error(`Unknown target: ${target}`);
  }
  return manifest;
}
