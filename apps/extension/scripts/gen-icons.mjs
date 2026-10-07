// 以吉祥物 SVG 產生 extension 圖示（Chrome 不支援 SVG icon）。用法：pnpm --filter @adorable/extension icons
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../../../tools/e2e/chrome-path.mjs';

// 圖示放在共用 lib：Chrome 與 Firefox 版共用同一組
const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../libs/extension-core/assets/icons',
);
await mkdir(out, { recursive: true });

const INK = '#2b2140';
const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <circle cx="50" cy="52" r="40" fill="#4fdc9a" stroke="${INK}" stroke-width="7"/>
  <ellipse cx="36" cy="33" rx="11" ry="7" fill="#fff" opacity=".7" transform="rotate(-30 36 33)"/>
  <circle cx="36" cy="49" r="10" fill="#fff" stroke="${INK}" stroke-width="4"/>
  <circle cx="64" cy="49" r="10" fill="#fff" stroke="${INK}" stroke-width="4"/>
  <circle cx="38" cy="51" r="5" fill="${INK}"/><circle cx="62" cy="51" r="5" fill="${INK}"/>
  <path d="M36 67 q14 15 28 0" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
  <ellipse cx="24" cy="64" rx="7" ry="4.5" fill="#ff6b94" opacity=".55"/>
  <ellipse cx="76" cy="64" rx="7" ry="4.5" fill="#ff6b94" opacity=".55"/>
  <path d="M30 18 L26 4 L40 12 L50 0 L60 12 L74 4 L70 18 Z" fill="#ffd23f" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/>
</svg>`;

const browser = await chromium.launch({ executablePath: findChrome() });
try {
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(`<body style="margin:0;background:transparent">${svg(size)}</body>`);
    await page.screenshot({ path: resolve(out, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('✔ icons written to', out);
