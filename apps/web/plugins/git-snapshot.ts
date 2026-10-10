import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, readdirSync, statSync, watch } from 'node:fs';
import type { Dirent, FSWatcher } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin, ViteDevServer } from 'vite';
import {
  GIT_LOG_FORMAT,
  GIT_REF_FORMAT,
  buildGitGraphData,
  parseForEachRef,
  selectRefs,
} from '@adorable/graph-core';
import {
  DEFAULT_REPO,
  GIT_ENDPOINT,
  HMR_EVENT,
  MAX_DEPTH,
  REPOS_ENDPOINT,
  SNAPSHOT_ENDPOINT,
  STATUS_ENDPOINT,
  isRepoId,
  snapshotKey,
} from '../src/protocol.ts';
import type {
  GitAction,
  GitActionErrorCode,
  GitActionResult,
  GitSnapshot,
  LocalRepo,
  RepoStatus,
  ReposResponse,
  SnapshotErrorCode,
  SnapshotEvent,
  WorktreeInfo,
} from '../src/protocol.ts';

export type { GitSnapshot };
export { snapshotKey };

const execFileAsync = promisify(execFile);

export interface SnapshotOptions {
  /** 預設：環境變數 AGG_REPO_DIR，否則為執行 vite 的目錄（git 會自動往上找 repo 根）。 */
  repoDir?: string;
  /** 最多讀幾筆 commit。預設 300（環境變數 AGG_MAX_COMMITS）。 */
  maxCommits?: number;
  /** 最多畫幾條 branch。預設 8（環境變數 AGG_MAX_BRANCHES）。 */
  maxBranches?: number;
  /** 明確指定 default branch（環境變數 AGG_DEFAULT_BRANCH）。 */
  defaultBranch?: string;
  /** 安全網：每隔幾毫秒比對一次 ref 清單（0 = 關閉）。預設 2000。 */
  pollMs?: number;
  /** 細節（可能含本機路徑）只往這裡送，絕不放進快照。 */
  onWarn?: (message: string) => void;
  /**
   * dev 時畫面上「選擇本機 repo」清單要掃描的資料夾。
   * 預設：環境變數 AGG_REPO_ROOTS（以 `path.delimiter` 分隔，可用 `~`），否則為預設 repo 的上一層（也就是它的兄弟資料夾）。
   */
  repoRoots?: string[];
  /** 從每個根目錄往下找幾層。預設 3（環境變數 AGG_REPO_SCAN_DEPTH）。 */
  scanDepth?: number;
  /**
   * 記住「開啟其他路徑…」加入的 repo 的檔案（dev server 重新啟動後清單裡還在）。`false` = 不記。
   * 預設：環境變數 AGG_LOCAL_REPOS_FILE，否則放在使用者的 state 目錄（Vite 不會提供的地方）：
   * `$XDG_STATE_HOME`（預設 `~/.local/state`）或 Windows 的 `%LOCALAPPDATA%` 底下的
   * `adorable-git-graph/local-repos-<這個專案路徑的雜湊>.json`。
   */
  stateFile?: string | false;
  /** 非預設 repo 多久沒有人要快照就停止監看。預設 10 分鐘（主要是給測試調短用）。 */
  idleMs?: number;
  /**
   * git 寫入動作（GIT_ENDPOINT）的時限，超過就連同子行程一起結束。
   * 預設：會連網路的動作（fetch / pull / push / tag push）120 秒，其他 10 分鐘（主要是給測試調短用）。
   */
  actionTimeoutMs?: number;
}

/**
 * 預設的 state 檔位置。不能放在專案裡（例如 node_modules/.cache）：那在 Vite 的 root / fs.allow 底下，
 * `vite --host` 時區網裡的裝置可以直接把它當靜態檔案讀走。
 */
export function defaultStateFile(root: string): string | false {
  // 相對路徑一律不算（XDG 規範也這麼要求）：會變成相對於 cwd，也就是 Vite 的 root
  const abs = (p: string | undefined) => (p && isAbsolute(p) ? p : undefined);
  const home = abs(homedir());
  const base =
    process.platform === 'win32'
      ? (abs(process.env['LOCALAPPDATA']) ?? (home && join(home, 'AppData', 'Local')))
      : (abs(process.env['XDG_STATE_HOME']) ?? (home && join(home, '.local', 'state')));
  if (!base) return false; // 沒有安全的位置：不記
  const project = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  return join(base, 'adorable-git-graph', `local-repos-${project}.json`);
}

const intFromEnv = (name: string): number | undefined => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 預設最多讀幾筆 commit（畫面捲到底時可以再要更多，見 RepoSession.want）。 */
const defaultMaxCommits = (opts: SnapshotOptions): number =>
  opts.maxCommits ?? intFromEnv('AGG_MAX_COMMITS') ?? 300;

let gitBinary: { path: string | undefined; bin: string | null } | undefined;

/**
 * git 執行檔的絕對路徑（只在 PATH 的絕對路徑項目裡找）。
 * 不能直接執行 `'git'`：cwd 是使用者選的 repo，Windows 的 libuv 會先在 cwd 找 `git.exe`，
 * POSIX 的 PATH 若含空字串或相對路徑也會在 cwd 找——選到一個放了 git 執行檔的 repo 就會執行它。
 */
export function findGit(): string | null {
  const path = process.env['PATH'];
  if (gitBinary && gitBinary.path === path) return gitBinary.bin;
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  let bin: string | null = null;
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      // resolve：Windows 的 `\\bin` 這種只有根目錄的項目也算 isAbsolute，執行時卻會依 cwd 的磁碟機解析
      bin = resolve(file);
      break;
    } catch {
      /* 不在這裡 */
    }
  }
  gitBinary = { path, bin };
  return bin;
}

/**
 * 指向「某一個 repo」的變數（git 自己的清單：`git rev-parse --local-env-vars`）：dev server 若繼承了它們
 * （從 git hook 啟動、shell 為 dotfiles 匯出 GIT_DIR…），選單裡每個 repo 都會變成同一個。
 * GIT_CEILING_DIRECTORIES 之類限制「往上找」的設定是使用者刻意的，保留。
 */
const REPO_LOCATING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
];

function gitEnv(): NodeJS.ProcessEnv {
  // 唯讀操作也避免 index 鎖，LC_ALL 讓輸出格式（含錯誤訊息）穩定
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const name of REPO_LOCATING_ENV) delete env[name];
  return env;
}

/** 不經 shell（execFile），參數全是我們組出來的 ref 名稱，不會被當成選項。 */
async function git(cwd: string, args: string[]): Promise<string> {
  const bin = findGit();
  if (!bin) throw Object.assign(new Error('git is not installed'), { code: 'ENOENT' });
  // `-C` 而不是 spawn 的 cwd：spawn 會等子行程 chdir 完才回來，目錄在卡住的網路磁碟上時整個 dev server 會跟著停住；
  // 交給 git 自己 chdir，卡住的只有那個子行程（60 秒後被砍掉）
  const { stdout } = await execFileAsync(bin, ['-C', cwd, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    // 網路磁碟卡住等：不要讓 git 子行程與等待中的請求永遠掛著
    timeout: 60_000,
    env: gitEnv(),
  });
  return stdout;
}

const gitOrUndefined = (cwd: string, args: string[]) =>
  git(cwd, args).then(
    (s) => s.trim() || undefined,
    () => undefined,
  );

class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(message: string, code: SnapshotErrorCode) {
    super(message);
    this.code = code;
  }
}

/** repo 的位置（工作樹的根；bare repo 則是 git 目錄本身）與顯示名稱。 */
async function resolveRepo(repoDir: string): Promise<{ dir: string; name: string }> {
  try {
    const top = (await git(repoDir, ['rev-parse', '--show-toplevel'])).trim();
    return { dir: top, name: basename(top) };
  } catch (err) {
    // ENOENT 也可能是 cwd 剛好不見了：只有真的找不到 git 才說沒安裝
    if (findGit() === null) throw new SnapshotError('git is not installed', 'no_git');
    // git ≥ 2.35.2 拒絕別的使用者擁有的 repo（外接硬碟、WSL / Docker 掛載…）。不要自己加 safe.directory：那是在防 repo 裡的設定
    if (/detected dubious ownership/.test(String((err as { stderr?: unknown }).stderr ?? '')))
      throw new SnapshotError(
        'Git refused to open this repository because it is owned by another user (see git config safe.directory).',
        'unsafe_repo',
      );
  }
  const gitDir = await gitOrUndefined(repoDir, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir)
    throw new SnapshotError('The configured directory is not inside a git repository.', 'not_git');
  // bare：.../project.git；在 .git 內：.../project/.git
  const named = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
  const name = basename(named).replace(/\.git$/, '') || 'repository';
  // linked worktree 的 git 目錄（<main>/.git/worktrees/<wt>、<bare>.git/worktrees/<wt>）：gitdir 檔記著工作樹的 .git。
  // 要在 bare 判斷之前：main 是 bare repo 時，共用設定的 core.bare=true 會讓這裡也被當成 bare
  const [linked, common] = await Promise.all(
    ['gitdir', 'commondir'].map((file) =>
      readFile(join(gitDir, file), 'utf8').then(
        (s) => s.trim(),
        () => '',
      ),
    ),
  );
  if (linked && common) {
    const top = await gitOrUndefined(dirname(resolve(gitDir, linked)), [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (top) return { dir: top, name: basename(top) };
  }
  // 指到 git 目錄裡面（<repo>/.git、<bare>.git/refs…）時回傳 repo 本身的位置：清單與 id 才不會重複
  const bare = (await gitOrUndefined(repoDir, ['rev-parse', '--is-bare-repository'])) === 'true';
  if (bare) return { dir: gitDir, name };
  if (basename(gitDir) === '.git') {
    const top = await gitOrUndefined(dirname(gitDir), ['rev-parse', '--show-toplevel']);
    if (top) return { dir: top, name: basename(top) };
  }
  // 其他非 bare 的 git 目錄（--separate-git-dir 等）：用 git 目錄本身，裡面任何路徑都收斂成同一筆
  return { dir: gitDir, name };
}

export async function readGitSnapshot(
  repoDir: string,
  opts: SnapshotOptions = {},
): Promise<GitSnapshot> {
  const generatedAt = Date.now();
  // 錯誤訊息會被烤進 bundle / 經由 endpoint 送出，所以一律不含本機路徑；細節給 onWarn（終端機）。
  // transient：git 自己出錯（gc / fetch 進行中等），保留上一張好的圖；其餘是確定的失敗，要如實顯示。
  const fail = (error: string, code: SnapshotErrorCode, transient = false): GitSnapshot => ({
    graph: null,
    error,
    code,
    generatedAt,
    ...(transient ? { transient: true } : {}),
  });
  // 非同步且有時限：使用者選的路徑可能在卡住的網路磁碟上
  const probe = stalledDirs.has(repoDir)
    ? 'timeout'
    : await within(repoDir, stat(repoDir), STALL_MS).then(
        (r) => (r === 'timeout' ? 'timeout' : 'ok'),
        (err: { code?: string }) =>
          err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'ok',
      );
  if (probe === 'missing')
    return fail('The configured repository directory does not exist.', 'missing_dir');
  if (probe === 'timeout')
    return fail('The repository folder is not responding (a network drive?).', 'git_error', true);

  try {
    const { dir, name } = await resolveRepo(repoDir);
    const maxCommits = defaultMaxCommits(opts);
    const maxBranches = opts.maxBranches ?? intFromEnv('AGG_MAX_BRANCHES') ?? 8;

    const [refsText, originHead, currentBranch, remoteUrl, shallow] = await Promise.all([
      git(dir, [
        'for-each-ref',
        '--sort=-committerdate',
        `--format=${GIT_REF_FORMAT}`,
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ]),
      gitOrUndefined(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
      gitOrUndefined(dir, ['branch', '--show-current']),
      gitOrUndefined(dir, ['config', '--get', 'remote.origin.url']),
      gitOrUndefined(dir, ['rev-parse', '--is-shallow-repository']),
    ]);

    const allRefs = parseForEachRef(refsText);
    const selected = selectRefs(allRefs, {
      defaultBranch: opts.defaultBranch ?? process.env['AGG_DEFAULT_BRANCH'],
      originHead,
      currentBranch,
      maxBranches,
    });

    // branch 一個都沒有（CI 的 detached HEAD 等）時改從 HEAD 往回走
    const logRefs = selected.logRefs.length
      ? selected.logRefs
      : (await gitOrUndefined(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']))
        ? ['HEAD']
        : [];

    // 先把選好的 ref 解析成 sha，再交給 git log：避免讀取途中 ref 移動造成「branch 標籤落後最新 commit」的不一致快照
    const tips = selected.refs.length ? [...new Set(selected.refs.map((r) => r.sha))] : logRefs;
    const logArgs = (n: number, starts: string[]) => [
      // 使用者的 git 設定不能影響輸出：log.showSignature 會在每筆前塞 gpg 輸出，
      // i18n.logOutputEncoding 非 UTF-8 時作者名與標題會變成亂碼
      '-c',
      'log.showSignature=false',
      '-c',
      'i18n.logOutputEncoding=UTF-8',
      'log',
      '-z',
      '--no-show-signature',
      '--date-order',
      `--format=${GIT_LOG_FORMAT}`,
      '-n',
      String(n),
      ...starts,
      '--',
    ];
    let logText = tips.length ? await git(dir, logArgs(maxCommits, tips)) : '';
    // 其他 branch 很活躍時，default / 目前 branch 的 tip 可能比「最新 N 筆」還舊而整個被擠掉
    // （圖上就沒有 default 的小球與皇冠）：另外保證它們各自最近的一段一定讀得到。
    const guaranteed = selected.refs
      .filter((r) => r.isDefault || r.name === currentBranch)
      .map((r) => r.sha);
    if (logText) {
      // `git log -n` は複数の起点をまとめて数えるので、起点ごとに別々に取らないと保証にならない
      for (const sha of new Set(guaranteed)) {
        logText += await git(dir, logArgs(Math.min(maxCommits, 60), [sha]));
      }
    }

    const graph = buildGitGraphData({
      logText,
      selected,
      allRefs,
      remoteUrl,
      fallbackName: name,
      currentBranch,
    });
    // shallow clone 的邊界 commit 看起來像 root：至少要讓畫面標示「更早的歷史已省略」
    if (shallow === 'true') graph.truncated = true;
    return { graph, generatedAt };
  } catch (err) {
    if (err instanceof SnapshotError) return fail(err.message, err.code);
    opts.onWarn?.(
      `could not read git history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fail('Could not read the git history (git reported an error).', 'git_error', true);
  }
}

/** ref 清單 + HEAD 的簽章：很便宜，用來偵測「有沒有變」。 */
async function refsSignature(repoDir: string): Promise<string> {
  const [refs, head, sym] = await Promise.all([
    gitOrUndefined(repoDir, ['for-each-ref', '--format=%(refname) %(objectname)']),
    gitOrUndefined(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    gitOrUndefined(repoDir, ['symbolic-ref', '--quiet', 'HEAD']),
  ]);
  return `${refs ?? ''}\n${head ?? ''}\n${sym ?? ''}`;
}

/**
 * 監看 git 目錄中會影響圖的檔案（HEAD、packed-refs、refs/**）。
 *
 * 不用 `fs.watch(..., { recursive: true })`：git 以「寫 .lock 再 rename 蓋掉原檔」更新 ref，
 * Node 在 Linux 的遞迴實作是逐 inode 監看，被蓋掉的檔案之後就不再通知，第二次 commit 起就收不到事件。
 * 監看「目錄」則能看到 rename 進來的新檔，所以改成逐層非遞迴監看目錄，遇到新目錄就補上。
 */
export function watchGitRefs(
  gitDirs: string[],
  onChange: () => void,
  /** 最多監看幾個目錄（inotify 是全使用者共用的額度）；超過的交給輪詢安全網。 */
  maxDirs = 512,
): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const drop = (dir: string) => {
    watchers.get(dir)?.close();
    watchers.delete(dir);
  };

  /** `replace`：同名目錄可能被刪掉又重建（git gc / pack-refs / branch 刪除重建）。核心會悄悄丟掉舊 inode 的監看，所以要換新的。 */
  const add = (
    dir: string,
    handler: (event: string, filename: string | null) => void,
    replace = false,
  ) => {
    if (closed) return;
    if (watchers.has(dir)) {
      if (!replace) return;
      drop(dir);
    }
    if (watchers.size >= maxDirs) return;
    try {
      const w = watch(dir, { persistent: false }, (event, filename) =>
        handler(event, filename ? String(filename) : null),
      );
      w.on('error', () => drop(dir));
      watchers.set(dir, w);
    } catch {
      /* 目錄消失 / 達到 inotify 上限：交給輪詢安全網 */
    }
  };

  const watchTree = (dir: string, replace = false, root = false) => {
    // 只走真的目錄：git 不會在 refs 底下建 symlink，跟著連結走可能把整個磁碟同步讀一遍（輪詢會補上其餘的變化）。
    // 例外是 <gitDir>/refs 本身（git-new-workdir 之類的佈局會把它做成 symlink），它底下的仍然不跟。
    try {
      if (!(root ? statSync : lstatSync)(dir).isDirectory()) return;
    } catch {
      return;
    }
    add(
      dir,
      (event, filename) => {
        if (filename) {
          const child = join(dir, filename);
          try {
            if (lstatSync(child).isDirectory()) watchTree(child, event === 'rename');
          } catch {
            drop(child); // 已被刪除：放掉舊的監看，之後重建時才會重新加上
          }
        }
        onChange();
      },
      replace,
    );
    // 超過上限（或監看失敗）就不再往下走
    if (!watchers.has(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchTree(join(dir, entry.name), replace);
      }
    } catch {
      /* ignore */
    }
  };

  for (const gitDir of gitDirs) {
    add(gitDir, (_event, filename) => {
      if (filename === null || filename === 'HEAD' || filename === 'packed-refs') onChange();
      if (filename === 'refs') watchTree(join(gitDir, 'refs'), true, true);
    });
    watchTree(join(gitDir, 'refs'), false, true);
  }

  return () => {
    closed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

// ───────────────────────── 本機 repo 清單（dev server 的 repo 選擇器） ─────────────────────────

/** 不往裡面找的資料夾：套件 / 建置產物 / 系統目錄（另外所有 `.` 開頭的資料夾也都略過）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'tmp',
  'temp',
  'Library',
  'AppData',
  'Applications',
  'System',
  'Windows',
  'proc',
  'sys',
  'dev',
  'snap',
]);

export interface DiscoverOptions {
  /** 從根目錄往下找幾層（根目錄本身是第 0 層）。預設 3。 */
  maxDepth?: number;
  /** 最多讀幾個資料夾。預設 5000。 */
  maxDirs?: number;
  /** 最多回報幾個 repo。預設 300。 */
  maxRepos?: number;
  /** 掃描的時間上限（毫秒）。預設 3000。 */
  timeBudgetMs?: number;
}

/**
 * 卡住的目錄（掛掉的網路磁碟等）：之後的掃描直接略過，等它哪天回應了才恢復。
 * 卡住的 fs 呼叫會一直佔著一條 libuv 執行緒（預設只有 4 條，Vite 讀檔也靠它們），所以同時最多容忍 MAX_STALLED 個，
 * 超過就不再冒險開新的 readdir（這次掃描到此為止，清單沿用上一次的結果）。
 */
const stalledDirs = new Set<string>();
const STALL_MS = 1000;
const MAX_STALLED = 2;

/** 最多等 `ms`：網路磁碟卡住時 fs 呼叫可能永遠不回來，不能讓整個掃描（和等它的請求）跟著卡住。 */
async function within<T>(key: string, op: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((ok) => {
    timer = setTimeout(ok, Math.max(0, ms), 'timeout');
  });
  try {
    const result = await Promise.race([op, timeout]);
    if (result === 'timeout') {
      stalledDirs.add(key);
      op.then(
        () => stalledDirs.delete(key),
        () => stalledDirs.delete(key),
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

const isBareRepo = (entries: Dirent[]) => {
  const has = (name: string, dir: boolean) =>
    entries.some((e) => e.name === name && (dir ? e.isDirectory() : e.isFile()));
  return has('HEAD', false) && has('objects', true) && has('refs', true);
};

/**
 * 找出 roots 底下的 git repository（一般 repo、worktree、`*.git` 的 bare repo）。
 * 只看資料夾裡有沒有 `.git`：不執行 git（不會碰到陌生 repo 的設定）、不跟隨 symlink、不往 repo 裡面找（submodule 等）。
 * 所有 fs 呼叫都是非同步且有時限的（不會卡住 dev server）。回傳排序過的 realpath；碰到上限就停下並標記 truncated。
 */
export async function discoverRepos(
  roots: string[],
  opts: DiscoverOptions = {},
): Promise<{ repos: string[]; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 5000;
  const maxRepos = opts.maxRepos ?? 300;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 3000);
  let truncated = false;
  /** 還能不能再發一個可能卡住的 fs 呼叫；不行就停在這裡 */
  const budget = (): number => {
    const left = Math.min(STALL_MS, deadline - Date.now());
    return left > 0 && stalledDirs.size < MAX_STALLED ? left : 0;
  };
  /** `listOnly`：只看它本身是不是 repo，不往裡面找（名字叫 build / tmp / vendor… 的資料夾） */
  const queue: Array<{ dir: string; depth: number; listOnly?: boolean }> = [];
  for (const root of roots) {
    const ms = budget();
    if (!ms || stalledDirs.has(root)) {
      truncated = true;
      continue;
    }
    const dir = await within(root, realpath(root), ms).catch(() => null);
    if (dir === 'timeout') truncated = true;
    // 不存在 / 卡住 / 整個磁碟（/、C:\）：略過
    else if (dir && parse(dir).root !== dir) queue.push({ dir, depth: 0 });
  }
  const found = new Set<string>();
  const seen = new Set<string>();
  const listed = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const ms = budget();
    if (seen.size >= maxDirs || found.size >= maxRepos || !ms) {
      truncated = true;
      break;
    }
    const { dir, depth, listOnly } = queue[i]!;
    if (seen.has(dir) || listed.has(dir)) continue;
    if (stalledDirs.has(dir)) {
      truncated = true;
      continue;
    }
    if (listOnly) {
      // 只看 <dir>/.git 在不在（不讀整個 node_modules / vendor，也不算進 maxDirs）
      listed.add(dir);
      const git = await within(dir, stat(join(dir, '.git')), ms).catch(() => null);
      if (git === 'timeout') truncated = true;
      else if (git && found.size < maxRepos) found.add(dir);
      continue;
    }
    seen.add(dir);
    const entries = await within(dir, readdir(dir, { withFileTypes: true }), ms).catch(() => null);
    if (entries === 'timeout') truncated = true;
    if (!entries || entries === 'timeout') continue;
    if (entries.some((e) => e.name === '.git') || (dir.endsWith('.git') && isBareRepo(entries))) {
      found.add(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      // Dirent.isDirectory() 對 symlink 是 false：不會被連結帶到範圍外或繞圈
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      // 名字剛好叫 build / tmp / vendor… 的 repo 還是要列出來，只是不往裡面找
      queue.push({ dir: join(dir, e.name), depth: depth + 1, listOnly: SKIP_DIRS.has(e.name) });
    }
  }
  return { repos: [...found].sort(), truncated };
}

/** 瀏覽器只拿得到這個 id（realpath 的短雜湊）：選 repo 時只送 id，永遠不會把路徑送回 server。 */
export const repoIdFor = (realDir: string): string =>
  createHash('sha256').update(realDir).digest('hex').slice(0, 12);

const expandHome = (p: string): string =>
  p === '~' ? homedir() : /^~[/\\]/.test(p) ? join(homedir(), p.slice(2)) : p;

/** 顯示用：家目錄縮寫成 `~`。 */
const labelFor = (dir: string): string => {
  const home = homedir();
  return dir === home ? '~' : dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
};

const rootsFromEnv = (): string[] | undefined => {
  const raw = process.env['AGG_REPO_ROOTS']?.trim();
  return raw
    ? raw
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
};

interface SessionHooks {
  options: SnapshotOptions;
  warn: (message: string) => void;
  /** 內容有變（新 commit / checkout / fetch…）時呼叫。第一次讀取不算。 */
  onUpdate: (snap: GitSnapshot) => void;
}

/** 一個 repo 的快照與監看：讀取 → 比較 → 有變才通知。 */
class RepoSession {
  last: GitSnapshot | undefined;
  private key: string | undefined;
  private staleWarned = false;
  private inflight: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  /** 監看已經裝好了（start 時 repo 還打不開，例如 safe.directory，就要等能讀了再裝一次） */
  private watching = false;
  private starting: Promise<void> | undefined;
  private teardown: () => void = () => {};
  /** 畫面要求過的 commit 數（infinite scroll）。之後的讀取與 HMR 推送都讀 max(預設, depth) 筆。 */
  private depth = 0;
  readonly dir: string;
  private readonly hooks: SessionHooks;

  constructor(dir: string, hooks: SessionHooks) {
    this.dir = dir;
    this.hooks = hooks;
  }

  /** 往更早的歷史多讀一些：只增不減（停止監看後重新開啟的 session 會回到預設）。 */
  want(depth: number): void {
    this.depth = Math.max(this.depth, depth);
  }

  async read(): Promise<GitSnapshot> {
    const snap = await readGitSnapshot(this.dir, {
      ...this.hooks.options,
      maxCommits: Math.max(defaultMaxCommits(this.hooks.options), this.depth),
      onWarn: this.hooks.warn,
    });
    if (snap.graph) this.staleWarned = false;
    // 暫時性的 git 錯誤（例如 gc / fetch 進行中）不要把好好的畫面換成錯誤頁；
    // 目錄不見、不是 repo 這類確定的失敗則如實顯示（否則畫面會永遠停在舊圖，使用者還看不出來）。
    if (!snap.graph && snap.transient && this.last?.graph) {
      if (!this.staleWarned)
        this.hooks.warn('keeping the last good snapshot until git can be read again');
      this.staleWarned = true;
      return this.last;
    }
    this.last = snap;
    return snap;
  }

  /** 一次只跑一個；執行中又來要求就在結束後再跑一輪（不漏）。 */
  sync(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          const snap = await this.read();
          if (snap.graph && !this.watching && !this.stopped && this.startedOnce) void this.start();
          const next = snapshotKey(snap);
          if (next === this.key) continue;
          const first = this.key === undefined;
          this.key = next;
          if (!first && !this.stopped) this.hooks.onUpdate(snap);
        } while (this.again);
      } catch (err) {
        this.hooks.warn(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private startedOnce = false;

  /** 監看 .git（HEAD、packed-refs、refs/**），外加輪詢 ref 簽章的安全網。可以重複呼叫：裝好了就什麼都不做。 */
  start(): Promise<void> {
    this.startedOnce = true;
    if (this.watching || this.stopped) return Promise.resolve();
    return (this.starting ??= this.startOnce().finally(() => {
      this.starting = undefined;
    }));
  }

  private async startOnce(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let stopWatching = () => {};
    this.teardown = () => {
      clearTimeout(timer);
      clearTimeout(poll);
      stopWatching();
    };
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.sync(), 250);
    };
    try {
      const dirs = [
        ...new Set(
          (
            await Promise.all([
              git(this.dir, ['rev-parse', '--absolute-git-dir']),
              git(this.dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
            ])
          ).map((s) => s.trim()),
        ),
      ];
      if (this.stopped) return;
      stopWatching = watchGitRefs(dirs, onChange);
      this.watching = true;

      // 安全網：檔案監看可能漏事件（網路磁碟、inotify 上限…），偶爾比對一次 ref 簽章
      // 一次只跑一輪：上一輪的 git 還沒回來（網路磁碟很慢）就不要再疊新的行程
      const pollMs = this.hooks.options.pollMs ?? 2000;
      if (pollMs > 0) {
        let sig = await refsSignature(this.dir);
        const tick = () => {
          if (this.stopped) return;
          poll = setTimeout(() => {
            void refsSignature(this.dir).then((next) => {
              if (next !== sig) {
                sig = next;
                void this.sync();
              }
              tick();
            });
          }, pollMs);
          poll.unref();
        };
        tick();
      }
    } catch {
      // 不是 git repo：沒東西可監看，endpoint 仍可手動重抓
    }
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }
}

/** 只回應這台電腦上的請求（`vite --host` 時，區網裡的其他裝置不能列出 / 讀取 / 加入其他 repo）。 */
export const isLoopback = (req: IncomingMessage): boolean => {
  const address = req.socket?.remoteAddress ?? '';
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
};

/** Windows 的 UNC / 裝置路徑（`\\server\share`、`\\?\`、`//host/x`）：realpath 會去連網路主機，一律不接受。 */
const isRemotePath = (p: string): boolean => /^[\\/]{2}/.test(p);

interface RepoEntry extends LocalRepo {
  dir: string;
}

const toPublic = ({ id, name, label, isDefault }: RepoEntry): LocalRepo => ({
  id,
  name,
  label,
  isDefault,
});

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body ?? null));
};

/**
 * 只回應同源頁面；`direct` 時也允許沒有 fetch metadata 的直接請求（網址列、curl）。
 * 其他 localhost 埠上的頁面不能偷看本機 commit、未推送的 branch 與資料夾位置。
 * 偽造的 Host（DNS rebinding）在進到這裡之前就會被 Vite 自己的 host 檢查擋掉。
 */
export function isSameOrigin(req: IncomingMessage, direct: boolean): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || (direct && site === 'none');
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  return direct;
}

/**
 * 讀取 request body（最多 `limit` bytes）。超過時丟掉其餘內容、讀完才回報錯誤，413 才送得到瀏覽器
 * （馬上 destroy 會連 socket 一起關掉，瀏覽器只會看到連線被重設）；大得離譜（> 1 MB）才直接斷線。
 */
const readBody = (req: IncomingMessage, limit: number) =>
  new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > 1024 * 1024) req.destroy();
    });
    req.on('end', () =>
      size > limit
        ? fail(new Error('request body too large'))
        : ok(Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', fail);
    req.on('close', () => fail(new Error('request aborted')));
  });

/**
 * Host 必須是這台電腦的名字（localhost、*.localhost、127.x.x.x、[::1]）。
 * Vite 自己的 host 檢查本來就會擋掉 DNS rebinding；會改動 repo 的 endpoint 再多一層，不依賴它的設定（`server.allowedHosts`）。
 */
export const isLocalHost = (req: IncomingMessage): boolean => {
  const host = req.headers.host ?? '';
  // 只有主機名稱與埠（`user@host`、路徑之類的會讓 URL 解析出另一個主機名稱）
  if (!/^[a-z0-9.-]+(?::\d+)?$|^\[[0-9a-f:.]+\](?::\d+)?$/i.test(host)) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(name) ||
    name === '[::1]'
  );
};

// ───────────────────────── git 動作（GIT_ENDPOINT）與 repo 狀態（STATUS_ENDPOINT） ─────────────────────────
//
// 安全規則（只有 dev server、只回應本機同源的 JSON POST；靜態建置與擴充功能都沒有這些）：
// - 只組固定的參數：使用者給的字串只會出現在驗證過的位置（ref 名稱先過 `git check-ref-format`、commit-ish 先用
//   `rev-parse --verify` 解析成 sha、路徑一律是絕對路徑），git 允許的地方都先放 `--`，絕不會被當成選項。
// - pull 只做 fast-forward（`--ff-only`，不會產生 merge commit 或衝突）；push 只推目前的 branch、絕不 force；
//   worktree remove 不加 `--force`（有修改就拒絕）。push / stash drop / tag 刪除 / worktree 移除要帶 `confirm: true`。
// - 會連網路的指令不互動：GIT_TERMINAL_PROMPT=0、GCM_INTERACTIVE=never、detached（沒有 controlling tty，ssh 無法在
//   dev server 的終端機上要密碼），而且有時限。回傳給瀏覽器的輸出去掉 ANSI、遮掉網址裡的帳密、只留最後 4 KB。
// - git hook（pre-push、post-checkout…）照常執行，與使用者在終端機裡下同一個指令完全一樣。
// - 同一個 repo（含它所有的 worktree）一次只跑一個動作，其餘回 409。

const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 10 * 60_000;
/** 子行程的輸出在記憶體裡最多留多少（只會回傳最後 4 KB，多留一些是為了整理進度列後還有內容） */
const ACTION_OUTPUT_KEEP = 256 * 1024;
const OUTPUT_LIMIT = 4096;
/** 狀態裡最多列幾個 stash / worktree */
const MAX_STASHES = 1000;
const MAX_WORKTREES = 200;

/** 進行中的寫入動作：dev server 關閉、行程結束時連同子行程一起收掉。 */
const runningActions = new Set<ChildProcess>();
let exitHookInstalled = false;

/** 連同 ssh、git-remote-https 等子行程一起結束：detached 的 git 是它自己那個 process group 的 leader。 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* 已經結束 */
  }
}

/**
 * 寫入動作的環境：與終端機裡的 git 相同（使用者設定、hook 都照常），但絕不互動，
 * 也不把追蹤輸出（GIT_TRACE_CURL 等會印出 Authorization header）混進要回傳給瀏覽器的結果。
 */
function actionEnv(): NodeJS.ProcessEnv {
  const env = gitEnv();
  delete env['GIT_OPTIONAL_LOCKS'];
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_TRACE') || name === 'GIT_CURL_VERBOSE') delete env[name];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // `:` 是 git 認得的「不開編輯器」；我們的指令本來就不需要編輯器，這只是保險
    GIT_EDITOR: ':',
    GIT_MERGE_AUTOEDIT: 'no',
  };
}

interface ActionRun {
  /** 結束碼；沒能執行或被訊號結束時是 null */
  code: number | null;
  /** stdout + stderr（依到達順序），還沒整理過 */
  output: string;
  timedOut: boolean;
}

/** 前面的內容被丟掉時從下一行開始：不留下半個網址（遮帳密要看到完整的 `scheme://`）。 */
const fromLineStart = (text: string): string => {
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : text.replace(/^\S*\s*/, '');
};

/**
 * 執行一個 git 寫入動作。不經 shell、stdin 是 /dev/null、detached（POSIX 上是 setsid：沒有 controlling tty，
 * ssh / git 的密碼提示不會卡在跑 dev server 的終端機上，也不會搶走它的輸入），超過時限就結束整個 process group。
 */
function runGitAction(
  cwd: string,
  args: string[],
  timeoutMs: number,
  owned?: Set<ChildProcess>,
): Promise<ActionRun> {
  const bin = findGit();
  if (!bin) return Promise.resolve({ code: null, output: 'git is not installed', timedOut: false });
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, ['-C', cwd, ...args], {
        env: actionEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
    } catch (err) {
      done({
        code: null,
        output: err instanceof Error ? err.message : String(err),
        timedOut: false,
      });
      return;
    }
    runningActions.add(child);
    owned?.add(child);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      // detached 的子行程不會跟著 dev server 結束（Ctrl+C 送不到另一個 session）
      process.once('exit', () => {
        for (const c of runningActions) killGroup(c, 'SIGKILL');
      });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let dropped = false;
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > ACTION_OUTPUT_KEEP && chunks.length > 1) {
        size -= chunks.shift()!.length;
        dropped = true;
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      runningActions.delete(child);
      owned?.delete(child);
      const text = Buffer.concat(chunks).toString('utf8');
      const note = timedOut
        ? `\ngit did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped.`
        : '';
      done({ code, output: (dropped ? fromLineStart(text) : text) + extra + note, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
      // 另開 process group 的孫行程若還握著 pipe，'close' 可能永遠不來：最多再等一下就放棄
      giveUpTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 4000);
    }, timeoutMs);
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

/**
 * 給瀏覽器看的 git 輸出：去掉 ANSI / 控制字元、進度列只留最後的狀態、遮掉網址裡的帳密
 * （`https://user:token@host` → `https://***@host`），只留最後 `limit` 個字元（從完整的一行開始）。
 */
export function sanitizeGitOutput(raw: string, limit = OUTPUT_LIMIT): string {
  let text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC（含終端機超連結）
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI（顏色、游標移動）
    .replace(/\x1b[@-_]?/g, '') // 其他 ESC 序列
    .split('\n')
    // `Receiving objects:  42% (…)\r` 這種進度列：只留每一行最後的狀態
    .map((line) => line.split('\r').filter(Boolean).at(-1) ?? '')
    .join('\n')
    // 其餘控制字元、C1 控制字元與雙向文字控制（避免在畫面上偽造內容）；保留 tab 與換行
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1***@')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > limit) text = `…\n${fromLineStart(text.slice(text.length - (limit - 2)))}`;
  return text;
}

/** `git status --porcelain=v2 --branch -z` → branch / upstream / ahead / behind / 各種變更的數量。 */
export function parseStatusV2(
  text: string,
): Pick<RepoStatus, 'branch' | 'head' | 'upstream' | 'ahead' | 'behind' | 'changes'> {
  const out: ReturnType<typeof parseStatusV2> = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  };
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.startsWith('# ')) {
      const sp = field.indexOf(' ', 2);
      const key = sp < 0 ? field.slice(2) : field.slice(2, sp);
      const value = sp < 0 ? '' : field.slice(sp + 1);
      if (key === 'branch.oid') out.head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') out.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') out.upstream = value || null;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          out.ahead = Number(m[1]);
          out.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = field[0];
    if (kind === '1' || kind === '2') {
      if (field[2] !== '.') out.changes.staged++;
      if (field[3] !== '.') out.changes.unstaged++;
      if (kind === '2') i++; // -z：rename / copy 的原路徑是下一個欄位
    } else if (kind === 'u') out.changes.conflicted++;
    else if (kind === '?') out.changes.untracked++;
  }
  return out;
}

export interface RawWorktree {
  path: string;
  /** HEAD 的 sha（bare 沒有） */
  head: string;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain -z`（舊版 git 沒有 -z 時以換行分隔）。第一筆是主 worktree。 */
export function parseWorktreeList(text: string, separator = '\0'): RawWorktree[] {
  const out: RawWorktree[] = [];
  let current: RawWorktree | undefined;
  for (const line of text.split(separator)) {
    if (!line) {
      current = undefined;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      current = {
        path: value,
        head: '',
        branch: null,
        bare: false,
        locked: false,
        prunable: false,
      };
      out.push(current);
    } else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') current.bare = true;
      else if (key === 'locked') current.locked = true;
      else if (key === 'prunable') current.prunable = true;
    }
  }
  return out;
}

const STASH_FORMAT = '--format=%cI%x1f%gs';

/** `git stash list -z --format=%cI%x1f%gs`：index 依輸出的順序（`stash@{0}` 是第一筆）。 */
export function parseStashList(text: string): RepoStatus['stashes'] {
  return text
    .split('\0')
    .filter(Boolean)
    .slice(0, MAX_STASHES)
    .map((record, index) => {
      const sep = record.indexOf('\x1f');
      const date = sep < 0 ? '' : record.slice(0, sep);
      // 訊息放在最後：裡面就算有 \x1f 也不會錯位
      const message = (sep < 0 ? record : record.slice(sep + 1)).replace(/[\x00-\x1f\x7f]/g, ' ');
      return { index, message, date };
    });
}

const readStashes = (dir: string): Promise<RepoStatus['stashes']> =>
  git(dir, [
    '-c',
    'log.showSignature=false',
    '-c',
    'i18n.logOutputEncoding=UTF-8',
    'stash',
    'list',
    '-z',
    '--no-color',
    STASH_FORMAT,
  ]).then(parseStashList, () => []);

const listWorktrees = (dir: string): Promise<RawWorktree[]> =>
  git(dir, ['worktree', 'list', '--porcelain', '-z'])
    .then((text) => parseWorktreeList(text))
    // git < 2.36 沒有 -z
    .catch(() =>
      git(dir, ['worktree', 'list', '--porcelain']).then((t) => parseWorktreeList(t, '\n')),
    )
    .catch(() => []);

const listRemotes = async (dir: string): Promise<string[]> =>
  ((await gitOrUndefined(dir, ['remote'])) ?? '').split('\n').filter(Boolean);

/** 進行中的操作：看 git 目錄（每個 worktree 自己的）裡的標記檔。`git am` 也用 rebase-apply/，一樣算 rebase。 */
async function operationIn(gitDir: string): Promise<RepoStatus['operation']> {
  const markers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  const [rebaseMerge, rebaseApply, merge, pick, revert, bisect] = await Promise.all(
    [...markers, 'BISECT_LOG'].map((name) =>
      stat(join(gitDir, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (rebaseMerge || rebaseApply) return 'rebase';
  if (merge) return 'merge';
  if (pick) return 'cherry-pick';
  if (revert) return 'revert';
  if (bisect) return 'bisect';
  return null;
}

/**
 * repo 的狀態（worktree 只有原始資料，id 由呼叫端決定）。不是 git repo 時回傳 null。
 * `git status` 會讀 index：一律關掉 core.fsmonitor（repo 的設定可以讓它執行任意指令），GIT_OPTIONAL_LOCKS=0 不寫 index。
 */
export async function readRepoStatus(
  dir: string,
): Promise<{ status: Omit<RepoStatus, 'worktrees'>; worktrees: RawWorktree[] } | null> {
  const gitDir = await gitOrUndefined(dir, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return null;
  const bare = (await gitOrUndefined(dir, ['rev-parse', '--is-bare-repository'])) === 'true';
  const [statusText, stashes, worktrees, remotes, operation, symbolic, headSha] = await Promise.all(
    [
      bare
        ? Promise.resolve('')
        : git(dir, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '-z']),
      readStashes(dir),
      listWorktrees(dir),
      listRemotes(dir),
      operationIn(gitDir),
      bare ? gitOrUndefined(dir, ['symbolic-ref', '--quiet', 'HEAD']) : undefined,
      bare ? gitOrUndefined(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) : undefined,
    ],
  );
  const parsed = parseStatusV2(statusText);
  if (bare) {
    parsed.branch = symbolic?.startsWith('refs/heads/') ? symbolic.slice(11) : null;
    parsed.head = headSha ?? null;
  }
  return {
    status: { ...parsed, remotes, stashes, operation, bare },
    worktrees: worktrees.slice(0, MAX_WORKTREES),
  };
}

// ── 動作的輸入驗證（第一關：形狀；第二關在執行前用 git 驗證） ──

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** ref 名稱的第一關（其餘交給 `git check-ref-format`）：不能像選項、不能有空白與控制字元。 */
const isRefNameShape = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 255 &&
  !v.startsWith('-') &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(v);
/** commit-ish（執行前用 `rev-parse --verify <x>^{commit}` 解析成 sha）：不能像選項。 */
const isRevisionShape = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 255 &&
  !v.startsWith('-') &&
  !CONTROL_CHARS.test(v);
const isStashIndex = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 100_000;
const isOptionalBoolean = (v: unknown): v is boolean | undefined =>
  v === undefined || typeof v === 'boolean';

/**
 * 驗證畫面送來的動作（只看形狀，不碰 git）：回傳只含已知欄位的新物件。
 * 會丟掉資料或改到遠端的動作沒有 `confirm: true` 一律拒絕。
 */
export function parseGitAction(input: unknown): { action: GitAction } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { error: 'The action must be an object.' };
  const a = input as Record<string, unknown>;
  const needsConfirm = (type: string) => ({ error: `"${type}" needs confirm: true.` });
  switch (a['type']) {
    case 'fetch':
      return { action: { type: 'fetch' } };
    case 'pull':
      return { action: { type: 'pull' } };
    case 'push': {
      if (a['confirm'] !== true) return needsConfirm('push');
      const up = a['setUpstream'];
      if (up === undefined) return { action: { type: 'push', confirm: true } };
      const remote = up && typeof up === 'object' ? (up as { remote?: unknown }).remote : undefined;
      if (!isRefNameShape(remote)) return { error: 'Invalid remote name.' };
      return { action: { type: 'push', confirm: true, setUpstream: { remote } } };
    }
    case 'stash-save': {
      const message = a['message'];
      const includeUntracked = a['includeUntracked'];
      if (
        message !== undefined &&
        (typeof message !== 'string' || message.length > 200 || CONTROL_CHARS.test(message))
      )
        return { error: 'The stash message must be one line of at most 200 characters.' };
      if (!isOptionalBoolean(includeUntracked)) return { error: 'Invalid includeUntracked.' };
      const trimmed = message?.trim();
      return {
        action: {
          type: 'stash-save',
          ...(trimmed ? { message: trimmed } : {}),
          ...(includeUntracked ? { includeUntracked: true } : {}),
        },
      };
    }
    case 'stash-apply':
    case 'stash-pop':
    case 'stash-drop': {
      const type = a['type'];
      if (!isStashIndex(a['index'])) return { error: 'Invalid stash index.' };
      const index = a['index'];
      if (type !== 'stash-drop') return { action: { type, index } };
      if (a['confirm'] !== true) return needsConfirm(type);
      return { action: { type, index, confirm: true } };
    }
    case 'tag-create': {
      const { name, target, message, push } = a;
      if (!isRefNameShape(name)) return { error: 'Invalid tag name.' };
      if (!isRevisionShape(target)) return { error: 'Invalid target commit.' };
      // 註解可以多行（tab / 換行），其他控制字元不行
      if (
        message !== undefined &&
        (typeof message !== 'string' ||
          message.length > 2000 ||
          /[\x00-\x08\x0b-\x1f\x7f]/.test(message))
      )
        return { error: 'The tag message must be at most 2000 characters.' };
      if (!isOptionalBoolean(push)) return { error: 'Invalid push flag.' };
      const text = message?.trim();
      return {
        action: {
          type: 'tag-create',
          name,
          target,
          ...(text ? { message: text } : {}),
          ...(push ? { push: true } : {}),
        },
      };
    }
    case 'tag-delete':
    case 'tag-push': {
      const type = a['type'];
      if (!isRefNameShape(a['name'])) return { error: 'Invalid tag name.' };
      const name = a['name'];
      if (type === 'tag-push') return { action: { type, name } };
      if (a['confirm'] !== true) return needsConfirm(type);
      return { action: { type, name, confirm: true } };
    }
    case 'worktree-add': {
      const { path, branch, newBranch, base } = a;
      if (
        typeof path !== 'string' ||
        !path.trim() ||
        path.length > 4096 ||
        CONTROL_CHARS.test(path)
      )
        return { error: 'Invalid path.' };
      if (branch !== undefined && !isRefNameShape(branch)) return { error: 'Invalid branch name.' };
      if (newBranch !== undefined && !isRefNameShape(newBranch))
        return { error: 'Invalid new branch name.' };
      if (base !== undefined && !isRevisionShape(base)) return { error: 'Invalid base commit.' };
      if (branch !== undefined && (newBranch !== undefined || base !== undefined))
        return { error: 'An existing branch cannot be combined with newBranch / base.' };
      return {
        action: {
          type: 'worktree-add',
          path: path.trim(),
          ...(branch !== undefined ? { branch } : {}),
          ...(newBranch !== undefined ? { newBranch } : {}),
          ...(base !== undefined ? { base } : {}),
        },
      };
    }
    case 'worktree-remove': {
      const id = a['id'];
      if (typeof id !== 'string' || !isRepoId(id)) return { error: 'Invalid worktree id.' };
      if (a['confirm'] !== true) return needsConfirm('worktree-remove');
      return { action: { type: 'worktree-remove', id, confirm: true } };
    }
    default:
      return { error: 'Unknown action.' };
  }
}

// ── 執行 ──

/** 憑證問題（帳密、token、ssh 金鑰、host key）。LC_ALL=C，訊息是固定的英文。 */
const AUTH_RE =
  /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(|Host key verification failed|HTTP Basic: Access denied|The requested URL returned error: 40[13]|Invalid username or password|Permission to \S+ denied/i;

const classifyPull = (out: string): GitActionErrorCode | undefined =>
  /Not possible to fast-forward|not a fast-forward|divergent branches/i.test(out)
    ? 'not_ff'
    : /would be overwritten|commit your changes or stash them/i.test(out)
      ? 'dirty'
      : /no tracking information|no such ref was fetched/i.test(out)
        ? 'no_upstream'
        : /not concluded your merge|MERGE_HEAD exists|in the middle of|unmerged files/i.test(out)
          ? 'operation_in_progress'
          : undefined;

const classifyPush = (out: string): GitActionErrorCode | undefined =>
  /^!\t|\[(?:remote )?rejected\]|failed to push some refs/m.test(out) ? 'rejected' : undefined;

/** porcelain 的每一個 ref 都是 `=`（[up to date]） */
const pushWasNoop = (out: string): boolean => /^=\t/m.test(out) && !/^[*+\-!]\t/m.test(out);

const classifyStash = (out: string): GitActionErrorCode | undefined =>
  /would be overwritten|already exists, no checkout|could not restore untracked files/i.test(out)
    ? 'dirty'
    : /^CONFLICT|conflict|needs merge|resolve your current index/im.test(out)
      ? 'conflict'
      : undefined;

const classifyWorktreeAdd = (out: string): GitActionErrorCode | undefined =>
  /already exists|already checked out|already used by worktree/i.test(out) ? 'exists' : undefined;

const classifyWorktreeRemove = (out: string): GitActionErrorCode | undefined =>
  /modified or untracked files|is dirty/i.test(out) ? 'dirty' : undefined;

interface ActionContext {
  /** repo 的位置（工作樹的根；bare repo 是 git 目錄本身） */
  dir: string;
  timeouts: { network: number; local: number };
  /** 這個 dev server 啟動的子行程（關閉時收掉） */
  children: Set<ChildProcess>;
  /** 資料夾（realpath）→ 畫面用的 repo id */
  idFor: (realDir: string) => string;
}

interface ActionOutcome {
  status: number;
  result: GitActionResult;
  /** worktree-add 成功：新 worktree 的 realpath */
  added?: string;
  /** worktree-remove 成功：被移除的 worktree 的 id */
  removed?: string;
}

/** worktree 的 realpath（資料夾不見了 / 卡住時是 null）與 id。 */
async function locateWorktree(
  wt: RawWorktree,
  idFor: (realDir: string) => string,
): Promise<{ real: string | null; id: string }> {
  const real =
    wt.prunable || stalledDirs.has(wt.path)
      ? null
      : await within(wt.path, realpath(wt.path), STALL_MS).then(
          (r) => (r === 'timeout' ? null : r),
          () => null,
        );
  return { real, id: idFor(real ?? resolve(wt.path)) };
}

async function performGitAction(ctx: ActionContext, action: GitAction): Promise<ActionOutcome> {
  const { dir } = ctx;
  const reply = (result: GitActionResult, status = 200): ActionOutcome => ({ status, result });
  const fail = (code: GitActionErrorCode, output: string, status = 200) =>
    reply({ ok: false, code, output: sanitizeGitOutput(output) }, status);
  const invalid = (output: string) => fail('invalid', output, 400);
  const run = (args: string[], network = false, cwd = dir) =>
    runGitAction(cwd, args, network ? ctx.timeouts.network : ctx.timeouts.local, ctx.children);
  const settle = (
    r: ActionRun,
    classify: (out: string) => GitActionErrorCode | undefined,
    nothing?: (out: string) => boolean,
  ): ActionOutcome => {
    const output = sanitizeGitOutput(r.output);
    if (r.timedOut) return reply({ ok: false, code: 'timeout', output });
    if (r.code === 0)
      return reply(
        nothing?.(r.output) ? { ok: true, code: 'nothing', output } : { ok: true, output },
      );
    const code = AUTH_RE.test(r.output) ? 'auth' : (classify(r.output) ?? 'failed');
    return reply({ ok: false, code, output });
  };

  const validRef = (full: string) =>
    git(dir, ['check-ref-format', full]).then(
      () => true,
      () => false,
    );
  const validBranch = async (name: string) => name !== 'HEAD' && validRef(`refs/heads/${name}`);
  const refExists = async (full: string) =>
    (await gitOrUndefined(dir, ['rev-parse', '--verify', '--quiet', full])) !== undefined;
  const resolveCommit = async (rev: string) => {
    const sha = await gitOrUndefined(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  };
  /** 目前的 branch（完整名稱解析，不受同名 tag 影響）；detached 是 undefined */
  const currentBranch = async () => {
    const ref = await gitOrUndefined(dir, ['symbolic-ref', '--quiet', 'HEAD']);
    return ref?.startsWith('refs/heads/') ? ref.slice(11) : undefined;
  };
  const upstreamOf = async (branch: string) => {
    const line = await gitOrUndefined(dir, [
      'for-each-ref',
      '--format=%(upstream:remotename)%00%(upstream:remoteref)',
      `refs/heads/${branch}`,
    ]);
    const [remote = '', ref = ''] = (line?.split('\n')[0] ?? '').split('\0');
    return remote && ref ? { remote, ref } : undefined;
  };
  /** tag 要推去哪：目前 branch 的 upstream remote，否則 origin */
  const tagRemote = async () => {
    const remotes = await listRemotes(dir);
    const branch = await currentBranch();
    const up = branch ? await upstreamOf(branch) : undefined;
    if (up && remotes.includes(up.remote)) return up.remote;
    return remotes.includes('origin') ? 'origin' : undefined;
  };
  /** 進行中的 merge / rebase… 會讓 pull、stash 失敗或產生衝突（bisect 不影響） */
  const blockingOperation = async () => {
    const gitDir = await gitOrUndefined(dir, ['rev-parse', '--absolute-git-dir']);
    const op = gitDir ? await operationIn(gitDir) : null;
    return op && op !== 'bisect' ? op : null;
  };
  const pushTag = (remote: string, name: string) =>
    run(['push', '--porcelain', '--', remote, `refs/tags/${name}:refs/tags/${name}`], true);

  switch (action.type) {
    case 'fetch': {
      if (!(await listRemotes(dir)).length)
        return reply({ ok: true, code: 'nothing', output: 'No remote is configured.' });
      return settle(
        await run(['fetch', '--all', '--prune'], true),
        () => undefined,
        (out) => out.split('\n').every((l) => !l.trim() || /^Fetching \S+$/.test(l.trim())),
      );
    }

    case 'pull': {
      const op = await blockingOperation();
      if (op) return fail('operation_in_progress', `A ${op} is in progress.`);
      const branch = await currentBranch();
      if (!branch) return fail('no_branch', 'HEAD is detached: check out a branch first.');
      if (!(await upstreamOf(branch)))
        return fail('no_upstream', `The branch '${branch}' has no upstream branch.`);
      // 只做 fast-forward：--no-rebase 蓋過 branch.<name>.rebase；也不自動 stash（套回去時可能衝突）
      return settle(
        await run(
          [
            '-c',
            'pull.rebase=false',
            '-c',
            'merge.autoStash=false',
            '-c',
            'rebase.autoStash=false',
            'pull',
            '--no-rebase',
            '--ff-only',
          ],
          true,
        ),
        classifyPull,
        (out) => /Already up.to.date/i.test(out),
      );
    }

    case 'push': {
      const branch = await currentBranch();
      if (!branch) return fail('no_branch', 'HEAD is detached: check out a branch first.');
      const remotes = await listRemotes(dir);
      let args: string[];
      if (action.setUpstream) {
        const { remote } = action.setUpstream;
        if (!remotes.includes(remote)) return fail('not_found', `There is no remote '${remote}'.`);
        args = [
          'push',
          '--porcelain',
          '--set-upstream',
          '--',
          remote,
          `refs/heads/${branch}:refs/heads/${branch}`,
        ];
      } else {
        const up = await upstreamOf(branch);
        if (!up) return fail('no_upstream', `The branch '${branch}' has no upstream branch.`);
        if (!remotes.includes(up.remote) || !up.ref.startsWith('refs/heads/'))
          return fail(
            'no_upstream',
            `The upstream of '${branch}' is not a branch on a configured remote.`,
          );
        // 明確的 refspec，沒有 `+`、沒有 --force：遠端不是 fast-forward 就會被拒絕
        args = ['push', '--porcelain', '--', up.remote, `refs/heads/${branch}:${up.ref}`];
      }
      return settle(await run(args, true), classifyPush, pushWasNoop);
    }

    case 'stash-save': {
      const op = await blockingOperation();
      if (op) return fail('operation_in_progress', `A ${op} is in progress.`);
      const args = ['stash', 'push'];
      if (action.includeUntracked) args.push('--include-untracked');
      if (action.message) args.push(`--message=${action.message}`);
      return settle(await run(args), classifyStash, (out) => /No local changes to save/i.test(out));
    }

    case 'stash-apply':
    case 'stash-pop':
    case 'stash-drop': {
      if (action.type !== 'stash-drop') {
        const op = await blockingOperation();
        if (op) return fail('operation_in_progress', `A ${op} is in progress.`);
      }
      const count = (await readStashes(dir)).length;
      if (action.index >= count)
        return fail('not_found', `stash@{${action.index}} does not exist.`);
      const op =
        action.type === 'stash-apply' ? 'apply' : action.type === 'stash-pop' ? 'pop' : 'drop';
      return settle(await run(['stash', op, `stash@{${action.index}}`]), classifyStash);
    }

    case 'tag-create': {
      const { name } = action;
      if (!(await validRef(`refs/tags/${name}`)))
        return invalid(`'${name}' is not a valid tag name.`);
      const sha = await resolveCommit(action.target);
      if (!sha) return fail('not_found', `'${action.target}' is not a commit.`);
      if (await refExists(`refs/tags/${name}`))
        return fail('exists', `The tag '${name}' already exists.`);
      const remote = action.push ? await tagRemote() : undefined;
      if (action.push && !remote)
        return fail('no_upstream', 'There is no remote to push the tag to.');
      const created = await run(
        action.message
          ? ['tag', '-a', `--message=${action.message}`, '--', name, sha]
          : ['tag', '--', name, sha],
      );
      if (!remote || created.code !== 0 || created.timedOut)
        return settle(created, (out) => (/already exists/i.test(out) ? 'exists' : undefined));
      const pushed = await pushTag(remote, name);
      return settle(
        { ...pushed, output: `${created.output}\n${pushed.output}` },
        classifyPush,
        pushWasNoop,
      );
    }

    case 'tag-delete':
    case 'tag-push': {
      const { name } = action;
      if (!(await validRef(`refs/tags/${name}`)))
        return invalid(`'${name}' is not a valid tag name.`);
      if (!(await refExists(`refs/tags/${name}`)))
        return fail('not_found', `The tag '${name}' does not exist.`);
      if (action.type === 'tag-delete')
        return settle(await run(['tag', '-d', '--', name]), () => undefined);
      const remote = await tagRemote();
      if (!remote) return fail('no_upstream', 'There is no remote to push the tag to.');
      return settle(await pushTag(remote, name), classifyPush, pushWasNoop);
    }

    case 'worktree-add': {
      // `~/x`、絕對路徑，或相對於這個 repo 的上一層（也就是 repo 的兄弟資料夾）
      if (/^~[^/\\]/.test(action.path)) return invalid('Only ~/… paths are supported.');
      const wanted = expandHome(action.path);
      if (isRemotePath(wanted)) return invalid('Network (UNC) paths are not supported.');
      const target = resolve(dirname(dir), wanted);
      if (isRemotePath(target)) return invalid('Network (UNC) paths are not supported.');
      // 不存在，或是空的資料夾（有時限：使用者輸入的路徑可能在卡住的網路磁碟上）
      const existing = stalledDirs.has(target)
        ? 'timeout'
        : await within(target, lstat(target), STALL_MS).catch(() => null);
      const empty =
        existing && existing !== 'timeout' && existing.isDirectory()
          ? await within(target, readdir(target), STALL_MS).then(
              (entries) => entries !== 'timeout' && entries.length === 0,
              () => false,
            )
          : false;
      if (existing === 'timeout') return fail('failed', 'The folder is not responding.');
      if (existing && !empty) return fail('exists', `'${labelFor(target)}' already exists.`);
      let args: string[];
      if (action.newBranch !== undefined) {
        const { newBranch } = action;
        if (!(await validBranch(newBranch)))
          return invalid(`'${newBranch}' is not a valid branch name.`);
        if (await refExists(`refs/heads/${newBranch}`))
          return fail('exists', `A branch named '${newBranch}' already exists.`);
        const base = await resolveCommit(action.base ?? 'HEAD');
        if (!base) return fail('not_found', `'${action.base ?? 'HEAD'}' is not a commit.`);
        args = ['worktree', 'add', '-b', newBranch, '--', target, base];
      } else if (action.branch !== undefined) {
        const { branch } = action;
        if (!(await validBranch(branch))) return invalid(`'${branch}' is not a valid branch name.`);
        if (!(await refExists(`refs/heads/${branch}`)))
          return fail('not_found', `There is no branch '${branch}'.`);
        args = ['worktree', 'add', '--', target, branch];
      } else {
        // 沒指定 branch：detached（不讓 git 依資料夾名稱自動建立 branch）
        const base = await resolveCommit(action.base ?? 'HEAD');
        if (!base) return fail('not_found', `'${action.base ?? 'HEAD'}' is not a commit.`);
        args = ['worktree', 'add', '--detach', '--', target, base];
      }
      const outcome = settle(await run(args), classifyWorktreeAdd);
      if (outcome.result.ok) {
        const real = await realpath(target).catch(() => null);
        if (real) outcome.added = real;
      }
      return outcome;
    }

    case 'worktree-remove': {
      const worktrees = await listWorktrees(dir);
      const located = await Promise.all(worktrees.map((wt) => locateWorktree(wt, ctx.idFor)));
      const index = located.findIndex((w) => w.id === action.id);
      if (index < 0) return fail('not_found', 'There is no such worktree.');
      if (index === 0) return invalid('The main worktree cannot be removed.');
      if (action.id === DEFAULT_REPO)
        return invalid('The worktree the dev server was started in cannot be removed.');
      // 從主 worktree 執行：要移除的可能正是畫面正在看的這個（git 的 cwd 不能是被刪掉的資料夾）
      const outcome = settle(
        await run(['worktree', 'remove', '--', worktrees[index]!.path], false, worktrees[0]!.path),
        classifyWorktreeRemove,
      );
      if (outcome.result.ok) outcome.removed = action.id;
      return outcome;
    }
  }
}

/** 同時監看幾個「非預設」repo；超過就停掉最久沒用的那個（之後再選到時會重新開始監看）。 */
const MAX_SESSIONS = 4;
/** 非預設 repo 多久沒有人要快照就停止監看（畫面顯示中的 repo 每 2 分鐘會重抓一次）。 */
const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
/** 使用者手動加入的路徑最多記幾個。 */
const MAX_ADDED = 50;
const SCAN_TTL_MS = 5000;
/** 從 `git worktree list` 認得的 worktree 最多記幾個（只在記憶體裡，不寫進 stateFile）。 */
const MAX_WORKTREE_ENTRIES = 200;

/** `depth` 參數：省略是 undefined、不合法是 null，其餘夾在 [1, MAX_DEPTH]。 */
const parseDepth = (raw: string | null): number | null | undefined => {
  if (raw === null) return undefined;
  if (!/^\d{1,32}$/.test(raw)) return null;
  return Math.min(MAX_DEPTH, Math.max(1, Number(raw)));
};

const VIRTUAL_ID = 'virtual:git-snapshot';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * 提供 `virtual:git-snapshot`（建置 / 啟動當下預設 repo 的 git 歷史），
 * dev 時監看 .git，有新 commit / checkout / fetch 就透過 HMR 即時推送新快照；
 * 另外提供本機 repo 清單與任一 repo 的快照，讓畫面可以切換要看哪個本機 repo。
 */
export function gitSnapshot(options: SnapshotOptions = {}): Plugin {
  let repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? process.cwd();
  let warn: (m: string) => void = options.onWarn ?? ((m) => console.warn(`[git-snapshot] ${m}`));
  let push: (repo: string, snap: GitSnapshot) => void = () => {};
  let stateFile: string | false = options.stateFile ?? process.env['AGG_LOCAL_REPOS_FILE'] ?? false;
  let main: RepoSession | undefined;
  // 建置時（沒有 dev server）也要能讀，所以 lazily 建立；dev 時 configureServer 再讓它開始監看
  const mainSession = () =>
    (main ??= new RepoSession(repoDir, {
      options,
      warn: (m) => warn(m),
      onUpdate: (snap) => push(DEFAULT_REPO, snap),
    }));

  return {
    name: 'adorable-git-snapshot',
    configResolved(config) {
      repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? config.root;
      stateFile =
        options.stateFile ?? process.env['AGG_LOCAL_REPOS_FILE'] ?? defaultStateFile(config.root);
      warn = options.onWarn ?? ((m) => config.logger.warn(`[git-snapshot] ${m}`));
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const session = mainSession();
      const snap = session.last ?? (await session.read());
      return `export default ${JSON.stringify(snap)};`;
    },
    async configureServer(server) {
      // vitest 只是借用 Vite 的轉換管線，不需要讀 git 也不需要監看
      if (process.env['VITEST']) return;
      await serveLocalRepos(server);
    },
  };

  async function serveLocalRepos(server: ViteDevServer) {
    push = (repo, snapshot) => {
      // 預設 repo 也是 virtual module：重新整理頁面時要拿到新的 module，而不是舊快取
      if (repo === DEFAULT_REPO) {
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
      }
      // HMR 會廣播給所有連線（`vite --host` 時含區網裡的裝置）：預設 repo 的內容本來就在 bundle 裡，
      // 其他 repo 只通知「有變」，畫面再經由只回應本機的 endpoint 去拿
      const data: SnapshotEvent = repo === DEFAULT_REPO ? { repo, snapshot } : { repo };
      server.ws.send({ type: 'custom', event: HMR_EVENT, data });
    };

    // 每個 dev server 用自己的預設 session：同一個 plugin 實例被重新設定時（例如 server.restart()），
    // 舊 server 關閉時的 cleanup 只能停掉它自己的監看，不能把新 server 的也停掉
    main?.stop();
    main = undefined;
    const def = mainSession();
    await def.sync();
    await def.start();

    // 預設 repo 的實際位置：清單去重用，也是預設的掃描根目錄（它的上一層）
    const resolved = await resolveRepo(repoDir).catch(() => ({
      dir: repoDir,
      name: basename(resolve(repoDir)),
    }));
    const defaultDir = await realpath(resolved.dir).catch(() => resolve(resolved.dir));
    const defaultEntry: RepoEntry = {
      id: DEFAULT_REPO,
      dir: defaultDir,
      name: resolved.name,
      label: labelFor(defaultDir),
      isDefault: true,
    };
    const roots = (options.repoRoots ?? rootsFromEnv() ?? [dirname(defaultDir)]).map((p) =>
      resolve(expandHome(p)),
    );
    const scanDepth = options.scanDepth ?? intFromEnv('AGG_REPO_SCAN_DEPTH') ?? 3;

    // ── 清單：掃描結果（短暫快取）+ 使用者手動加入的路徑（記在 stateFile） ──
    const added = new Map<string, RepoEntry>();
    const entryFor = (dir: string, name = basename(dir).replace(/\.git$/, '') || basename(dir)) => {
      const id = repoIdFor(dir);
      return { id, dir, name, label: labelFor(dir), isDefault: false };
    };
    if (stateFile) {
      try {
        const saved: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
        const paths = (saved as { paths?: unknown } | null)?.paths;
        const dirs = (Array.isArray(paths) ? paths.slice(0, MAX_ADDED) : []).filter(
          (dir): dir is string =>
            typeof dir === 'string' && isAbsolute(dir) && !isRemotePath(dir) && dir !== defaultDir,
        );
        // 已經不存在的就不列了。一個一個檢查、總共最多等 1 秒，碰到第一個卡住的就停（剩下的照列）：
        // 卡住的 stat 會一直佔著 libuv 執行緒，不能讓它吃掉掃描的額度或 Vite 讀檔要用的執行緒
        const alive: boolean[] = [];
        const until = Date.now() + 1000;
        let checking = true;
        for (const dir of dirs) {
          const left = Math.min(500, until - Date.now());
          if (!checking || left <= 0 || stalledDirs.size >= MAX_STALLED - 1) {
            alive.push(true);
            continue;
          }
          const result = await within(dir, stat(dir), left).then(
            (r) => (r === 'timeout' ? 'timeout' : 'ok'),
            (err: { code?: string }) =>
              err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'gone' : 'ok',
          );
          if (result === 'timeout') checking = false;
          alive.push(result !== 'gone');
        }
        dirs.forEach((dir, i) => {
          if (!alive[i]) return;
          const entry = entryFor(dir);
          added.set(entry.id, entry);
        });
      } catch {
        /* 還沒有檔案 / 壞掉：當作空的 */
      }
    }
    let saving = Promise.resolve();
    const saveAdded = () => {
      if (!stateFile) return;
      const file = stateFile;
      const body = JSON.stringify({ paths: [...added.values()].map((e) => e.dir) }, null, 2);
      // 依序寫入；先寫暫存檔再 rename，中途中斷也不會留下半個檔案。
      // 暫存檔用不會重複的名字 + 'wx'：已經存在的檔案或 symlink 不會被跟著寫進去
      saving = saving
        .then(async () => {
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
          await writeFile(tmp, `${body}\n`, { mode: 0o600, flag: 'wx' });
          await rename(tmp, file);
        })
        .catch((err: unknown) => warn(`could not remember the added repositories: ${String(err)}`));
    };
    let discovered = new Map<string, RepoEntry>();
    let truncated = false;
    let scannedAt = -Infinity;
    let scanning: Promise<void> | undefined;
    const rescan = (maxAgeMs: number): Promise<void> => {
      if (scanning) return scanning;
      if (Date.now() - scannedAt < maxAgeMs) return Promise.resolve();
      scanning = discoverRepos(roots, { maxDepth: scanDepth })
        .then((result) => {
          const next = new Map<string, RepoEntry>();
          for (const dir of result.repos) {
            if (dir === defaultDir) continue;
            const entry = entryFor(dir);
            next.set(entry.id, entry);
          }
          // 掃描被中斷（上限 / 時間 / 卡住的磁碟）：沒掃到的不代表不見了，沿用上一次的結果
          if (result.truncated)
            for (const [id, entry] of discovered) if (!next.has(id)) next.set(id, entry);
          discovered = next;
          truncated = result.truncated;
          scannedAt = Date.now();
        })
        .catch((err: unknown) => warn(`could not scan for repositories: ${String(err)}`))
        .finally(() => {
          scanning = undefined;
        });
      return scanning;
    };

    // ── 從 `git worktree list` 認得的 worktree：可以用 `?local=<id>` 開啟、會出現在清單裡，但不會被記住 ──
    const worktreeEntries = new Map<string, RepoEntry>();
    const idFor = (realDir: string) => (realDir === defaultDir ? DEFAULT_REPO : repoIdFor(realDir));
    const registerWorktree = (realDir: string): RepoEntry => {
      if (realDir === defaultDir) return defaultEntry;
      const id = repoIdFor(realDir);
      const entry =
        discovered.get(id) ?? added.get(id) ?? worktreeEntries.get(id) ?? entryFor(realDir);
      worktreeEntries.delete(id);
      worktreeEntries.set(id, entry);
      for (const oldId of worktreeEntries.keys()) {
        if (worktreeEntries.size <= MAX_WORKTREE_ENTRIES) break;
        worktreeEntries.delete(oldId);
      }
      return entry;
    };
    /** `git worktree list` 的結果 → 畫面用的資訊（順便登記成可開啟的 repo）。 */
    const describeWorktrees = (raws: RawWorktree[], currentId: string): Promise<WorktreeInfo[]> =>
      Promise.all(
        raws.map(async (wt, i) => {
          const { real, id } = await locateWorktree(wt, idFor);
          if (real) registerWorktree(real);
          return {
            id,
            label: labelFor(real ?? resolve(wt.path)),
            branch: wt.branch,
            head: wt.head,
            current: id === currentId,
            main: i === 0,
            locked: wt.locked,
            prunable: wt.prunable,
          };
        }),
      );

    const list = (): ReposResponse => {
      const others = [...new Map([...discovered, ...worktreeEntries, ...added]).values()].sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          a.label.localeCompare(b.label),
      );
      return { repos: [defaultEntry, ...others].map(toPublic), truncated };
    };

    // ── 每個 repo 一個 session（快照 + 監看）；非預設的最多留 MAX_SESSIONS 個 ──
    let closed = false;
    interface Open {
      entry: RepoEntry;
      session: RepoSession;
    }
    const sessions = new Map<string, Open & { usedAt: number }>();
    const opening = new Map<string, Promise<Open | undefined>>();

    const findEntry = async (id: string): Promise<RepoEntry | undefined> => {
      const hit = () =>
        sessions.get(id)?.entry ?? added.get(id) ?? discovered.get(id) ?? worktreeEntries.get(id);
      if (hit()) return hit();
      // 例如 dev server 重新啟動後直接打開 `?local=<id>` 的網址：清單還沒掃過
      await rescan(2000);
      if (hit()) return hit();
      // worktree 不會被記住：從預設 repo 與開著的 repo 的 worktree 清單裡找
      const dirs = new Set([defaultEntry.dir, ...[...sessions.values()].map((o) => o.entry.dir)]);
      await Promise.all(
        [...dirs].map(async (dir) => describeWorktrees(await listWorktrees(dir), '')),
      );
      return hit();
    };

    const sessionFor = (id: string): Promise<Open | undefined> => {
      if (id === DEFAULT_REPO) return Promise.resolve({ entry: defaultEntry, session: def });
      const open = sessions.get(id);
      if (open) {
        // LRU：移到最後
        open.usedAt = Date.now();
        sessions.delete(id);
        sessions.set(id, open);
        return Promise.resolve(open);
      }
      let pending = opening.get(id);
      if (!pending) {
        pending = (async () => {
          const entry = await findEntry(id);
          if (!entry || closed) return undefined;
          const session = new RepoSession(entry.dir, {
            // AGG_DEFAULT_BRANCH 是給預設 repo 的；其他 repo 用它自己的 origin/HEAD → main → master…
            // （'' 會蓋過環境變數，selectRefs 會略過空字串）
            options: { ...options, defaultBranch: '' },
            warn: (m) => warn(`${entry.name}: ${m}`),
            onUpdate: (snap) => push(id, snap),
          });
          const open = { entry, session, usedAt: Date.now() };
          sessions.set(id, open);
          for (const [oldId, old] of sessions) {
            if (sessions.size <= MAX_SESSIONS) break;
            old.session.stop();
            sessions.delete(oldId);
          }
          await session.start();
          return open;
        })().finally(() => opening.delete(id));
        opening.set(id, pending);
      }
      return pending;
    };

    // 看過一次就一直輪詢（每 2 秒 3 個 git 行程）太浪費：久沒人要的停掉，再選到時會重新開始
    const idleMs = options.idleMs && options.idleMs > 0 ? options.idleMs : IDLE_MS;
    const sweep = setInterval(
      () => {
        const cutoff = Date.now() - idleMs;
        for (const [id, open] of sessions) {
          if (open.usedAt >= cutoff) continue;
          open.session.stop();
          sessions.delete(id);
        }
      },
      Math.min(SWEEP_MS, idleMs),
    );
    sweep.unref();

    /** 使用者輸入的路徑：必須是絕對路徑（可用 ~）、存在、而且在 git repo 裡。回傳的 repo 之後一樣只用 id 存取。 */
    const addRepo = async (input: unknown): Promise<{ status: number; body: unknown }> => {
      if (
        typeof input !== 'string' ||
        !input.trim() ||
        input.length > 4096 ||
        input.includes('\0')
      ) {
        return { status: 400, body: { error: 'invalid_path' } };
      }
      const wanted = expandHome(input.trim());
      if (!isAbsolute(wanted)) return { status: 400, body: { error: 'not_absolute' } };
      if (isRemotePath(wanted)) return { status: 400, body: { error: 'invalid_path' } };
      let dir: string;
      try {
        dir = await realpath(wanted);
        if (!(await stat(dir)).isDirectory()) throw new Error('not a directory');
      } catch {
        return { status: 404, body: { error: 'not_found' } };
      }
      let top: string;
      let name: string;
      try {
        const repo = await resolveRepo(dir);
        top = await realpath(repo.dir);
        name = repo.name;
      } catch (err) {
        const code =
          err instanceof SnapshotError && err.code === 'unsafe_repo' ? err.code : 'not_git';
        return { status: 422, body: { error: code } };
      }
      if (top === defaultDir) return { status: 200, body: { repo: toPublic(defaultEntry) } };
      const id = repoIdFor(top);
      const entry = discovered.get(id) ?? added.get(id) ?? entryFor(top, name);
      added.delete(id);
      added.set(id, entry);
      for (const oldId of added.keys()) {
        if (added.size <= MAX_ADDED) break;
        added.delete(oldId);
      }
      saveAdded();
      return { status: 200, body: { repo: toPublic(entry) } };
    };

    server.middlewares.use(SNAPSHOT_ENDPOINT, (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!isSameOrigin(req, true)) return sendJson(res, 403, { error: 'forbidden' });
      let id: string;
      let depth: number | null | undefined;
      try {
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
        id = params.get('repo') ?? DEFAULT_REPO;
        // infinite scroll：要更早的歷史就帶 depth（這個 repo 之後的讀取與 HMR 推送都至少讀這麼多筆）
        depth = parseDepth(params.get('depth'));
      } catch {
        id = '';
      }
      if (!isRepoId(id)) return sendJson(res, 400, { error: 'invalid_repo' });
      if (depth === null) return sendJson(res, 400, { error: 'invalid_depth' });
      if (id !== DEFAULT_REPO && !isLoopback(req))
        return sendJson(res, 403, { error: 'local_only' });
      void sessionFor(id)
        .then(async (open) => {
          if (!open) return sendJson(res, 404, { error: 'unknown_repo' });
          if (depth) open.session.want(depth);
          await open.session.sync();
          sendJson(res, 200, open.session.last);
        })
        .catch((err: unknown) => {
          warn(`snapshot request failed: ${String(err)}`);
          sendJson(res, 500, { error: 'internal' });
        });
    });

    server.middlewares.use(REPOS_ENDPOINT, (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST')
        return sendJson(res, 405, { error: 'method_not_allowed' });
      // 本機的資料夾結構與其他 repo 只給這台電腦看（`vite --host` 時區網裡的裝置只看得到預設 repo）
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'local_only' });
      if (req.method === 'GET') {
        if (!isSameOrigin(req, true)) return sendJson(res, 403, { error: 'forbidden' });
        void rescan(SCAN_TTL_MS).then(() => sendJson(res, 200, list()));
        return;
      }
      // POST：這會讓 server 去讀使用者輸入的路徑：只接受同源頁面送來的 JSON
      // （跨站的 form / no-cors 請求送不出 application/json，fetch 則會先被 CORS preflight 擋下）
      if (!isSameOrigin(req, false)) return sendJson(res, 403, { error: 'forbidden' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        return sendJson(res, 415, { error: 'unsupported_media_type' });
      }
      void readBody(req, 8192).then(
        async (raw) => {
          let path: unknown;
          try {
            path = (JSON.parse(raw) as { path?: unknown } | null)?.path;
          } catch {
            path = undefined;
          }
          const result = await addRepo(path);
          sendJson(res, result.status, result.body);
        },
        () => sendJson(res, 413, { error: 'too_large' }),
      );
    });

    // ── repo 的狀態：branch、ahead / behind、變更、stash、worktree…（只給這台電腦看：含資料夾位置與 stash 訊息） ──
    server.middlewares.use(STATUS_ENDPOINT, (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'local_only' });
      if (!isLocalHost(req) || !isSameOrigin(req, true))
        return sendJson(res, 403, { error: 'forbidden' });
      let id: string;
      try {
        id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('repo') ?? DEFAULT_REPO;
      } catch {
        id = '';
      }
      if (!isRepoId(id)) return sendJson(res, 400, { error: 'invalid_repo' });
      void sessionFor(id)
        .then(async (open) => {
          if (!open) return sendJson(res, 404, { error: 'unknown_repo' });
          if (stalledDirs.has(open.entry.dir)) return sendJson(res, 503, { error: 'git_error' });
          const raw = await readRepoStatus(open.entry.dir);
          if (!raw) return sendJson(res, 422, { error: 'not_git' });
          const status: RepoStatus = {
            ...raw.status,
            worktrees: await describeWorktrees(raw.worktrees, id),
          };
          sendJson(res, 200, status);
        })
        .catch((err: unknown) => {
          warn(`status request failed: ${String(err)}`);
          sendJson(res, 503, { error: 'git_error' });
        });
    });

    // ── git 動作：只接受這台電腦上、同源頁面送來的 JSON（跨站的 form / no-cors 請求送不出 application/json） ──
    const children = new Set<ChildProcess>();
    /** 正在執行動作的 repo（以共用的 git 目錄為準：同一個 repo 的所有 worktree 一次只跑一個） */
    const busy = new Set<string>();
    const timeouts = {
      network: options.actionTimeoutMs ?? NETWORK_TIMEOUT_MS,
      local: options.actionTimeoutMs ?? LOCAL_TIMEOUT_MS,
    };
    /** 錯誤的回應也是 GitActionResult 的形狀（另外帶 `error`，與其他 endpoint 一致） */
    const refuse = (
      res: ServerResponse,
      status: number,
      error: string,
      code?: GitActionErrorCode,
      output = '',
    ) => sendJson(res, status, { ok: false, output, error, ...(code ? { code } : {}) });

    server.middlewares.use(GIT_ENDPOINT, (req, res) => {
      if (req.method !== 'POST') return refuse(res, 405, 'method_not_allowed');
      if (!isLoopback(req)) return refuse(res, 403, 'local_only');
      if (!isLocalHost(req) || !isSameOrigin(req, false)) return refuse(res, 403, 'forbidden');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
        return refuse(res, 415, 'unsupported_media_type');
      void readBody(req, 8192)
        .then(
          async (raw) => {
            let body: unknown;
            try {
              body = JSON.parse(raw);
            } catch {
              /* 不是 JSON */
            }
            const request = (body && typeof body === 'object' ? body : {}) as {
              repo?: unknown;
              action?: unknown;
            };
            const id = request.repo;
            if (typeof id !== 'string' || !isRepoId(id))
              return refuse(res, 400, 'invalid', 'invalid', 'Invalid repository id.');
            const parsed = parseGitAction(request.action);
            if ('error' in parsed) return refuse(res, 400, 'invalid', 'invalid', parsed.error);
            const open = await sessionFor(id);
            if (!open) return refuse(res, 404, 'unknown_repo', 'not_found');
            const { dir } = open.entry;
            const key =
              (await gitOrUndefined(dir, [
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              ])) ?? dir;
            if (busy.has(key))
              return refuse(res, 409, 'busy', 'busy', 'Another git action is still running.');
            busy.add(key);
            let outcome: ActionOutcome;
            try {
              outcome = await performGitAction({ dir, timeouts, children, idFor }, parsed.action);
            } finally {
              busy.delete(key);
            }
            if (outcome.added) outcome.result.repo = toPublic(registerWorktree(outcome.added));
            if (outcome.removed) {
              const gone = outcome.removed;
              worktreeEntries.delete(gone);
              discovered.delete(gone);
              if (added.delete(gone)) saveAdded();
              const old = sessions.get(gone);
              if (old && old !== open) {
                old.session.stop();
                sessions.delete(gone);
              }
            }
            // 圖馬上跟著變（HMR 推送）；監看也會看到，但不必等 debounce
            await open.session.sync();
            if (outcome.removed && sessions.get(outcome.removed) === open) {
              open.session.stop();
              sessions.delete(outcome.removed);
            }
            sendJson(res, outcome.status, outcome.result);
          },
          () => refuse(res, 413, 'too_large'),
        )
        .catch((err: unknown) => {
          warn(`git action failed: ${String(err)}`);
          refuse(res, 500, 'internal', 'failed');
        });
    });

    // dev server（含 vitest 的無 httpServer 模式）關閉時一定要放掉 watcher / timer，否則行程無法結束
    const cleanup = () => {
      closed = true;
      clearInterval(sweep);
      for (const child of children) killGroup(child, 'SIGTERM');
      def.stop();
      if (main === def) main = undefined;
      for (const { session } of sessions.values()) session.stop();
      sessions.clear();
    };
    const close = server.close.bind(server);
    server.close = async () => {
      cleanup();
      await close();
    };
    server.httpServer?.once('close', cleanup);
  }
}
