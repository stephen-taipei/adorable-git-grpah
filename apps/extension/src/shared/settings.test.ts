import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';

describe('normalizeSettings', () => {
  it('falls back to defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it('clamps numbers, trims the token and ignores garbage', () => {
    const s = normalizeSettings({
      token: '  github_pat_x \n',
      maxBranches: 999,
      maxCommitsPerBranch: -5,
      cacheMinutes: Number.NaN,
    });
    expect(s).toEqual({
      token: 'github_pat_x',
      maxBranches: 12,
      maxCommitsPerBranch: 10,
      cacheMinutes: DEFAULT_SETTINGS.cacheMinutes,
    });
  });
});
