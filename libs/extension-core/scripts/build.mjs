// extension 的共用建置：Chrome 與 Firefox 版本用同一份原始碼，只有 manifest 不同。
//   content.js    → IIFE（content script 不能使用 ES module import）
//   background.js → IIFE（Chrome：service worker；Firefox：event page）
//   options.html  → 一般 Vite 頁面
// 環境變數（皆為 e2e / 開發用，預設值就是正式版）：
//   AGG_API_BASE    覆寫 GitHub API 位址（會一併加入 host_permissions）
//   AGG_EXTRA_MATCH 額外讓 content script 注入的網址樣式，逗號分隔（e2e：本機假的 github 頁面）
//   AGG_OUT_DIR     覆寫輸出資料夾（相對於 app 目錄；預設 dist）
//   AGG_DEV         設為 1 時不壓縮並輸出 sourcemap
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { createManifest } from './manifest.mjs';

const libRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {object} o
 * @param {'chrome' | 'firefox'} o.target
 * @param {string} o.appRoot  呼叫端 app 的目錄（取 package.json 的 version、輸出到它底下）
 * @param {boolean} [o.watch]
 * @param {NodeJS.ProcessEnv} [o.env]
 */
export async function buildExtension({ target, appRoot, watch = false, env = process.env }) {
  const dev = watch || env['AGG_DEV'] === '1';
  const apiBase = (env['AGG_API_BASE'] ?? 'https://api.github.com').replace(/\/$/, '');
  const extraMatches = (env['AGG_EXTRA_MATCH'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const outDir = resolve(appRoot, env['AGG_OUT_DIR'] ?? 'dist');
  const pkg = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));

  const define = {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    __AGG_API_BASE__: JSON.stringify(apiBase),
  };
  const common = {
    configFile: false,
    root: libRoot,
    logLevel: 'info',
    plugins: [react()],
    define,
  };
  const buildBase = {
    outDir,
    emptyOutDir: false,
    minify: !dev,
    sourcemap: dev,
    // Chrome 116 / Firefox 128（manifest 的最低版本）都支援
    target: target === 'firefox' ? 'firefox128' : 'chrome116',
    watch: watch ? {} : null,
    reportCompressedSize: false,
  };

  const iife = (name, entry, file) =>
    build({
      ...common,
      build: {
        ...buildBase,
        lib: { entry: resolve(libRoot, entry), formats: ['iife'], name, fileName: () => file },
      },
    });

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(resolve(libRoot, 'assets/icons'), resolve(outDir, 'icons'), { recursive: true });
  const manifest = createManifest({ target, version: pkg.version, apiBase, extraMatches });
  await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await iife('AdorableGitGraphContent', 'src/content/index.tsx', 'content.js');
  await iife('AdorableGitGraphBackground', 'src/background/index.ts', 'background.js');
  await build({
    ...common,
    root: resolve(libRoot, 'src/options'),
    base: './',
    build: {
      ...buildBase,
      outDir,
      rollupOptions: { input: resolve(libRoot, 'src/options/options.html') },
    },
  });

  console.log(`\n✔ ${target} extension built → ${outDir}${watch ? ' (watching)' : ''}`);
  return { outDir, manifest };
}
