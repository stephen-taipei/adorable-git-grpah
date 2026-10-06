// 將 extension 的三個入口各自打包，並產生 manifest.json。
//   content.js    → IIFE（content script 不能使用 ES module import）
//   background.js → IIFE service worker
//   options.html  → 一般 Vite 頁面
// 用法：node scripts/build.mjs [--watch]
//   AGG_API_BASE   覆寫 GitHub API 位址（僅 e2e 用；會一併加入 host_permissions）
//   AGG_OUT_DIR    覆寫輸出資料夾（預設 dist）
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.env.AGG_DEV === '1';
const apiBase = (process.env.AGG_API_BASE ?? 'https://api.github.com').replace(/\/$/, '');
const outDir = resolve(root, process.env.AGG_OUT_DIR ?? 'dist');

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

function manifest() {
  const hostPermissions = new Set(['https://api.github.com/*']);
  hostPermissions.add(`${new URL(apiBase).origin}/*`);
  return {
    manifest_version: 3,
    name: 'Adorable Git Graph',
    version: pkg.version,
    description: 'Cartoon-style animated git graph for any GitHub repository, powered by three.js.',
    minimum_chrome_version: '116',
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
    background: { service_worker: 'background.js' },
    content_scripts: [
      { matches: ['https://github.com/*'], js: ['content.js'], run_at: 'document_idle' },
    ],
    options_ui: { page: 'options.html', open_in_tab: true },
    permissions: ['storage'],
    host_permissions: [...hostPermissions],
  };
}

const define = {
  'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  __AGG_API_BASE__: JSON.stringify(apiBase),
};

const common = {
  configFile: false,
  root,
  logLevel: 'info',
  plugins: [react()],
  define,
};

const buildBase = {
  outDir,
  emptyOutDir: false,
  minify: !dev,
  sourcemap: dev,
  target: 'chrome116',
  watch: watch ? {} : null,
  reportCompressedSize: false,
};

const iife = (name, entry, file) =>
  build({
    ...common,
    build: {
      ...buildBase,
      lib: { entry: resolve(root, entry), formats: ['iife'], name, fileName: () => file },
    },
  });

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(resolve(root, 'public'), outDir, { recursive: true });
await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`);

await iife('AdorableGitGraphContent', 'src/content/index.tsx', 'content.js');
await iife('AdorableGitGraphBackground', 'src/background/index.ts', 'background.js');
await build({
  ...common,
  root: resolve(root, 'src/options'),
  base: './',
  build: {
    ...buildBase,
    outDir,
    rollupOptions: { input: resolve(root, 'src/options/options.html') },
  },
});

console.log(`\n✔ extension built → ${outDir}${watch ? ' (watching)' : ''}`);
