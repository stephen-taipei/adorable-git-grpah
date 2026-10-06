import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { gitSnapshot } from './plugins/git-snapshot.ts';

export default defineConfig({
  plugins: [react(), gitSnapshot()],
  // 只綁 localhost：dev 時的 /__agg/git-snapshot 會回傳本機 commit 的作者與訊息。
  // cors: false — 只做同源請求；Vite 預設的 CORS 會讓其他 localhost 埠的頁面讀到 /__agg/git-snapshot
  server: { host: 'localhost', port: 4200, cors: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
