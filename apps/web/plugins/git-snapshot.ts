import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import {
  GIT_LOG_FORMAT,
  GIT_REF_FORMAT,
  buildGitGraphData,
  parseForEachRef,
  selectRefs,
} from '@adorable/graph-core';
import { HMR_EVENT, SNAPSHOT_ENDPOINT } from '../src/protocol.ts';
import type { GitSnapshot } from '../src/protocol.ts';

export type { GitSnapshot };

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

export async function readGitSnapshot(
  repoDir: string,
  opts: SnapshotOptions = {},
): Promise<GitSnapshot> {
  const generatedAt = Date.now();
  let top: string;
  try {
    top = (await git(repoDir, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg =
      code === 'ENOENT' ? 'git is not installed' : `${repoDir} is not inside a git repository`;
    return { graph: null, error: msg, generatedAt };
  }

  const maxCommits = opts.maxCommits ?? intFromEnv('AGG_MAX_COMMITS') ?? 300;
  const maxBranches = opts.maxBranches ?? intFromEnv('AGG_MAX_BRANCHES') ?? 8;

  const [refsText, originHead, currentBranch, remoteUrl] = await Promise.all([
    git(top, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${GIT_REF_FORMAT}`,
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ]),
    gitOrUndefined(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    gitOrUndefined(top, ['branch', '--show-current']),
    gitOrUndefined(top, ['config', '--get', 'remote.origin.url']),
  ]);

  const allRefs = parseForEachRef(refsText);
  const selected = selectRefs(allRefs, {
    defaultBranch: opts.defaultBranch ?? process.env['AGG_DEFAULT_BRANCH'],
    originHead,
    currentBranch,
    maxBranches,
  });

  // branch が 1 本も無い（CI の detached HEAD など）ときは HEAD から履歴をたどる
  const logRefs = selected.logRefs.length
    ? selected.logRefs
    : (await gitOrUndefined(top, ['rev-parse', '--verify', '--quiet', 'HEAD']))
      ? ['HEAD']
      : [];

  const logText = logRefs.length
    ? await git(top, [
        'log',
        '--date-order',
        `--format=${GIT_LOG_FORMAT}`,
        '-n',
        String(maxCommits),
        ...logRefs,
        '--',
      ])
    : '';

  const graph = buildGitGraphData({
    logText,
    selected,
    allRefs,
    remoteUrl,
    fallbackName: basename(top),
  });
  return { graph, generatedAt };
}

/** 比較用：忽略每次都會變的時間戳。 */
export const snapshotKey = (s: GitSnapshot): string =>
  JSON.stringify({ ...s, generatedAt: 0, graph: s.graph && { ...s.graph, fetchedAt: 0 } });

const VIRTUAL_ID = 'virtual:git-snapshot';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/**
 * 提供 `virtual:git-snapshot`（建置 / 啟動當下的 git 歷史），
 * dev 時監看 .git 的 refs，有新 commit / checkout / fetch 就透過 HMR 即時推送新快照。
 */
export function gitSnapshot(options: SnapshotOptions = {}): Plugin {
  let repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? process.cwd();
  let last: GitSnapshot | undefined;

  const read = async () => {
    last = await readGitSnapshot(repoDir, options);
    return last;
  };

  return {
    name: 'adorable-git-snapshot',
    configResolved(config) {
      repoDir = options.repoDir ?? process.env['AGG_REPO_DIR'] ?? config.root;
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

      server.middlewares.use(SNAPSHOT_ENDPOINT, (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        read().then(
          (snap) => {
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            res.end(JSON.stringify(snap));
          },
          (err: unknown) => {
            res.statusCode = 500;
            res.end(String(err));
          },
        );
      });

      const first = await read();
      let key = snapshotKey(first);
      let timer: NodeJS.Timeout | undefined;
      let busy = false;

      const refresh = async () => {
        if (busy) return;
        busy = true;
        try {
          const snap = await read();
          const next = snapshotKey(snap);
          if (next === key) return;
          key = next;
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
          if (mod) server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'custom', event: HMR_EVENT, data: snap });
        } finally {
          busy = false;
        }
      };

      const watchers: FSWatcher[] = [];
      try {
        const dirs = new Set(
          (
            await Promise.all([
              git(repoDir, ['rev-parse', '--absolute-git-dir']),
              git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
            ])
          ).map((s) => s.trim()),
        );
        for (const dir of dirs) {
          watchers.push(
            // Node ≥ 20 在 Linux 也支援 recursive；objects/ 變動頻繁且不影響圖，直接略過
            watch(dir, { recursive: true }, (_event, filename) => {
              const f = String(filename ?? '').replaceAll('\\', '/');
              if (f && !(f === 'HEAD' || f === 'packed-refs' || f.startsWith('refs/'))) return;
              clearTimeout(timer);
              timer = setTimeout(() => void refresh(), 250);
            }),
          );
        }
      } catch {
        // 不是 git repo：沒東西可監看，/__agg/git-snapshot 仍可手動重抓
      }

      // dev server（含 vitest 的無 httpServer 模式）關閉時一定要放掉 watcher，否則行程無法結束
      const cleanup = () => {
        clearTimeout(timer);
        for (const w of watchers.splice(0)) w.close();
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
