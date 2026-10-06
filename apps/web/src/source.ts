import { isValidRepoSegment, parseGitHubRemote } from '@adorable/graph-core';

export type Source = { kind: 'local' } | { kind: 'github'; owner: string; repo: string };

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

export function sourceFromSearch(search: string): Source {
  const value = new URLSearchParams(search).get('repo');
  const parsed = value ? parseRepoInput(value) : null;
  return parsed ? { kind: 'github', ...parsed } : { kind: 'local' };
}

export function searchFromSource(source: Source): string {
  return source.kind === 'github'
    ? `?repo=${encodeURIComponent(`${source.owner}/${source.repo}`).replace('%2F', '/')}`
    : '';
}
