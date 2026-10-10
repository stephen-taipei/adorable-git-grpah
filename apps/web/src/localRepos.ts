import { MAX_DEPTH, REPOS_ENDPOINT, SNAPSHOT_ENDPOINT, isRepoId } from './protocol';
import type { GitSnapshot, LocalRepo, ReposResponse } from './protocol';

/**
 * dev server 的本機 repo API（只有 `pnpm start` 時存在；靜態建置不會呼叫）。
 * 手動加入的路徑由 dev server 自己記（不放在瀏覽器：localhost:<port> 這個 origin 會被其他專案的 dev server 共用）。
 */

export type AddRepoError =
  'invalid_path' | 'not_absolute' | 'not_found' | 'not_git' | 'unsafe_repo' | 'failed';
export type AddRepoResult = { ok: true; repo: LocalRepo } | { ok: false; error: AddRepoError };

const ADD_ERRORS = new Set<string>([
  'invalid_path',
  'not_absolute',
  'not_found',
  'not_git',
  'unsafe_repo',
]);

/** dev server 只回應這台電腦的請求（`vite --host` 時，用手機等其他裝置開的畫面不能選其他 repo）。 */
export const LOCAL_ONLY = 'local_only';

const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : '';
};

export async function addLocalRepo(input: string): Promise<AddRepoResult> {
  try {
    const res = await fetch(REPOS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: input.trim() }),
      cache: 'no-store',
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { repo?: LocalRepo } | null;
      if (body?.repo && isRepoId(body.repo.id)) return { ok: true, repo: body.repo };
      return { ok: false, error: 'failed' };
    }
    const error = await errorOf(res);
    return { ok: false, error: ADD_ERRORS.has(error) ? (error as AddRepoError) : 'failed' };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

/** `LOCAL_ONLY`：不是從這台電腦開的畫面。`null`：連不上 / 其他錯誤。 */
export async function fetchLocalRepos(): Promise<ReposResponse | typeof LOCAL_ONLY | null> {
  try {
    const res = await fetch(REPOS_ENDPOINT, { cache: 'no-store' });
    if (!res.ok)
      return res.status === 403 && (await errorOf(res)) === LOCAL_ONLY ? LOCAL_ONLY : null;
    const body = (await res.json()) as ReposResponse | null;
    return Array.isArray(body?.repos) ? body : null;
  } catch {
    return null;
  }
}

/**
 * `'unknown'`：dev server 不認得這個 id（repo 已移走、或重新啟動後不在清單裡）。
 * `LOCAL_ONLY`：不是從這台電腦開的畫面。`null`：連不上 / 其他錯誤。
 * `depth`：至少讀這麼多筆 commit（infinite scroll）。每次都帶上目前要的深度：dev server 停掉閒置的 repo、
 * 或重新啟動後會忘記，下一次讀取（含 HMR 通知後的重抓）才不會把已經載入的更早歷史又截掉。
 */
export async function fetchLocalSnapshot(
  id: string,
  depth?: number,
): Promise<GitSnapshot | 'unknown' | typeof LOCAL_ONLY | null> {
  const query = new URLSearchParams({ repo: id });
  if (depth !== undefined && Number.isSafeInteger(depth) && depth > 0)
    query.set('depth', String(Math.min(depth, MAX_DEPTH)));
  try {
    const res = await fetch(`${SNAPSHOT_ENDPOINT}?${query}`, {
      cache: 'no-store',
    });
    if (res.status === 404) return 'unknown';
    if (res.status === 403 && (await errorOf(res)) === LOCAL_ONLY) return LOCAL_ONLY;
    if (!res.ok) return null;
    const body = (await res.json()) as GitSnapshot | null;
    return body && typeof body === 'object' && 'graph' in body ? body : null;
  } catch {
    return null;
  }
}
