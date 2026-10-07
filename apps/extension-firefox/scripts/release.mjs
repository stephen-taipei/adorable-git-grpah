// AMO 上架用的一條龍：乾淨 working tree → 以「不含任何 AGG_* 覆寫」的環境建置 → 檢查產物 → web-ext lint →
// 打包 xpi → 以 HEAD 打包 source zip。任何一步失敗就中止，不會留下「看起來能上傳」的半成品。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(appRoot, 'dist');

// 先確認 working tree 乾淨（package-source 內也會檢查；這裡提早失敗，省得白白建置一次）
const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd: appRoot, env, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✘ ${cmd} ${args.join(' ')} 失敗`);
    process.exit(r.status ?? 1);
  }
};
const status = spawnSync('git', ['-C', appRoot, 'status', '--porcelain'], { encoding: 'utf8' });
if (status.stdout.trim()) {
  console.error(`✘ working tree 有未 commit 的變更，請先 commit 或 stash：\n${status.stdout}`);
  process.exit(1);
}

// 環境裡殘留的 AGG_*（例如之前跑 e2e / 開發時 export 的）會改變產物（host 權限、sourcemap…），一律拿掉
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('AGG_')),
);
run(process.execPath, ['scripts/build.mjs'], cleanEnv);

// 產物必須就是正式版：權限只有 GitHub、沒有 sourcemap
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
assert.deepEqual(manifest.host_permissions, ['https://api.github.com/*']);
assert.deepEqual(
  manifest.content_scripts.map((c) => c.matches),
  [['https://github.com/*']],
);
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
assert.deepEqual(
  walk(dist).filter((f) => f.endsWith('.map')),
  [],
  'production build must not ship sourcemaps',
);

run('pnpm', ['exec', 'web-ext', 'lint', '--source-dir', 'dist']);
rmSync(resolve(appRoot, 'web-ext-artifacts'), { recursive: true, force: true });
run('pnpm', [
  'exec',
  'web-ext',
  'build',
  '--source-dir',
  'dist',
  '--artifacts-dir',
  'web-ext-artifacts',
  '--overwrite-dest',
]);
run(process.execPath, ['scripts/package-source.mjs']);
console.log(
  '\n✔ web-ext-artifacts/ 內的 .zip（add-on）與 adorable-git-graph-source.zip 可以上傳 AMO。',
);
