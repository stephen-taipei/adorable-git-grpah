import { describe, expect, it } from 'vitest';
import { parseRepoInput, searchFromSource, sourceFromSearch } from './source';

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
