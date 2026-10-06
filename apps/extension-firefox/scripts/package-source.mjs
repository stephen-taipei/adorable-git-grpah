// AMO 審查要的原始碼 zip：用 `git archive HEAD`，所以只有「已 commit」的內容會進去。
// working tree 有未 commit 的變更時，zip 與你上傳的 add-on 可能不一致 → 直接拒絕。
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const git = (...args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });

const status = git('status', '--porcelain');
if (status.status !== 0) {
  console.error(`✘ git status 失敗：${status.stderr}`);
  process.exit(1);
}
if (status.stdout.trim()) {
  console.error(
    `✘ working tree 有未 commit 的變更，source zip（HEAD）會和上傳的 add-on 不一致。請先 commit 或 stash：\n${status.stdout}`,
  );
  process.exit(1);
}

const out = resolve(appRoot, 'web-ext-artifacts/adorable-git-graph-source.zip');
mkdirSync(dirname(out), { recursive: true });
const r = git('archive', '--format=zip', '--prefix=adorable-git-graph/', '-o', out, 'HEAD');
if (r.status !== 0) {
  console.error(`✘ git archive 失敗：${r.stderr}`);
  process.exit(1);
}
console.log(`✔ ${out}（commit ${git('rev-parse', '--short', 'HEAD').stdout.trim()}）`);
