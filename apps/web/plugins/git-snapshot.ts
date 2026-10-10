import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, statSync, watch } from 'node:fs';
import type { Dirent, FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
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
  HMR_EVENT,
  REPOS_ENDPOINT,
  SNAPSHOT_ENDPOINT,
  isRepoId,
  snapshotKey,
} from '../src/protocol.ts';
import type { GitSnapshot, LocalRepo, ReposResponse, SnapshotEvent } from '../src/protocol.ts';

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
   * 預設：環境變數 AGG_LOCAL_REPOS_FILE，否則為 `<vite root>/node_modules/.cache/adorable-git-graph/local-repos.json`。
   */
  stateFile?: string | false;
  /** 非預設 repo 多久沒有人要快照就停止監看。預設 10 分鐘（主要是給測試調短用）。 */
  idleMs?: number;
}

const intFromEnv = (name: string): number | undefined => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

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
      bin = file;
      break;
    } catch {
      /* 不在這裡 */
    }
  }
  gitBinary = { path, bin };
  return bin;
}

/** 不經 shell（execFile），參數全是我們組出來的 ref 名稱，不會被當成選項。 */
async function git(cwd: string, args: string[]): Promise<string> {
  const bin = findGit();
  if (!bin) throw Object.assign(new Error('git is not installed'), { code: 'ENOENT' });
  const { stdout } = await execFileAsync(bin, args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    // 網路磁碟卡住等：不要讓 git 子行程與等待中的請求永遠掛著
    timeout: 60_000,
    // 唯讀操作也避免 index 鎖，LC_ALL 讓輸出格式穩定
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  return stdout;
}

const gitOrUndefined = (cwd: string, args: string[]) =>
  git(cwd, args).then(
    (s) => s.trim() || undefined,
    () => undefined,
  );

class SnapshotError extends Error {}

/** 工作樹的根；bare repo 或直接指到 .git 時退而求其次。 */
async function resolveRepo(repoDir: string): Promise<{ dir: string; name: string }> {
  try {
    const top = (await git(repoDir, ['rev-parse', '--show-toplevel'])).trim();
    return { dir: top, name: basename(top) };
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT')
      throw new SnapshotError('git is not installed');
  }
  const gitDir = await gitOrUndefined(repoDir, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) throw new SnapshotError('The configured directory is not inside a git repository.');
  // bare：.../project.git；在 .git 內：.../project/.git
  const named = basename(gitDir) === '.git' ? dirname(gitDir) : gitDir;
  return { dir: repoDir, name: basename(named).replace(/\.git$/, '') || 'repository' };
}

export async function readGitSnapshot(
  repoDir: string,
  opts: SnapshotOptions = {},
): Promise<GitSnapshot> {
  const generatedAt = Date.now();
  // 錯誤訊息會被烤進 bundle / 經由 endpoint 送出，所以一律不含本機路徑；細節給 onWarn（終端機）。
  // transient：git 自己出錯（gc / fetch 進行中等），保留上一張好的圖；其餘是確定的失敗，要如實顯示。
  const fail = (error: string, transient = false): GitSnapshot => ({
    graph: null,
    error,
    generatedAt,
    ...(transient ? { transient: true } : {}),
  });
  if (!existsSync(repoDir)) return fail('The configured repository directory does not exist.');

  try {
    const { dir, name } = await resolveRepo(repoDir);
    const maxCommits = opts.maxCommits ?? intFromEnv('AGG_MAX_COMMITS') ?? 300;
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
    if (err instanceof SnapshotError) return fail(err.message);
    opts.onWarn?.(
      `could not read git history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fail('Could not read the git history (git reported an error).', true);
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

  const watchTree = (dir: string, replace = false) => {
    add(
      dir,
      (event, filename) => {
        if (filename) {
          const child = join(dir, filename);
          try {
            if (statSync(child).isDirectory()) watchTree(child, event === 'rename');
          } catch {
            drop(child); // 已被刪除：放掉舊的監看，之後重建時才會重新加上
          }
        }
        onChange();
      },
      replace,
    );
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
      if (filename === 'refs') watchTree(join(gitDir, 'refs'), true);
    });
    watchTree(join(gitDir, 'refs'));
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

const isBareRepo = (entries: Dirent[]) => {
  const has = (name: string, dir: boolean) =>
    entries.some((e) => e.name === name && (dir ? e.isDirectory() : e.isFile()));
  return has('HEAD', false) && has('objects', true) && has('refs', true);
};

/**
 * 找出 roots 底下的 git repository（一般 repo、worktree、`*.git` 的 bare repo）。
 * 只看資料夾裡有沒有 `.git`：不執行 git（不會碰到陌生 repo 的設定）、不跟隨 symlink、不往 repo 裡面找（submodule 等）。
 * 回傳排序過的 realpath；碰到上限就停下並標記 truncated。
 */
export async function discoverRepos(
  roots: string[],
  opts: DiscoverOptions = {},
): Promise<{ repos: string[]; truncated: boolean }> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 5000;
  const maxRepos = opts.maxRepos ?? 300;
  const deadline = Date.now() + (opts.timeBudgetMs ?? 3000);
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const root of roots) {
    try {
      const dir = await realpath(root);
      // 整個磁碟（/、C:\）沒有意義又慢
      if (parse(dir).root !== dir) queue.push({ dir, depth: 0 });
    } catch {
      /* 不存在 */
    }
  }
  const found = new Set<string>();
  const seen = new Set<string>();
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    if (seen.size >= maxDirs || found.size >= maxRepos || Date.now() > deadline) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue[i]!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === '.git') || (dir.endsWith('.git') && isBareRepo(entries))) {
      found.add(dir);
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      // Dirent.isDirectory() 對 symlink 是 false：不會被連結帶到範圍外或繞圈
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
        queue.push({ dir: join(dir, e.name), depth: depth + 1 });
      }
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
  private teardown: () => void = () => {};
  readonly dir: string;
  private readonly hooks: SessionHooks;

  constructor(dir: string, hooks: SessionHooks) {
    this.dir = dir;
    this.hooks = hooks;
  }

  async read(): Promise<GitSnapshot> {
    const snap = await readGitSnapshot(this.dir, {
      ...this.hooks.options,
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

  /** 監看 .git（HEAD、packed-refs、refs/**），外加輪詢 ref 簽章的安全網。 */
  async start(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    let stopWatching = () => {};
    this.teardown = () => {
      clearTimeout(timer);
      clearInterval(poll);
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

      // 安全網：檔案監看可能漏事件（網路磁碟、inotify 上限…），偶爾比對一次 ref 簽章
      const pollMs = this.hooks.options.pollMs ?? 2000;
      if (pollMs > 0) {
        let sig = await refsSignature(this.dir);
        if (this.stopped) return;
        poll = setInterval(() => {
          void refsSignature(this.dir).then((next) => {
            if (next === sig) return;
            sig = next;
            void this.sync();
          });
        }, pollMs);
        poll.unref();
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

const readBody = (req: IncomingMessage, limit: number) =>
  new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error('request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });

/** 同時監看幾個「非預設」repo；超過就停掉最久沒用的那個（之後再選到時會重新開始監看）。 */
const MAX_SESSIONS = 4;
/** 非預設 repo 多久沒有人要快照就停止監看（畫面顯示中的 repo 每 2 分鐘會重抓一次）。 */
const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
/** 使用者手動加入的路徑最多記幾個。 */
const MAX_ADDED = 50;
const SCAN_TTL_MS = 5000;

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
        options.stateFile ??
        process.env['AGG_LOCAL_REPOS_FILE'] ??
        join(config.root, 'node_modules', '.cache', 'adorable-git-graph', 'local-repos.json');
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
        for (const dir of Array.isArray(paths) ? paths.slice(0, MAX_ADDED) : []) {
          if (typeof dir !== 'string' || !isAbsolute(dir) || isRemotePath(dir) || !existsSync(dir))
            continue;
          if (dir === defaultDir) continue;
          const entry = entryFor(dir);
          added.set(entry.id, entry);
        }
      } catch {
        /* 還沒有檔案 / 壞掉：當作空的 */
      }
    }
    let saving = Promise.resolve();
    const saveAdded = () => {
      if (!stateFile) return;
      const file = stateFile;
      const body = JSON.stringify({ paths: [...added.values()].map((e) => e.dir) }, null, 2);
      // 依序寫入；先寫暫存檔再 rename，中途中斷也不會留下半個檔案
      saving = saving
        .then(async () => {
          await mkdir(dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, `${body}\n`, { mode: 0o600 });
          await rename(`${file}.tmp`, file);
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

    const list = (): ReposResponse => {
      const others = [...new Map([...discovered, ...added]).values()].sort(
        (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          a.label.localeCompare(b.label),
      );
      return { repos: [defaultEntry, ...others].map(toPublic), truncated };
    };

    // ── 每個 repo 一個 session（快照 + 監看）；非預設的最多留 MAX_SESSIONS 個 ──
    let closed = false;
    const sessions = new Map<string, { entry: RepoEntry; session: RepoSession; usedAt: number }>();
    const opening = new Map<string, Promise<RepoSession | undefined>>();

    const findEntry = async (id: string): Promise<RepoEntry | undefined> => {
      const hit = () => sessions.get(id)?.entry ?? added.get(id) ?? discovered.get(id);
      if (hit()) return hit();
      // 例如 dev server 重新啟動後直接打開 `?local=<id>` 的網址：清單還沒掃過
      await rescan(2000);
      return hit();
    };

    const sessionFor = (id: string): Promise<RepoSession | undefined> => {
      if (id === DEFAULT_REPO) return Promise.resolve(def);
      const open = sessions.get(id);
      if (open) {
        // LRU：移到最後
        open.usedAt = Date.now();
        sessions.delete(id);
        sessions.set(id, open);
        return Promise.resolve(open.session);
      }
      let pending = opening.get(id);
      if (!pending) {
        pending = (async () => {
          const entry = await findEntry(id);
          if (!entry || closed) return undefined;
          const session = new RepoSession(entry.dir, {
            options,
            warn: (m) => warn(`${entry.name}: ${m}`),
            onUpdate: (snap) => push(id, snap),
          });
          sessions.set(id, { entry, session, usedAt: Date.now() });
          for (const [oldId, old] of sessions) {
            if (sessions.size <= MAX_SESSIONS) break;
            old.session.stop();
            sessions.delete(oldId);
          }
          await session.start();
          return session;
        })().finally(() => opening.delete(id));
        opening.set(id, pending);
      }
      return pending;
    };

    // 看過一次就一直輪詢（每 2 秒 3 個 git 行程）太浪費：久沒人要的停掉，再選到時會重新開始
    const idleMs = options.idleMs ?? IDLE_MS;
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
      } catch {
        return { status: 422, body: { error: 'not_git' } };
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
      try {
        id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('repo') ?? DEFAULT_REPO;
      } catch {
        id = '';
      }
      if (!isRepoId(id)) return sendJson(res, 400, { error: 'invalid_repo' });
      if (id !== DEFAULT_REPO && !isLoopback(req))
        return sendJson(res, 403, { error: 'local_only' });
      void sessionFor(id)
        .then(async (session) => {
          if (!session) return sendJson(res, 404, { error: 'unknown_repo' });
          await session.sync();
          sendJson(res, 200, session.last);
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

    // dev server（含 vitest 的無 httpServer 模式）關閉時一定要放掉 watcher / timer，否則行程無法結束
    const cleanup = () => {
      closed = true;
      clearInterval(sweep);
      def.stop();
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
