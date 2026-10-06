export type Locale = 'zh-TW' | 'en';

export interface Messages {
  replay: string;
  fit: string;
  refresh: string;
  close: string;
  settings: string;
  loading: string;
  loadingSub: string;
  emptyTitle: string;
  emptySub: string;
  errorTitle: string;
  retry: string;
  crashTitle: string;
  crashSub: string;
  reload: string;
  commits: (n: number) => string;
  branches: (n: number) => string;
  truncated: string;
  hint: string;
  clickToOpen: string;
  webglFail: string;
  errors: Record<string, string>;
  rateLimitReset: (time: string) => string;
  addToken: string;
}

const zhTW: Messages = {
  replay: '重播',
  fit: '全景',
  refresh: '重新整理',
  close: '關閉',
  settings: '設定',
  loading: '正在數 commit…',
  loadingSub: '小球們排隊中',
  emptyTitle: '這裡還沒有 commit',
  emptySub: '先 commit 一次，小球就會出現啦',
  errorTitle: '哎呀，出錯了',
  retry: '再試一次',
  crashTitle: '畫面當機了',
  crashSub: '資料可能有問題，重新載入通常就會好。',
  reload: '重新載入',
  commits: (n) => `${n} 個 commit`,
  branches: (n) => `${n} 條分支`,
  truncated: '更早的歷史已省略',
  hint: '拖曳平移 · 滾輪縮放 · 點擊前往 GitHub',
  clickToOpen: '點擊開啟',
  webglFail: '這個瀏覽器無法使用 WebGL，無法繪製動畫。',
  errors: {
    invalid_repo: '無法辨識這個 repository 名稱。',
    not_found: '找不到這個 repository。若是私有 repo，請在設定中加入 token。',
    unauthorized: 'Token 無效或權限不足。',
    rate_limited: 'GitHub API 次數用完了（未登入每小時 60 次）。',
    empty_repo: '這個 repository 是空的。',
    network: '網路錯誤，請檢查連線。',
    unknown: '發生未知錯誤。',
  },
  rateLimitReset: (time) => `約 ${time} 後恢復`,
  addToken: '加入 token 可提升到每小時 5,000 次',
};

const en: Messages = {
  replay: 'Replay',
  fit: 'Fit',
  refresh: 'Refresh',
  close: 'Close',
  settings: 'Settings',
  loading: 'Counting commits…',
  loadingSub: 'the little balls are lining up',
  emptyTitle: 'No commits here yet',
  emptySub: 'Make a commit and a ball will pop out!',
  errorTitle: 'Oops, something broke',
  retry: 'Try again',
  crashTitle: 'The view crashed',
  crashSub: 'Something in the data looks off. Reloading usually fixes it.',
  reload: 'Reload',
  commits: (n) => `${n} commit${n === 1 ? '' : 's'}`,
  branches: (n) => `${n} branch${n === 1 ? '' : 'es'}`,
  truncated: 'older history omitted',
  hint: 'drag to pan · scroll to zoom · click to open on GitHub',
  clickToOpen: 'Click to open',
  webglFail: 'WebGL is not available in this browser.',
  errors: {
    invalid_repo: 'Could not recognise this repository name.',
    not_found: 'Repository not found. For private repos add a token in settings.',
    unauthorized: 'Token is invalid or lacks permission.',
    rate_limited: 'GitHub API rate limit reached (60/h without a token).',
    empty_repo: 'This repository is empty.',
    network: 'Network error. Please check your connection.',
    unknown: 'Unknown error.',
  },
  rateLimitReset: (time) => `resets in about ${time}`,
  addToken: 'Add a token to raise the limit to 5,000/h',
};

export function detectLocale(lang?: string): Locale {
  const l = (lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')).toLowerCase();
  return l.startsWith('zh') ? 'zh-TW' : 'en';
}

export function getMessages(locale: Locale): Messages {
  return locale === 'zh-TW' ? zhTW : en;
}

export function formatRelative(iso: string, locale: Locale, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = (ms - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function formatDuration(ms: number, locale: Locale): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  return locale === 'zh-TW' ? `${mins} 分鐘` : `${mins} min`;
}
