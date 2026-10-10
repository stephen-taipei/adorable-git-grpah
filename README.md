# Adorable Git Graph 🌱

用 **three.js** 把 git graph 畫成「卡通插圖式、會動的流程表」：每個 commit 是一顆有表情的小球，
branch 是流動著箭頭的管線，merge / fork 會自己長出來。版面是 **`git log --graph` 式的上下捲動列表**（最新在最上面），
每一列帶著 SHA、作者、日期、branch / tag / HEAD 等常用 git 資訊；手機到桌機都能用（RWD）。純前端，無後端。

| 階段   | 內容                                                                                                               | 狀態 |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ---- |
| **1**  | `apps/extension` — Chrome extension，在 github.com repo 頁面顯示該 repo 的 git graph                               | ✅   |
| **1b** | `apps/extension-firefox` — Firefox（MV3）版，與 Chrome 版共用同一份原始碼                                          | ✅   |
| **2**  | `apps/web` — `pnpm start` 於 localhost 查看本專案或**任何本機 repo** 的 git graph（與 extension 共用同一套 UI/UX） | ✅   |

## 快速開始

需求：Node ≥ 22.18、pnpm ≥ 10.16（`packageManager` 已鎖定）。

```bash
pnpm install
pnpm start            # 階段 2：http://localhost:4200 ，預設顯示「本專案」，可從選單換成其他本機 repo
pnpm build            # 建置所有專案：Chrome → apps/extension/dist、Firefox → apps/extension-firefox/dist、web → apps/web/dist
```

### 階段 2 · Web app（`pnpm start`）

- 預設讀**本機 git**（Vite plugin 執行 `git log`）：離線可用、不吃 GitHub rate limit、包含尚未 push 的 commit / branch。
- **即時更新**：在終端機 `git commit` / 切 branch / `git fetch`，畫面會自己長出新的小球（不用重新整理，由 HMR 推送）。
  只有**新增**的 commit 會彈出來；你正在看的位置與選取的 commit 不會被重設（如果你本來就在最上面，新的 commit 直接出現在眼前）。
  偵測方式：逐層監看 `.git` 的 `HEAD` / `packed-refs` / `refs/**` 目錄（不用遞迴 `fs.watch`，它在 Linux 上第二次 commit 起就會漏事件），
  另有每 2 秒比對 ref 清單的安全網；git 暫時出錯時保留上一張好的圖，不會讓 dev server 掛掉。
- **選擇本機 repo**（只有 dev server）：`📍 本機` 旁的選單列出預設 repo（★）與它**同層資料夾**裡的 git repo
  （往下找 3 層；一般 repo、worktree、`*.git` bare repo 都算；略過 `node_modules`、`.` 開頭、`dist` / `build` 等資料夾，不跟隨 symlink、不往 repo 裡面找）。
  選了之後網址變成 `/?local=<id>`（可加書籤、上一頁 / 下一頁可用），那個 repo 一樣即時更新（最多同時監看 4 個非預設 repo，最久沒看的會先停，再選到時重新開始）。
  清單外的 repo：選「＋ 開啟其他路徑…」輸入**絕對路徑**（可用 `~`，repo 裡的子資料夾也可以）；輸入過的路徑記在這個瀏覽器，dev server 重開後會自動重新登記。
  回到這個分頁時清單會重新掃描（剛 `git clone` 的 repo 會出現）。
- 標題列下方的 `📍 本機 | 🐙 GitHub`：切到 GitHub 後輸入 `owner/repo` 或 GitHub 網址（也可直接開 `/?repo=owner/repo`），
  從瀏覽器直接呼叫 GitHub REST API（與 extension 同一套 `fetchGitHubGraph`），結果快取 10 分鐘。
  未登入每小時 60 次，點 ⚙ 可貼入 fine-grained PAT（只存 localStorage、只送往 `api.github.com`；更換 / 清除 token 會一併清掉快取）。
- 🌓 切換 自動 / 白天 / 夜晚主題（會記住）；點 commit：有 GitHub remote 就開 commit 頁，否則複製完整 sha。
- 環境變數：`AGG_REPO_DIR`（要看哪個 repo，預設就是本專案；一般 repo、bare repo、shallow clone 都可以）、
  `AGG_MAX_COMMITS`（預設 300，不再被 layout 偷偷截成 400）、`AGG_MAX_BRANCHES`（預設 8）、
  `AGG_DEFAULT_BRANCH`（預設依序：`origin/HEAD` → `main` → `master` → 目前 branch；`main` 或 `origin/main` 兩種寫法都可以）。
  例如預設改看另一個專案：`AGG_REPO_DIR=~/code/other pnpm start`。
  選單的掃描範圍：`AGG_REPO_ROOTS`（以 `:` 分隔，Windows 為 `;`，可用 `~`；預設是預設 repo 的上一層）、`AGG_REPO_SCAN_DEPTH`（預設 3）。
  例如：`AGG_REPO_ROOTS=~/code:~/work pnpm start`。掃描上限 5000 個資料夾 / 300 個 repo / 3 秒，超過時選單會提示清單不完整。
- `pnpm --filter @adorable/web build && pnpm --filter @adorable/web preview`：靜態版，**把建置當下的 git 快照烤進 bundle**。

> ⚠️ 靜態版的 bundle 只含 **commit 的第一行（subject）與作者名稱**，不含 email 與 commit 本文（`Signed-off-by` / `Co-authored-by` 等 trailer 不會被讀進來）。
> 但 subject、作者名與 branch / tag 名稱仍是公開資訊：**不要把私有 repo 的建置結果公開部署**。
> dev server 預設只綁 `localhost`；`/__agg/git-snapshot`、`/__agg/repos` 只存在於 dev、只回應同源請求（其他 localhost 埠上的頁面讀不到，e2e 有驗證），不會出現在 build 中。
> 偽造的 `Host`（DNS rebinding）會先被 Vite 自己的 host 檢查擋掉。瀏覽器選 repo 時只送出 server 算出的 id（realpath 的雜湊），不會送路徑；
> 唯一的例外是「開啟其他路徑」：那是使用者自己輸入的路徑，server 只接受同源頁面送來的 `application/json` POST（跨站表單 / no-cors 請求送不出，fetch 會被 CORS preflight 擋下）。
> 掃描只檢查資料夾裡有沒有 `.git`，不會在清單上的每個 repo 執行 git；只有你選了某個 repo，dev server 才會在那裡執行唯讀的 git 指令（等同你自己在那裡打 `git log`）。
> 靜態版沒有後端可重讀 git，因此不顯示重新整理按鈕。
> `pnpm build` 不使用 Nx 快取 web（快照是建置當下的 git 狀態，不是檔案內容的函數）。

### Chrome extension（`apps/extension`）

載入到 Chrome：`chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選 `apps/extension/dist`。
然後打開任一 GitHub repo（例如 `https://github.com/stephen-taipei/adorable-git-grpah`）：

- 右下角出現 **Git Graph** 小球按鈕（或點工具列圖示）→ 開啟全螢幕卡通 git graph；操作方式見下方「介面」
- 跟隨 GitHub 的 light / dark 模式（白天 / 星空夜景）；介面語言依瀏覽器語言（繁中 / English）
- 開啟時後面的 GitHub 頁面不會被捲動、按鍵不會觸發 GitHub 的快捷鍵（在搜尋框打字很安全）

> 安裝後，**已開啟的 GitHub 分頁需重新整理一次**，content script 才會注入。

### Firefox extension（`apps/extension-firefox`）

需求：Firefox **≥ 140**（ESR 140 以上；原因見下方「AMO 上架」）。

```bash
pnpm --filter @adorable/extension-firefox build     # → apps/extension-firefox/dist
```

- **臨時載入**：開啟 `about:debugging#/runtime/this-firefox` →「載入暫時性附加元件…」→ 選 `apps/extension-firefox/dist/manifest.json`（關掉 Firefox 就會移除）。
- **開發時自動載入**：`pnpm --filter @adorable/extension-firefox start`（`web-ext run`，會開一個乾淨的 Firefox 並載入，並開到本專案的 GitHub 頁面；用 `pnpm dev:firefox` 另開終端機 watch 建置）。
- 使用方式、畫面與 Chrome 版完全相同（同一份原始碼、同一套 `GitGraphViewer`）。
- Firefox 的 MV3 把 host 權限當成使用者可撤銷的「網站存取」：若在附加元件設定裡關掉 `github.com` 的存取，浮動按鈕就不會出現，點工具列圖示會看到 `!` 徽章。

**與 Chrome 版的差異**（manifest 全部在 `libs/extension-core/scripts/manifest.mjs`；另外 vite 轉譯目標依瀏覽器各取其最低版本，`build.mjs` 內一行；應用程式碼沒有分支）

|            | Chrome                        | Firefox                                                                   |
| ---------- | ----------------------------- | ------------------------------------------------------------------------- |
| background | `service_worker`              | `scripts`（event page；Firefox 的 MV3 沒有 service worker）               |
| 識別       | —                             | `browser_specific_settings.gecko.id`（GUID）+ `strict_min_version: 140.0` |
| 其他       | `minimum_chrome_version: 116` | `gecko_android.strict_min_version: 142.0`、`data_collection_permissions`  |

event page 閒置 30 秒會被停掉，而以 `sendResponse` 非同步回覆的訊息不會延長它的壽命（背景若改成回傳 Promise 則可以，目前沒這樣做），
所以 background 對 GitHub 的請求設了 25 秒上限（`AbortSignal.timeout`；兩個瀏覽器共用同一份程式，逾時顯示「網路錯誤」而不是莫名失敗）。

#### AMO 上架（addons.mozilla.org）

```bash
git status                                         # 必須是乾淨的（已 commit）：source zip 取自 HEAD
pnpm --filter @adorable/extension-firefox release  # 一條龍：以乾淨環境建置 → 檢查產物 → lint → 打包 add-on → 打包 source zip
```

`release`（`apps/extension-firefox/scripts/release.mjs`）做的事，也可以分開跑：

```bash
pnpm --filter @adorable/extension-firefox build           # 注意：會吃環境裡殘留的 AGG_* 變數（開發 / e2e 用）；release 會先清掉
pnpm --filter @adorable/extension-firefox lint            # web-ext lint：目前 0 個錯誤
pnpm --filter @adorable/extension-firefox package         # → web-ext-artifacts/adorable_git_graph-<version>.zip
pnpm --filter @adorable/extension-firefox package:source  # → web-ext-artifacts/adorable-git-graph-source.zip（git archive HEAD；working tree 不乾淨會拒絕）
```

- **原始碼要一起上傳**：bundle 是壓縮過的（React、three.js），AMO 審查要求提供原始碼與建置步驟。`package:source` 產生的壓縮檔含 `pnpm-lock.yaml`；
  建置方式：Node ≥ 22.18、pnpm 10.28，`pnpm install --frozen-lockfile && pnpm --filter @adorable/extension-firefox build`。
  審查說明可寫：`web-ext lint` 的 4 個 `UNSAFE_VAR_ASSIGNMENT` 警告來自 react-dom 內部（`dangerouslySetInnerHTML` 的處理），本專案原始碼沒有 `innerHTML`。
- **`gecko.id` 是永久身分**：目前是一個隨機 GUID（`{a7e41ba9-…}`）。第一次上架前可改成自己的；上架後再換 = 另一個附加元件，使用者與更新都不會延續。
- **`strict_min_version` 為什麼是 140**：`data_collection_permissions` 是 Firefox 140（Android 142）才有的欄位，宣告它就不能把最低版本設得更低（`web-ext lint` 會警告）。
- ⚠️ **請自行確認 `data_collection_permissions: { required: ["none"] }` 是否符合 AMO 的政策**（信心：中低）。本 extension 不會把任何資料送給開發者，
  但會把 repo 的 owner / 名稱，以及使用者**自行輸入**的 GitHub token 送到 `api.github.com`；Mozilla 是否把這算作「資料收集」我無法確認（政策頁面在此環境讀不到）。
  若審查不接受，可能的修法是把 token 宣告成**選用**的資料類別（`optional: ["authenticationInfo"]`，使用者不輸入 token 就沒有任何資料送出）；
  不要直接改成 `required`，那會在安裝時對一個選用功能要求同意。實際該宣告什麼請以 AMO 當時的政策為準。
- Firefox for Android 沒有測試過，`gecko_android` 只是為了讓 manifest 通過檢查。

### 介面（三個版本共用同一套 `GitGraphViewer`）

| 區域       | 內容                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 線圖欄     | 每個 commit 一顆小球（類型決定表情：`feat` 大笑、`fix` 冒汗、`merge` 較大顆、root 長嫩芽、default branch 最新 commit 戴皇冠），一條 lane 一欄、default branch 在最左；branch 是流動著箭頭的管線，fork / merge 以 S 曲線轉彎                                                                |
| 每一列     | branch / tag 標籤（`HEAD ➜ main`、★ default、☁ remote 虛線、⚑ tag）、merge 標記、`feat` / `fix` 類型小標籤、作者、日期（寬螢幕顯示絕對時間、窄螢幕顯示相對時間）、短 SHA（點一下複製完整 SHA）                                                                                             |
| 工具列     | 搜尋（說明 / 作者 / sha / branch / tag，多個詞要同時符合，不符合的列淡化；`Enter` / `Shift+Enter` 跳到下一筆 / 上一筆）、統計（commit / branch / tag / 作者 / merge 數量與最新 commit 時間）、branch 篩選（點一下只看該 branch 的歷史並捲到它的最新 commit，顯示領先 default 幾個 commit） |
| 詳情       | 點任一列：完整說明、完整 SHA（可複製）、作者、時間、parent / child（可跳轉）、指到這裡的 branch / tag、「包含於哪些 branch」（只算已載入範圍）、上一個 / 下一個、「在 GitHub 開啟」                                                                                                        |
| 鍵盤       | `↑` `↓` / `j` `k` 選取上 / 下一個、`Home` `End`、`/` 搜尋；`Esc` 一次收一層：詳情 → 搜尋文字 → branch 聚焦 → 關閉 overlay                                                                                                                                                                  |
| 工具列按鈕 | ▶ 重播進場動畫（目前可視範圍）、⤒ 回到最新、↻ 重新抓取（背景重抓，捲動位置與選取不動，按鈕轉圈）、⚙ 設定                                                                                                                                                                                   |

RWD 以 viewer 自己的寬度判斷（不是視窗寬度）：**寬**（≥ 980px）詳情靠右並排；**中**（640–979px）詳情是浮在右側的抽屜；
**窄**（< 640px）一列變成兩行（說明 / 作者 · 日期 · SHA），詳情是底部面板（在版面流程裡，被選取的那一列不會被蓋住），工具列的統計與 branch 可橫向捲動。
作者 / 日期欄位依「列表實際剩多少寬度」收起來（詳情並排時列表會變窄），線圖欄寬依 lane 數壓縮，說明文字永遠留得到空間。
矮視窗（橫放的手機）會把工具列壓扁，詳情打開時整個讓給列表與面板。尊重 `prefers-reduced-motion`。

### 開發

```bash
pnpm start            # web app（http://localhost:4200）
pnpm dev              # Chrome extension watch build（改完到 chrome://extensions 按重新載入）
pnpm dev:firefox      # Firefox extension watch build
pnpm typecheck        # nx run-many -t typecheck
pnpm test             # vitest：layout 演算法、git log 解析、GitHub client、URL 解析、設定、git 快照 plugin
pnpm e2e              # 真實瀏覽器：web app + Chrome extension + Firefox extension 端到端（見下）
```

`pnpm e2e` 會一次一套（`--parallel=1`）跑 Chrome extension、web、Firefox extension 三套端到端測試（順序由 nx 決定）。

三套的共同重點：列資訊與順序、**捲動時線圖與文字列對齊**（捲到好幾個位置，包含超過 canvas 緩衝距離的大跳躍與列表尾端，
對每一列的小球中心取樣截圖像素）、搜尋 / branch 聚焦 / 詳情 / 鍵盤、三種寬度的 RWD（無橫向溢出、底部面板不蓋住被選取的列）、
重新整理保留捲動位置與選取、夜間主題、錯誤畫面、token 不外洩。細節見各 `e2e/run.mjs` 開頭的註解與步驟名稱。

**Chrome extension**（`apps/extension/e2e`）：build 一份指向 mock GitHub API 的 extension → 用 Chromium（`--headless=new`）載入 →
在假的 `github.com` 頁面上驗證 FAB、overlay、繪圖、頁面不被捲動、按鍵不洩漏到頁面、Esc 分層、404 / rate-limit 錯誤畫面、快取命中與強制重抓、設定頁與 token 傳遞，截圖輸出到 `apps/extension/e2e/.artifacts/`。
**web**（`apps/web/e2e`）：啟動真正的 dev server，對一個臨時建立的 git repo 驗證本機快照、**commit / 建 branch 後畫面即時更新且不重新整理**（含捲動錨定）、
連續多次 commit / 切 branch、cross-origin 讀不到 dev endpoint、本機 repo 選單（掃描範圍、切換 / 上一頁 / deep link、選到的 repo 即時更新、手動輸入路徑與錯誤訊息、跨站無法新增路徑、窄螢幕不溢出）、GitHub 來源切換（輸入驗證、404、rate limit、deep link 與快取、token 不外洩且移除後不留帶 token 的快取）、
主題記憶、本機 build + preview（快照烤進 bundle、無 Refresh、dev endpoint 不存在）。

**Firefox extension**（`apps/extension-firefox/e2e`）：用 puppeteer-core 經 WebDriver BiDi 驅動**真正的 Firefox**，載入打包後的 add-on（等同「載入暫時性附加元件」），
頁面由本機假的 github 伺服器提供（e2e 版 manifest 額外比對 `http://127.0.0.1/*`，所以跑的不是正式 manifest；正式 manifest 由單元測試、`web-ext lint` 與 `release` 的產物檢查把關）。
除了三套共同的檢查，還包含：頁面在 overlay 後面不能捲動也被設為 inert（Tab 進不去，GitHub 換掉 `<body>` 後也一樣）、按鍵不洩漏到頁面、點背景關閉、快取與強制重抓、夜間主題、SPA 換頁的錯誤畫面、
**真的按下工具列按鈕**（`action.onClicked` → `tabs.sendMessage`）、沒有 content script 的頁面顯示 `!` 徽章、從設定按鈕開 `moz-extension://…/options.html` 並驗證 token 只以 Bearer header 送出、
以及 **event page 被終止後**（直接呼叫 Firefox 內部的 `terminateBackground()`，確認狀態為 `stopped`）下一個請求能喚醒它並正常回應。
另外，結尾會檢查 content script、event page、options 頁都沒有未捕捉的 console 錯誤，token 也不得出現在頁面（含 shadow DOM）或任何 URL。
需求：Firefox（`FIREFOX_PATH` 可指定）與 Xvfb（headless Firefox 沒有 EGL，WebGL 要靠虛擬顯示器；或用 `xvfb-run` 包起來）。
找不到 Firefox 時會提示並略過，設了 `CI` 或 `REQUIRE_FIREFOX` 則視為失敗。

三套的截圖輸出到各自的 `e2e/.artifacts/`。Chrome 找不到時設定 `CHROME_PATH`；`FIREFOX_PATH` 指向不存在的檔案會直接報錯（不會悄悄改用別的 Firefox）。

## 專案結構

```
apps/
  web/                  Vite + React：pnpm start 的 localhost 版
    plugins/            git-snapshot：執行 git log、監看 .git refs，經 HMR 推送新快照（virtual:git-snapshot）；掃描本機 repo、依 id 提供快照
    src/                SourceBar（本機 / GitHub 切換、本機 repo 選單）、TokenDialog、useGraphSource、localRepos
  extension/            Chrome（MV3）：只有建置入口、圖示產生器與 e2e，原始碼都在 libs/extension-core
  extension-firefox/    Firefox（MV3）：建置入口、web-ext 的 lint / package / run、e2e（puppeteer + 真實 Firefox）
libs/
  extension-core/       兩個瀏覽器共用的 extension：background、content script（Shadow DOM 掛載 FAB + overlay）、options 頁、
                        建置（content/background 打成 IIFE）與 manifest 產生器、圖示
  graph-core/           純 TS、零相依：型別、lane 配置演算法、GitHub REST client、git log 解析、demo 資料
  graph-ui/             three.js 場景 + React viewer（extension 與 web app 共用）
tools/e2e/              e2e 共用：Chrome 偵測、mock GitHub API（含 CORS）、假的 GitHub 頁面、截圖像素判斷
```

- `graph-core` / `graph-ui` 以 `exports → src/index.ts` 提供原始碼，由使用端 bundler 編譯，不需獨立 build；`extension-core` 例外：它是建置工具 + 原始碼套件（`exports` 為 `./build`、`./manifest`、`./icons`），由兩個 extension app 呼叫。
- `graph-core` 是 **Node 可直接執行的 TS**（相對 import 帶 `.ts`、`erasableSyntaxOnly`），所以 `vite.config.ts` 與腳本能直接 import 它。
- UI/UX 全部在 `graph-ui`（`GitGraphViewer`），web app 與 extension 只負責資料來源與外框。
- 兩個瀏覽器版本的原始碼是同一份（`libs/extension-core`）；差異只在 manifest（`createManifest({ target })`）與 vite 轉譯目標，manifest 有單元測試鎖住。
- Nx 的 `build` 快取已把 `AGG_*` 環境變數算進 hash（它們會改變產物），所以 dev / e2e 的建置不會被當成正式版從快取還原；`pnpm --filter … build` 本來就繞過 Nx。

## 運作原理

1. **資料**：background 以 GitHub REST API 抓 repo → default branch + 目前瀏覽的 branch + open PR 分支（其餘依序補到上限，預設 5 條），
   各抓最近 60 筆 commit，以 sha 合併成 DAG，另抓 tags。約 `分支數 + 4` 次請求，結果快取 10 分鐘（`chrome.storage.local`）。
2. **佈局**（`graph-core/layout.ts`）：children-first 拓樸排序 → 類 `git log --graph` 的 lane 配置；
   列 = 排序後的位置（0 = 最新）、欄 = lane（default branch 固定在第 0 欄）；每條 lane 有固定顏色；
   邊先沿自己的 lane 垂直走，只在靠近 parent 的一列以 S 曲線轉進它的 lane，避免穿過其他節點。
   `graph-core/insights.ts` 提供統計、可到達性（「包含於哪些 branch」、領先幾個 commit）與搜尋。
3. **繪圖**（`graph-ui/scene`）：正交相機 + `MeshToonMaterial`（3 階色）+ inverted-hull 描邊；
   表情、腮紅、皇冠等以 canvas 貼圖；管線用自製 ribbon geometry + shader（描邊 / 流動箭頭 `>` / reveal 動畫）。
   一個 WebGL canvas 只畫「可視範圍 + 上下緩衝」的**視窗**（400 列 × 44px 會超過貼圖上限），而且放在**捲動內容裡面**、
   和 DOM 列一起由合成器捲動，所以線圖與文字列永遠對齊、不會有一個 frame 的錯位；捲到緩衝快用完才重新定位並重畫。
   hover / 選取 / 搜尋淡化都由 DOM 列驅動，canvas 只負責畫（`pointer-events: none`）。
   進場由上往下依序彈出（只播目前可視範圍）；有新 commit 時，只有可視範圍附近的新球彈出來。
4. 尊重 `prefers-reduced-motion`（略過進場與閒置晃動）；分頁隱藏時暫停渲染。

## Token 與安全性

- 未登入每小時 60 次 API；到設定頁加入 **fine-grained PAT** 可提升到 5,000 次並讀取私有 repo。
- 請只授與目標 repo 的 `Contents: Read-only` + `Metadata: Read-only`，**不要用有寫入權限的 token**。
- Token 只存在 extension 的本機儲存空間（`storage.local`），只有 background 讀取、只以 `Authorization` header 送往 `api.github.com`；
  content script / 頁面 DOM 看不到（e2e 有驗證）。更換 token 會清除快取。
- 權限最小化：`storage` + `https://api.github.com/*`；content script 只匹配 `https://github.com/*`，非 repo 頁面不渲染任何東西（Chrome 與 Firefox 相同）。
- commit 訊息等外部字串只經 React text node 與 canvas 繪製，無 `innerHTML`。

## 已知限制

- 只顯示最近約 60 筆 × 分支數的歷史，更早的以「… 歷史已省略」標示；超大 repo 不會是完整圖。
- 未登入時額度很小，連續開多個 repo 會遇到 rate limit（畫面會提示，並可跳到設定頁）。
- GitHub 來源目前只支援 github.com（不含 GitHub Enterprise、GitLab）；本機來源則任何 git repo 都可以。
- web app 的本機快照預設讀最近 300 筆 commit、最多 8 條 branch（可用環境變數調整）。
- 本機 repo 選單只在 `pnpm start`（dev server）時有；靜態建置只有建置當下的預設 repo。Chrome / Firefox extension 讀的是 GitHub，不能選本機 repo。
- 瀏覽器無法取得資料夾的實際路徑，所以「開啟其他路徑」要自己輸入路徑，沒有原生的資料夾選擇視窗。
- 動畫在無 GPU 的環境（軟體 WebGL）會明顯掉幀，屬預期。
- lane 非常多（例如一次顯示十幾條長期並行的 branch）時，手機上線圖欄會被壓縮到最小間距、仍可能佔掉不少寬度。
- 沒有橫向模式 / 自由縮放：這是刻意的，換來的是一致的捲動、搜尋與 RWD。
- Firefox 版：只在 Linux + Firefox 157 實機驗證；Firefox 140（最低支援版本）、macOS / Windows、Android 沒有實測。
