import { GIT_ENDPOINT, STATUS_ENDPOINT } from './protocol';
import type { GitAction, GitActionErrorCode, GitActionResult, RepoStatus } from './protocol';

/**
 * 本機 repo 的狀態與 git 動作（只有 dev server 有，而且只回應這台電腦上同源頁面的請求）。
 * 這裡只放「跟畫面無關」的部分：呼叫 endpoint、判斷哪些動作現在能做、把結果整理成要顯示的訊息種類。
 * 真正的把關（參數驗證、不 force、pull 只 fast-forward、破壞性動作要 confirm）都在 server 端。
 */

export type StatusResult =
  | { kind: 'ok'; status: RepoStatus }
  /** 不提供（區網的畫面、跨來源、dev server 不認得這個 repo、不是 git repo）：整條動作列都不顯示 */
  | { kind: 'unavailable' }
  /** 暫時讀不到（git 忙碌中、連不到 dev server）：保留上一次的狀態 */
  | { kind: 'error' };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** server 是自己的，但還是看一下形狀：版本不合時寧可不顯示，也不要讓畫面當掉。 */
export function isRepoStatus(v: unknown): v is RepoStatus {
  if (!isObject(v)) return false;
  const c = v['changes'];
  return (
    (v['branch'] === null || typeof v['branch'] === 'string') &&
    (v['head'] === null || typeof v['head'] === 'string') &&
    (v['upstream'] === null || typeof v['upstream'] === 'string') &&
    typeof v['ahead'] === 'number' &&
    typeof v['behind'] === 'number' &&
    isObject(c) &&
    typeof c['staged'] === 'number' &&
    typeof c['unstaged'] === 'number' &&
    typeof c['untracked'] === 'number' &&
    typeof c['conflicted'] === 'number' &&
    Array.isArray(v['remotes']) &&
    Array.isArray(v['stashes']) &&
    Array.isArray(v['worktrees']) &&
    typeof v['bare'] === 'boolean'
  );
}

export async function fetchRepoStatus(repo: string, signal?: AbortSignal): Promise<StatusResult> {
  try {
    const res = await fetch(`${STATUS_ENDPOINT}?repo=${encodeURIComponent(repo)}`, {
      cache: 'no-store',
      signal,
    });
    // 403 local_only / forbidden、404 不認得、422 不是 git repo、靜態伺服器的 404 / 405：都是「沒有這個功能」
    if (res.status === 403 || res.status === 404 || res.status === 405 || res.status === 422)
      return { kind: 'unavailable' };
    if (!res.ok) return { kind: 'error' };
    // 靜態伺服器可能用 index.html 回應任何路徑（200 text/html）
    const body = (await res.json().catch(() => null)) as unknown;
    return isRepoStatus(body) ? { kind: 'ok', status: body } : { kind: 'unavailable' };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * 動作的結果。`transport`：請求根本沒有到 git（連不到 dev server、被拒絕）；這時 `code` 是 'failed'。
 */
export interface ActionOutcome extends GitActionResult {
  transport?: 'offline' | 'forbidden' | 'too_large';
}

const CODES = new Set<GitActionErrorCode>([
  'invalid',
  'busy',
  'not_ff',
  'no_upstream',
  'no_branch',
  'conflict',
  'rejected',
  'auth',
  'dirty',
  'exists',
  'not_found',
  'timeout',
  'operation_in_progress',
  'nothing',
  'failed',
]);

export async function runGitAction(repo: string, action: GitAction): Promise<ActionOutcome> {
  let res: Response;
  try {
    res = await fetch(GIT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, action }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, output: '', code: 'failed', transport: 'offline' };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  const raw = isObject(body) ? body : {};
  const output = typeof raw['output'] === 'string' ? raw['output'] : '';
  const code =
    typeof raw['code'] === 'string' && CODES.has(raw['code'] as GitActionErrorCode)
      ? (raw['code'] as GitActionErrorCode)
      : undefined;
  const repoInfo = isObject(raw['repo'])
    ? (raw['repo'] as unknown as ActionOutcome['repo'])
    : undefined;
  if (res.ok && typeof raw['ok'] === 'boolean') {
    return {
      ok: raw['ok'],
      output,
      ...(code ? { code } : {}),
      ...(repoInfo ? { repo: repoInfo } : {}),
    };
  }
  if (res.status === 403) return { ok: false, output, code: 'failed', transport: 'forbidden' };
  if (res.status === 413) return { ok: false, output, code: 'failed', transport: 'too_large' };
  if (code) return { ok: false, output, code };
  // 別的伺服器（靜態主機、舊版 dev server）：當作連不上
  return {
    ok: false,
    output,
    code: 'failed',
    transport: res.status >= 500 ? undefined : 'offline',
  };
}

// ───────────────────────── 哪些動作現在能做 ─────────────────────────

export type BarAction = 'fetch' | 'pull' | 'push' | 'stash' | 'tag' | 'worktree';
export const BAR_ACTIONS: readonly BarAction[] = [
  'fetch',
  'pull',
  'push',
  'stash',
  'tag',
  'worktree',
];

/** 不能用的原因（對應 i18n 的 `git.reasons`） */
export type Reason =
  | 'noRemote'
  | 'detached'
  | 'noUpstream'
  | 'bare'
  | 'unborn'
  | 'operation'
  | 'upToDate'
  | 'clean'
  | 'busy';

export interface Availability {
  enabled: boolean;
  reason?: Reason;
}

export const changeCount = (s: RepoStatus): number =>
  s.changes.staged + s.changes.unstaged + s.changes.untracked + s.changes.conflicted;

/** merge / rebase / cherry-pick / revert 進行中（bisect 不影響 pull 與 stash） */
export const blockingOperation = (s: RepoStatus): boolean =>
  s.operation !== null && s.operation !== 'bisect';

/** push 會推到哪裡：有 upstream 就是它；沒有就要先選 remote（--set-upstream） */
export function pushTarget(
  s: RepoStatus,
): { mode: 'upstream'; upstream: string } | { mode: 'set-upstream'; remotes: string[] } | null {
  if (!s.branch || !s.head || s.bare || s.remotes.length === 0) return null;
  if (s.upstream) return { mode: 'upstream', upstream: s.upstream };
  return { mode: 'set-upstream', remotes: s.remotes };
}

/** 沒有 upstream 時預設推到哪個 remote：origin 優先 */
export const defaultRemote = (remotes: readonly string[]): string =>
  remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');

/** 推 tag 時用的 remote（與 server 相同的規則：目前 upstream 的 remote，否則 origin） */
export function tagRemote(s: RepoStatus): string | null {
  const fromUpstream = s.upstream
    ? s.remotes.find((r) => s.upstream!.startsWith(`${r}/`))
    : undefined;
  if (fromUpstream) return fromUpstream;
  return s.remotes.includes('origin') ? 'origin' : null;
}

export function availability(s: RepoStatus, action: BarAction, running: boolean): Availability {
  if (running) return { enabled: false, reason: 'busy' };
  switch (action) {
    case 'fetch':
      return s.remotes.length ? { enabled: true } : { enabled: false, reason: 'noRemote' };
    case 'pull':
      if (s.bare) return { enabled: false, reason: 'bare' };
      if (!s.branch) return { enabled: false, reason: 'detached' };
      if (!s.upstream) return { enabled: false, reason: 'noUpstream' };
      if (blockingOperation(s)) return { enabled: false, reason: 'operation' };
      return { enabled: true };
    case 'push':
      if (s.bare) return { enabled: false, reason: 'bare' };
      if (!s.head) return { enabled: false, reason: 'unborn' };
      if (!s.branch) return { enabled: false, reason: 'detached' };
      if (!s.remotes.length) return { enabled: false, reason: 'noRemote' };
      // 有 upstream 而且沒有領先：沒有東西可推（落後的部分要先 pull）
      if (s.upstream && s.ahead === 0) return { enabled: false, reason: 'upToDate' };
      return { enabled: true };
    case 'stash':
      if (s.bare) return { enabled: false, reason: 'bare' };
      if (!s.head) return { enabled: false, reason: 'unborn' };
      return { enabled: true };
    case 'tag':
      return s.head ? { enabled: true } : { enabled: false, reason: 'unborn' };
    case 'worktree':
      return { enabled: true };
  }
}

/** stash 存檔：要有變更、不能在 merge / rebase 中 */
export function canStashSave(s: RepoStatus, running: boolean): Availability {
  if (running) return { enabled: false, reason: 'busy' };
  if (blockingOperation(s)) return { enabled: false, reason: 'operation' };
  if (changeCount(s) === 0) return { enabled: false, reason: 'clean' };
  return { enabled: true };
}

// ───────────────────────── 輸入檢查（server 會再用 git check-ref-format 驗一次） ─────────────────────────

export type RefNameProblem = 'empty' | 'chars' | 'dash' | 'format' | 'long';

/** 與 `git check-ref-format` 相同的規則（給即時提示；最終由 server 判斷）。 */
export function refNameProblem(name: string): RefNameProblem | null {
  if (!name) return 'empty';
  if (name.length > 255) return 'long';
  if (name.startsWith('-')) return 'dash';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'chars';
  if (
    name === '@' ||
    name.includes('..') ||
    name.includes('@{') ||
    name.includes('//') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    return 'format';
  return null;
}

/** branch 名稱還要多一條：不能叫 HEAD */
export const branchNameProblem = (name: string): RefNameProblem | null =>
  name === 'HEAD' ? 'format' : refNameProblem(name);

/** stash 訊息：一行、最多 200 字 */
export const STASH_MESSAGE_MAX = 200;
export const TAG_MESSAGE_MAX = 2000;

/** 從 branch 名稱推一個新 worktree 的資料夾名稱（放在 repo 的旁邊：server 以 repo 的上一層為基準） */
export function suggestWorktreePath(repoName: string, branch: string): string {
  const slug = branch
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug ? `${repoName}-${slug}` : '';
}

// ───────────────────────── 結果要怎麼說 ─────────────────────────

export type Tone = 'ok' | 'info' | 'error';

/**
 * 依動作與結果決定訊息的種類（實際文字在 i18n 的 `git.done` / `git.errors`）。
 * `key`：成功時是動作種類（'nothing' 另外處理），失敗時是錯誤代碼或 transport。
 */
export function resultKind(
  action: GitAction,
  result: ActionOutcome,
):
  | { tone: 'ok'; key: GitAction['type'] }
  | { tone: 'info'; key: 'nothing' }
  | { tone: 'error'; key: GitActionErrorCode | NonNullable<ActionOutcome['transport']> } {
  if (result.ok)
    return result.code === 'nothing'
      ? { tone: 'info', key: 'nothing' }
      : { tone: 'ok', key: action.type };
  if (result.transport) return { tone: 'error', key: result.transport };
  return { tone: 'error', key: result.code ?? 'failed' };
}

/** git 輸出的最後幾行（訊息旁的摘要；完整的放在可展開的區塊） */
export function outputTail(output: string, lines = 3): string {
  const kept = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  return kept.slice(-lines).join('\n');
}

/** 短 sha（顯示用） */
export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : '');
