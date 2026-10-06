export interface Settings {
  /** GitHub PAT（建議 fine-grained、唯讀）。只存在 chrome.storage.local，只會送往 api.github.com。 */
  token: string;
  maxBranches: number;
  maxCommitsPerBranch: number;
  cacheMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  token: '',
  maxBranches: 5,
  maxCommitsPerBranch: 60,
  cacheMinutes: 10,
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    token: typeof raw?.token === 'string' ? raw.token.trim() : d.token,
    maxBranches: clampInt(raw?.maxBranches, 1, 12, d.maxBranches),
    maxCommitsPerBranch: clampInt(raw?.maxCommitsPerBranch, 10, 100, d.maxCommitsPerBranch),
    cacheMinutes: clampInt(raw?.cacheMinutes, 0, 120, d.cacheMinutes),
  };
}

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const out = await chrome.storage.local.get(KEY);
  return normalizeSettings(out[KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: normalizeSettings(settings) });
}

export const SETTINGS_KEY = KEY;
