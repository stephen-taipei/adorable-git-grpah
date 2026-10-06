// Firefox 版建置。實際的打包邏輯與原始碼都在 @adorable/extension-core，與 Chrome 版共用。
// 用法：node scripts/build.mjs [--watch]
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from '@adorable/extension-core/build';

await buildExtension({
  target: 'firefox',
  appRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  watch: process.argv.includes('--watch'),
});
