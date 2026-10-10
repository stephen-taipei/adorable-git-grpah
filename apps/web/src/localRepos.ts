import { REPOS_ENDPOINT, SNAPSHOT_ENDPOINT, isRepoId } from './protocol';
import type { GitSnapshot, LocalRepo, ReposResponse } from './protocol';
import { readStored, writeStored } from './storage';

/** dev server 的本機 repo API（只有 `pnpm start` 時存在；靜態建置不會呼叫）。 */

const PATHS_KEY = 'agg.local-paths';
const MAX_PATHS = 10;

export type AddRepoError = 'invalid_path' | 'not_absolute' | 'not_found' | 'not_git' | 'failed';
export type AddRepoResult =
  | { ok: true; repo: LocalRepo }
  | {
      ok: false;
      error: AddRepoError;
      /** 路徑本身有問題（不是 server 暫時連不上） */ definitive: boolean;
    };

const DEFINITIVE = new Set<string>(['invalid_path', 'not_absolute', 'not_found', 'not_git']);

/** 手動加入的路徑只記在這個瀏覽器：dev server 重新啟動後要再告訴它一次。 */
function readPaths(): string[] {
  try {
    const value: unknown = JSON.parse(readStored(PATHS_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter((p): p is string => typeof p === 'string').slice(0, MAX_PATHS)
      : [];
  } catch {
    return [];
  }
}

function writePaths(paths: string[]) {
  writeStored(PATHS_KEY, paths.length ? JSON.stringify(paths.slice(0, MAX_PATHS)) : null);
}

async function post(path: string): Promise<AddRepoResult> {
  try {
    const res = await fetch(REPOS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as {
      repo?: LocalRepo;
      error?: string;
    } | null;
    if (res.ok && body?.repo && isRepoId(body.repo.id)) return { ok: true, repo: body.repo };
    const error = body?.error ?? '';
    return DEFINITIVE.has(error)
      ? { ok: false, error: error as AddRepoError, definitive: true }
      : { ok: false, error: 'failed', definitive: false };
  } catch {
    return { ok: false, error: 'failed', definitive: false };
  }
}

let restoring: Promise<void> | undefined;

/** 把這個瀏覽器手動加過的路徑重新登記給 dev server（重新啟動後 `?local=<id>` 的網址才打得開）。只做一次。 */
export function restoreAddedPaths(): Promise<void> {
  restoring ??= (async () => {
    const paths = readPaths();
    if (!paths.length) return;
    const results = await Promise.all(paths.map(post));
    // 只丟掉確定失效的（資料夾不見 / 不再是 repo）；server 暫時連不上時保留
    const dead = new Set(paths.filter((_, i) => !results[i]!.ok && results[i]!.definitive));
    if (dead.size) writePaths(readPaths().filter((p) => !dead.has(p)));
  })();
  return restoring;
}

export async function addLocalRepo(input: string): Promise<AddRepoResult> {
  const path = input.trim();
  const result = await post(path);
  if (result.ok && !result.repo.isDefault) {
    writePaths([path, ...readPaths().filter((p) => p !== path)]);
  }
  return result;
}

export async function fetchLocalRepos(): Promise<ReposResponse | null> {
  await restoreAddedPaths();
  try {
    const res = await fetch(REPOS_ENDPOINT, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as ReposResponse;
    return Array.isArray(body?.repos) ? body : null;
  } catch {
    return null;
  }
}

/** `'unknown'`：dev server 不認得這個 id（repo 已移走、或重新啟動後不在掃描範圍內）。`null`：連不上 / 其他錯誤。 */
export async function fetchLocalSnapshot(id: string): Promise<GitSnapshot | 'unknown' | null> {
  await restoreAddedPaths();
  try {
    const res = await fetch(`${SNAPSHOT_ENDPOINT}?repo=${encodeURIComponent(id)}`, {
      cache: 'no-store',
    });
    if (res.status === 404) return 'unknown';
    if (!res.ok) return null;
    const body = (await res.json()) as GitSnapshot | null;
    return body && typeof body === 'object' && 'graph' in body ? body : null;
  } catch {
    return null;
  }
}
