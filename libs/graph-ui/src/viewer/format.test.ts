import { describe, expect, it } from 'vitest';
import { formatAbsolute, parseSubject } from './format.ts';

describe('parseSubject', () => {
  it.each([
    ['feat: add search', { type: 'feat', scope: undefined, breaking: false, rest: 'add search' }],
    ['fix(core)!: drop it', { type: 'fix', scope: 'core', breaking: true, rest: 'drop it' }],
    ['Docs(readme): words', { type: 'docs', scope: 'readme', breaking: false, rest: 'words' }],
    ['revert: x', { type: 'revert', scope: undefined, breaking: false, rest: 'x' }],
  ])('%s', (subject, expected) => {
    expect(parseSubject(subject)).toEqual(expected);
  });

  it('leaves everything else alone (no false positives on ordinary sentences)', () => {
    for (const s of [
      'Merge branch main',
      'Fixed: the thing',
      'feature: not a conventional type',
      'fix:nospace',
      'Update README',
      '',
    ]) {
      expect(parseSubject(s)).toEqual({ rest: s });
    }
  });
});

describe('formatAbsolute', () => {
  it('formats valid dates and returns an empty string for garbage', () => {
    expect(formatAbsolute('2026-10-09T02:00:00Z', 'en')).toMatch(/2026/);
    expect(formatAbsolute('not a date', 'en')).toBe('');
    expect(formatAbsolute('', 'zh-TW')).toBe('');
  });
});
