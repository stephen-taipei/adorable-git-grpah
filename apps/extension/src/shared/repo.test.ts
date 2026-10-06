import { describe, expect, it } from 'vitest';
import { parseRepoPath } from './repo';

describe('parseRepoPath', () => {
  it('parses owner/repo from the repo root and sub pages', () => {
    expect(parseRepoPath('/stephen-taipei/adorable-git-grpah')).toEqual({
      owner: 'stephen-taipei',
      repo: 'adorable-git-grpah',
      branchHint: undefined,
    });
    expect(parseRepoPath('/o/r/issues/12')).toMatchObject({ owner: 'o', repo: 'r' });
    expect(parseRepoPath('/o/r.git/')).toMatchObject({ repo: 'r' });
  });

  it('extracts the branch hint (which may contain slashes) from tree/blob/commits views', () => {
    expect(parseRepoPath('/o/r/tree/feat/x/src')?.branchHint).toBe('feat/x/src');
    expect(parseRepoPath('/o/r/blob/main/README.md')?.branchHint).toBe('main/README.md');
    expect(parseRepoPath('/o/r/commits/main')?.branchHint).toBe('main');
    expect(parseRepoPath('/o/r/commit/abc')?.branchHint).toBeUndefined();
    expect(parseRepoPath('/o/r/tree')?.branchHint).toBeUndefined();
  });

  it.each([
    '/',
    '/o',
    '/settings/profile',
    '/orgs/acme/people',
    '/marketplace/actions',
    '/explore/x',
    '/o/%E0%A4%A',
  ])('ignores non-repo path %s', (path) => {
    expect(parseRepoPath(path)).toBeNull();
  });

  it('rejects names that are not valid GitHub segments', () => {
    expect(parseRepoPath('/o/..')).toBeNull();
    expect(parseRepoPath('/o/a b')).toBeNull();
    expect(parseRepoPath('/o/<script>')).toBeNull();
  });
});
