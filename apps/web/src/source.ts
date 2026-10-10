import { isValidRepoSegment, parseGitHubRemote } from '@adorable/graph-core';
import { DEFAULT_REPO, isRepoId } from './protocol';

/** `local.id`：dev server 清單裡的本機 repo（省略 = 啟動時指定的預設 repo）。 */
export type Source =
  { kind: 'local'; id?: string } | { kind: 'github'; owner: string; repo: string };

export interface RepoName {
  owner: string;
  repo: string;
}

/** GitHub 的 user / org 名稱：英數字與連字號（不含 `.`，因此不會把 `host.example/owner/repo` 誤認成 owner）。 */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const validated = (owner: string, repo: string): RepoName | null => {
  const name = repo.replace(/\.git$/i, '');
  return OWNER_RE.test(owner) && isValidRepoSegment(name) ? { owner, repo: name } : null;
};

/** 接受 `owner/repo`、github.com 網址（含 `/tree/...`、`.git`）與 `git@github.com:o/r.git`；其他 host 一律拒絕。 */
export function parseRepoInput(input: string): RepoName | null {
  const text = input.trim();
  if (!text) return null;

  const remote = parseGitHubRemote(text);
  if (remote) return validated(remote.owner, remote.repo);

  // 帶 scheme 的一定要是 github.com
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(text);
    return m ? validated(m[1]!, m[2]!) : null;
  }

  const m = /^(?:(?:www\.)?github\.com\/)?([^/\s?#]+)\/([^/\s?#]+)/i.exec(text);
  return m ? validated(m[1]!, m[2]!) : null;
}

/** `?repo=owner/name` → GitHub；`?local=<id>` → 本機清單裡的某個 repo；其他 → 預設的本機 repo。 */
export function sourceFromSearch(search: string): Source {
  const params = new URLSearchParams(search);
  const value = params.get('repo');
  const parsed = value ? parseRepoInput(value) : null;
  if (parsed) return { kind: 'github', ...parsed };
  const id = params.get('local');
  return id && id !== DEFAULT_REPO && isRepoId(id) ? { kind: 'local', id } : { kind: 'local' };
}

export function searchFromSource(source: Source): string {
  if (source.kind === 'github')
    return `?repo=${encodeURIComponent(`${source.owner}/${source.repo}`).replace('%2F', '/')}`;
  return source.id && source.id !== DEFAULT_REPO ? `?local=${source.id}` : '';
}

/** 同一個本機 repo 一律用同一種寫法（預設 repo 不帶 id），比較與網址才不會分岔。 */
export const localSource = (id: string | undefined): Source =>
  id && id !== DEFAULT_REPO ? { kind: 'local', id } : { kind: 'local' };
