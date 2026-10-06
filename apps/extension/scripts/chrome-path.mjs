import { existsSync } from 'node:fs';

/** 找一個可用的 Chrome / Chromium 執行檔（Playwright 內建安裝或系統安裝）。 */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 Chrome。請設定 CHROME_PATH 環境變數。');
  return hit;
}
