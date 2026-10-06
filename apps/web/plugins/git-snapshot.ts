import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import {
  GIT_LOG_FORMAT,
  GIT_REF_FORMAT,
  buildGitGraphData,
  parseForEachRef,
  selectRefs,
} from '@adorable/graph-core';
import { HMR_EVENT, SNAPSHOT_ENDPOINT, snapshotKey } from '../src/protocol.ts';
import type { GitSnapshot } from '../src/protocol.ts';

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
}

const intFromEnv = (name: string): number | undefined => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 不經 shell（execFile），參數全是我們組出來的 ref 名稱，不會被當成選項。 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
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
  const fail = (error: string): GitSnapshot => ({ graph: null, error, generatedAt });
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

    const logText = logRefs.length
      ? await git(dir, [
          // 使用者的 git 設定不能影響輸出格式（例如 log.showSignature 會在每筆前面塞 gpg 輸出）
          '-c',
          'log.showSignature=false',
          'log',
          '-z',
          '--no-show-signature',
          '--date-order',
          `--format=${GIT_LOG_FORMAT}`,
          '-n',
          String(maxCommits),
          ...logRefs,
          '--',
        ])
      : '';

    const graph = buildGitGraphData({ logText, selected, allRefs, remoteUrl, fallbackName: name });
    // shallow clone 的邊界 commit 看起來像 root：至少要讓畫面標示「更早的歷史已省略」
    if (shallow === 'true') graph.truncated = true;
    return { graph, generatedAt };
  } catch (err) {
    if (err instanceof SnapshotError) return fail(err.message);
    opts.onWarn?.(
      `could not read git history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fail('Could not read the git history (git reported an error).');
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
export function watchGitRefs(gitDirs: string[], onChange: () => void): () => void {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const add = (dir: string, handler: (filename: string | null) => void) => {
    if (closed || watchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, (_event, filename) =>
        handler(filename ? String(filename) : null),
      );
      w.on('error', () => {
        w.close();
        watchers.delete(dir);
      });
      watchers.set(dir, w);
    } catch {
      /* 目錄消失 / 達到 inotify 上限：交給輪詢安全網 */
    }
  };

  const watchTree = (dir: string) => {
    add(dir, (filename) => {
      if (filename) {
        const child = join(dir, filename);
        try {
          if (statSync(child).isDirectory()) watchTree(child);
        } catch {
          /* 已被刪除 */
        }
      }
      onChange();
    });
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchTree(join(dir, entry.name));
      }
    } catch {
      /* ignore */
    }
  };

  for (const gitDir of gitDirs) {
    add(gitDir, (filename) => {
      if (filename === null || filename === 'HEAD' || filename === 'packed-refs') onChange();
      if (filename === 'refs') watchTree(join(gitDir, 'refs'));
    });
    watchTree(join(gitDir, 'refs'));
  }

  return () => {
    closed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
}

const VIRTUAL_ID = 'virtual:git-snapshot';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * 提供 `virtual:git-snapshot`（建置 / 啟動當下的 git 歷史），
 * dev 時監看 .git，有新 commit / checkout / fetch 就透過 HMR 即時推送新快照。
 */
export function gitSnapshot(options: SnapshotOptions = {}): Plugin {
  let repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? process.cwd();
  let last: GitSnapshot | undefined;
  let warn: (m: string) => void = options.onWarn ?? ((m) => console.warn(`[git-snapshot] ${m}`));

  const read = async (): Promise<GitSnapshot> => {
    const snap = await readGitSnapshot(repoDir, { ...options, onWarn: warn });
    // 暫時性的 git 錯誤（例如 gc / fetch 進行中）不要把好好的畫面換成錯誤頁
    if (!snap.graph && last?.graph) return last;
    last = snap;
    return snap;
  };

  return {
    name: 'adorable-git-snapshot',
    configResolved(config) {
      repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? config.root;
      warn = options.onWarn ?? ((m) => config.logger.warn(`[git-snapshot] ${m}`));
    },
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const snap = last ?? (await read());
      return `export default ${JSON.stringify(snap)};`;
    },
    async configureServer(server) {
      // vitest 只是借用 Vite 的轉換管線，不需要讀 git 也不需要監看
      if (process.env['VITEST']) return;

      let key = snapshotKey(await read());

      // 讀取 → 比較 → 有變才更新 Vite module 並推送。一次只跑一個；執行中又來要求就在結束後再跑一輪（不漏）。
      let inflight: Promise<void> | undefined;
      let again = false;
      const sync = (): Promise<void> => {
        if (inflight) {
          again = true;
          return inflight;
        }
        inflight = (async () => {
          try {
            do {
              again = false;
              const snap = await read();
              const next = snapshotKey(snap);
              if (next === key) continue;
              key = next;
              const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
              if (mod) server.moduleGraph.invalidateModule(mod);
              server.ws.send({ type: 'custom', event: HMR_EVENT, data: snap });
            } while (again);
          } catch (err) {
            warn(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            inflight = undefined;
          }
        })();
        return inflight;
      };

      server.middlewares.use(SNAPSHOT_ENDPOINT, (req, res) => {
        // 只允許同源頁面讀取：其他 localhost 埠上的頁面不能偷看本機 commit 與未推送的 branch
        const site = req.headers['sec-fetch-site'];
        if (req.method !== 'GET' || (site && site !== 'same-origin' && site !== 'none')) {
          res.statusCode = req.method !== 'GET' ? 405 : 403;
          res.end();
          return;
        }
        void sync().then(() => {
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(last));
        });
      });

      let timer: NodeJS.Timeout | undefined;
      const onChange = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void sync(), 250);
      };

      let stopWatching = () => {};
      let poll: NodeJS.Timeout | undefined;
      try {
        const dirs = [
          ...new Set(
            (
              await Promise.all([
                git(repoDir, ['rev-parse', '--absolute-git-dir']),
                git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
              ])
            ).map((s) => s.trim()),
          ),
        ];
        stopWatching = watchGitRefs(dirs, onChange);

        // 安全網：檔案監看可能漏事件（網路磁碟、inotify 上限…），偶爾比對一次 ref 簽章
        const pollMs = options.pollMs ?? 2000;
        if (pollMs > 0) {
          let sig = await refsSignature(repoDir);
          poll = setInterval(() => {
            void refsSignature(repoDir).then((next) => {
              if (next === sig) return;
              sig = next;
              void sync();
            });
          }, pollMs);
          poll.unref();
        }
      } catch {
        // 不是 git repo：沒東西可監看，/__agg/git-snapshot 仍可手動重抓
      }

      // dev server（含 vitest 的無 httpServer 模式）關閉時一定要放掉 watcher / timer，否則行程無法結束
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(poll);
        stopWatching();
      };
      const close = server.close.bind(server);
      server.close = async () => {
        cleanup();
        await close();
      };
      server.httpServer?.once('close', cleanup);
    },
  };
}
