import { isValidRepoSegment } from '@adorable/graph-core';

export interface RepoRef {
  owner: string;
  repo: string;
  /** `/tree/<branch>/…` 之後的路徑；branch 名可能含 `/`，由 graph-core 解析。 */
  branchHint?: string;
}

/** github.com 的第一層路徑，不是 user / org。 */
const RESERVED_OWNERS = new Set([
  'about',
  'account',
  'apps',
  'codespaces',
  'collections',
  'contact',
  'copilot',
  'customer-stories',
  'dashboard',
  'discussions',
  'education',
  'enterprise',
  'enterprises',
  'events',
  'explore',
  'features',
  'issues',
  'join',
  'login',
  'logout',
  'marketplace',
  'mcp',
  'models',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'password_reset',
  'premium-support',
  'pricing',
  'pulls',
  'readme',
  'resources',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'solutions',
  'sponsors',
  'stars',
  'team',
  'topics',
  'trending',
  'users',
  'watching',
]);

const BRANCH_VIEWS = new Set(['tree', 'blob', 'commits', 'blame', 'raw']);

export function parseRepoPath(pathname: string): RepoRef | null {
  const seg = pathname.split('/').filter(Boolean);
  if (seg.length < 2) return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(seg[0]!);
    repo = decodeURIComponent(seg[1]!).replace(/\.git$/, '');
  } catch {
    return null;
  }
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return null;

  let branchHint: string | undefined;
  if (seg[2] && BRANCH_VIEWS.has(seg[2]) && seg.length > 3) {
    try {
      branchHint = seg.slice(3).map(decodeURIComponent).join('/');
    } catch {
      branchHint = undefined;
    }
  }
  return { owner, repo, branchHint };
}
