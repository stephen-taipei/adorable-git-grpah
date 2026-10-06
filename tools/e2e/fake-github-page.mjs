// e2e 共用：長得像 GitHub repo 頁面的假頁面（只需要有 <html data-color-mode> 與一些內容）。
import { createServer } from 'node:http';

export const fakeGithubPage = (title) => `<!doctype html>
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

/**
 * 在本機起一個假的 github.com：任何路徑都回傳假頁面。
 * Firefox e2e 沒有照 Chrome e2e 的做法攔截 https://github.com，而是讓 content script 額外比對 `http://127.0.0.1/*`
 * （見 libs/extension-core 的 AGG_EXTRA_MATCH），頁面由這個伺服器提供：不依賴請求攔截、網路完全封閉，比較單純。
 * 代價：Firefox e2e 跑的是「多了本機 match 的 e2e 建置」，不是正式打包的 manifest；正式 manifest 由
 * manifest.test.mjs 與 `web-ext lint` 把關，release 腳本也會再檢查一次產物。
 * @returns {Promise<import('node:http').Server>}
 */
export function startFakeGithub() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fakeGithubPage(path.slice(1) || 'github'));
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}
