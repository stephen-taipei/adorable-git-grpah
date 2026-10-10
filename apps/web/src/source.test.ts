import { describe, expect, it } from 'vitest';
import { localSource, parseRepoInput, searchFromSource, sourceFromSearch } from './source';

describe('parseRepoInput', () => {
  it.each([
    ['octo/cat', { owner: 'octo', repo: 'cat' }],
    ['  octo/cat  ', { owner: 'octo', repo: 'cat' }],
    ['https://github.com/octo/cat', { owner: 'octo', repo: 'cat' }],
    ['https://github.com/octo/cat.git', { owner: 'octo', repo: 'cat' }],
    ['github.com/octo/cat/tree/main/src', { owner: 'octo', repo: 'cat' }],
    ['https://www.github.com/octo/cat/issues/1?x=1', { owner: 'octo', repo: 'cat' }],
    ['git@github.com:octo/cat.git', { owner: 'octo', repo: 'cat' }],
  ])('%s', (input, expected) => {
    expect(parseRepoInput(input)).toEqual(expected);
  });

  it.each([
    '',
    'octo',
    'octo/',
    '/cat',
    '../etc/passwd',
    'octo/..',
    'a b/c',
    'https://evil.example/octo/cat',
    'evil.example/octo/cat',
    'http://github.com.evil.example/octo/cat',
    'javascript:alert(1)//x/y',
  ])('rejects %j', (input) => {
    expect(parseRepoInput(input)).toBeNull();
  });
});

describe('source <-> url search', () => {
  it('round-trips a GitHub source and falls back to local', () => {
    expect(sourceFromSearch('')).toEqual({ kind: 'local' });
    expect(sourceFromSearch('?repo=nope')).toEqual({ kind: 'local' });
    expect(sourceFromSearch('?repo=octo/cat')).toEqual({
      kind: 'github',
      owner: 'octo',
      repo: 'cat',
    });
    expect(searchFromSource({ kind: 'github', owner: 'octo', repo: 'cat' })).toBe('?repo=octo/cat');
    expect(searchFromSource({ kind: 'local' })).toBe('');
    expect(
      sourceFromSearch(searchFromSource({ kind: 'github', owner: 'a-b', repo: 'c_d.e' })),
    ).toEqual({
      kind: 'github',
      owner: 'a-b',
      repo: 'c_d.e',
    });
  });
});

describe('local repo ids in the url', () => {
  it('round-trips `?local=<id>` and only accepts server-style ids (never paths)', () => {
    expect(sourceFromSearch('?local=0123456789ab')).toEqual({ kind: 'local', id: '0123456789ab' });
    expect(searchFromSource({ kind: 'local', id: '0123456789ab' })).toBe('?local=0123456789ab');
    expect(sourceFromSearch(searchFromSource({ kind: 'local', id: 'abcdefabcdef' }))).toEqual({
      kind: 'local',
      id: 'abcdefabcdef',
    });
    for (const bad of ['/etc', '..%2F..', 'ABCDEF012345', '0123456789abc', '~/code', 'default']) {
      expect(sourceFromSearch(`?local=${bad}`), bad).toEqual({ kind: 'local' });
    }
    // 預設 repo 不帶參數；GitHub 參數優先
    expect(searchFromSource({ kind: 'local', id: 'default' })).toBe('');
    expect(sourceFromSearch('?repo=octo/cat&local=0123456789ab')).toMatchObject({ kind: 'github' });
    expect(localSource('default')).toEqual({ kind: 'local' });
    expect(localSource(undefined)).toEqual({ kind: 'local' });
    expect(localSource('0123456789ab')).toEqual({ kind: 'local', id: '0123456789ab' });
  });
});
