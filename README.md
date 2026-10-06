# Adorable Git Graph 🌱

用 **three.js** 把 git graph 畫成「卡通插圖式、會動的流程表」：每個 commit 是一顆有表情的小球，
branch 是流動著箭頭的管線，merge / fork 會自己長出來。純前端，無後端。

| 階段  | 內容                                                                                           | 狀態        |
| ----- | ---------------------------------------------------------------------------------------------- | ----------- |
| **1** | `apps/extension` — Chrome extension，在 github.com repo 頁面顯示該 repo 的 git graph           | ✅ 本次完成 |
| 2     | `apps/web` — `pnpm start` 於 localhost 查看本專案的 git graph（與 extension 共用同一套 UI/UX） | ⏳ 下一階段 |

## 快速開始（Stage 1）

需求：Node ≥ 22.12、pnpm ≥ 10.16（`packageManager` 已鎖定）。

```bash
pnpm install
pnpm build            # → apps/extension/dist
```

載入到 Chrome：`chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `apps/extension/dist`。
然後打開任一 GitHub repo（例如 `https://github.com/stephen-taipei/adorable-git-grpah`）：

- 右下角出現 **Git Graph** 小球按鈕（或點工具列圖示）→ 開啟全螢幕卡通 git graph
- 操作：拖曳平移、滾輪縮放、雙擊全景、點 commit 開啟 GitHub commit 頁、`Esc` 關閉
- 工具列：▶ 重播進場動畫、⤢ 全景、↻ 重新抓取、⚙ 設定
- 左下角 branch 圖例可點擊，鏡頭會飛到該 branch 的最新 commit
- 跟隨 GitHub 的 light / dark 模式（白天 / 星空夜景）；介面語言依瀏覽器語言（繁中 / English）

> 安裝後，**已開啟的 GitHub 分頁需重新整理一次**，content script 才會注入。

### 開發

```bash
pnpm dev              # extension watch build（改完到 chrome://extensions 按重新載入）
pnpm typecheck        # nx run-many -t typecheck
pnpm test             # vitest：layout 演算法、GitHub client、URL 解析、設定
pnpm e2e              # 真實 Chromium 載入打包後的 extension（見下）
```

`pnpm e2e` 會：build 一份指向 mock GitHub API 的 extension → 用 Chromium（`--headless=new`）載入 →
在假的 `github.com` 頁面上驗證 FAB、overlay、繪圖、hover tooltip、點擊開 commit、縮放/平移、夜間主題、
404 / rate-limit 錯誤畫面、設定頁與 token 傳遞，截圖輸出到 `apps/extension/e2e/.artifacts/`。
找不到 Chrome 時設定 `CHROME_PATH`。

## 專案結構

```
apps/
  extension/            Chrome MV3 extension（Vite 多入口打包，無 crxjs 等額外外掛）
    src/background/     service worker：呼叫 GitHub API、快取、token 管理
    src/content/        content script：Shadow DOM 掛載 FAB + overlay，追蹤 SPA 換頁
    src/options/        設定頁（token / 分支數 / commit 數 / 快取）
    scripts/build.mjs   content/background 打成 IIFE，options 為一般頁面，並產生 manifest.json
    e2e/run.mjs         端到端測試
libs/
  graph-core/           純 TS、零相依：型別、lane 配置演算法、GitHub REST client、demo 資料
  graph-ui/             three.js 場景 + React viewer（extension 與 Stage 2 web app 共用）
```

- `libs/*` 以 `exports → src/index.ts` 提供原始碼，由使用端 bundler 編譯，不需獨立 build。
- UI/UX 全部在 `graph-ui`（`GitGraphViewer`），Stage 2 的 web app 只需換資料來源、不需重做 UI。

## 運作原理

1. **資料**：background 以 GitHub REST API 抓 repo → default branch + 目前瀏覽的 branch + open PR 分支（其餘依序補到上限，預設 5 條），
   各抓最近 60 筆 commit，以 sha 合併成 DAG，另抓 tags。約 `分支數 + 4` 次請求，結果快取 10 分鐘（`chrome.storage.local`）。
2. **佈局**（`graph-core/layout.ts`）：children-first 拓樸排序 → 類 `git log --graph` 的 lane 配置；
   default branch 固定在中線，其他 branch 上下交替展開；每條 lane 有固定顏色；邊以 S 曲線只在兩端換 lane，避免穿過其他節點。
3. **繪圖**（`graph-ui/scene`）：正交相機 + `MeshToonMaterial`（3 階色）+ inverted-hull 描邊；
   表情、腮紅、皇冠等以 canvas 貼圖；管線用自製 ribbon geometry + shader（描邊 / 流動箭頭 `>` / reveal 動畫）；
   進場依時間由舊到新「長出來」，鏡頭跟隨，播完飛到最新 commit。
   commit 類型對應表情：`feat` ✨ 大笑、`fix` 😰 冒汗、`merge` 😮 較大顆、root 長嫩芽、default branch 最新 commit 戴皇冠。
4. 尊重 `prefers-reduced-motion`（略過進場與閒置晃動）；分頁隱藏時暫停渲染。

## Token 與安全性

- 未登入每小時 60 次 API；到設定頁加入 **fine-grained PAT** 可提升到 5,000 次並讀取私有 repo。
- 請只授與目標 repo 的 `Contents: Read-only` + `Metadata: Read-only`，**不要用有寫入權限的 token**。
- Token 只存在 `chrome.storage.local`，只有 background 讀取、只以 `Authorization` header 送往 `api.github.com`；
  content script / 頁面 DOM 看不到（e2e 有驗證）。更換 token 會清除快取。
- 權限最小化：`storage` + `https://api.github.com/*`；content script 只匹配 `https://github.com/*`，非 repo 頁面不渲染任何東西。
- commit 訊息等外部字串只經 React text node 與 canvas 繪製，無 `innerHTML`。

## 已知限制

- 只顯示最近約 60 筆 × 分支數的歷史，更早的以「… 歷史已省略」標示；超大 repo 不會是完整圖。
- 未登入時額度很小，連續開多個 repo 會遇到 rate limit（畫面會提示，並可跳到設定頁）。
- 目前只支援 github.com（不含 GitHub Enterprise、GitLab）。
- 動畫在無 GPU 的環境（軟體 WebGL）會明顯掉幀，屬預期。

## Stage 2（規劃）

`apps/web`：Vite + React，`pnpm start` 於 localhost 渲染同一個 `GitGraphViewer`。資料來源預計兩種：
GitHub API（沿用 `fetchGitHubGraph`）與 build-time 以 Vite plugin 執行 `git log` 產出的本機快照（離線、不吃 rate limit）。
