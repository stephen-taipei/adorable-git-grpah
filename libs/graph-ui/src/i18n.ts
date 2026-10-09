export type Locale = 'zh-TW' | 'en';

export interface Messages {
  replay: string;
  latest: string;
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
  tags: (n: number) => string;
  authors: (n: number) => string;
  merges: (n: number) => string;
  lastCommit: (rel: string) => string;
  truncated: string;
  webglFail: string;
  // 列表 / 搜尋
  listLabel: string;
  colGraph: string;
  colMessage: string;
  colAuthor: string;
  colDate: string;
  colCommit: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearSearch: string;
  noMatches: string;
  matchCount: (current: number, total: number) => string;
  nextMatch: string;
  prevMatch: string;
  branchFilterLabel: string;
  focusBranch: (name: string) => string;
  branchTitle: (name: string, sha: string, commits: number, ahead: number, base: string) => string;
  filtering: (n: number, total: number) => string;
  startOfHistory: string;
  // 標籤
  headLabel: string;
  mergeLabel: string;
  remoteLabel: string;
  defaultLabel: string;
  tagLabel: string;
  moreRefs: (n: number) => string;
  // 詳情
  detailTitle: string;
  closeDetail: string;
  copySha: string;
  copyShaFull: string;
  copied: string;
  copyFailed: string;
  openCommit: string;
  fullSha: string;
  authorLabel: string;
  dateLabel: string;
  parentsLabel: string;
  childrenLabel: string;
  noParents: string;
  mergeOf: (n: number) => string;
  refsLabel: string;
  containedIn: string;
  containedInNote: string;
  noMessage: string;
  prevCommit: string;
  nextCommit: string;
  kinds: Record<string, string>;
  errors: Record<string, string>;
  rateLimitReset: (time: string) => string;
  addToken: string;
}

const zhTW: Messages = {
  replay: '重播',
  latest: '回到最新',
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
  tags: (n) => `${n} 個 tag`,
  authors: (n) => `${n} 位作者`,
  merges: (n) => `${n} 次 merge`,
  lastCommit: (rel) => `最新 ${rel}`,
  truncated: '更早的歷史已省略',
  webglFail: '這個瀏覽器無法使用 WebGL，無法繪製動畫。',
  listLabel: 'Commit 歷史',
  colGraph: '線圖',
  colMessage: '說明',
  colAuthor: '作者',
  colDate: '日期',
  colCommit: 'Commit',
  searchLabel: '搜尋 commit',
  searchPlaceholder: '搜尋說明、作者、sha、分支…',
  clearSearch: '清除搜尋',
  noMatches: '沒有符合的 commit',
  matchCount: (c, n) => `${c} / ${n}`,
  nextMatch: '下一筆符合',
  prevMatch: '上一筆符合',
  branchFilterLabel: '分支',
  focusBranch: (name) => `只看 ${name} 的歷史`,
  branchTitle: (name, sha, commits, ahead, base) =>
    `${name} · ${sha} · ${commits} 個 commit${ahead > 0 ? ` · 比 ${base} 多 ${ahead} 個` : ''}`,
  filtering: (n, total) => `顯示 ${n} / ${total} 個 commit`,
  startOfHistory: '最初的 commit 在這裡',
  headLabel: 'HEAD',
  mergeLabel: 'merge',
  remoteLabel: '遠端分支',
  defaultLabel: '預設分支',
  tagLabel: 'tag',
  moreRefs: (n) => `+${n}`,
  detailTitle: 'Commit 詳情',
  closeDetail: '關閉詳情',
  copySha: '複製 SHA',
  copyShaFull: '複製完整 SHA',
  copied: '已複製',
  copyFailed: '複製失敗',
  openCommit: '在 GitHub 開啟',
  fullSha: '完整 SHA',
  authorLabel: '作者',
  dateLabel: '時間',
  parentsLabel: 'Parent',
  childrenLabel: '子 commit',
  noParents: '最初的 commit（沒有 parent）',
  mergeOf: (n) => `合併了 ${n} 條歷史`,
  refsLabel: '指向這裡的分支 / tag',
  containedIn: '包含於',
  containedInNote: '只計算已載入的範圍',
  noMessage: '（沒有說明）',
  prevCommit: '上一個（較新）',
  nextCommit: '下一個（較舊）',
  kinds: {
    root: '初始',
    merge: '合併',
    feat: '功能',
    fix: '修正',
    revert: '還原',
    docs: '文件',
    chore: '雜務',
    normal: '一般',
  },
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
  latest: 'Jump to latest',
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
  tags: (n) => `${n} tag${n === 1 ? '' : 's'}`,
  authors: (n) => `${n} author${n === 1 ? '' : 's'}`,
  merges: (n) => `${n} merge${n === 1 ? '' : 's'}`,
  lastCommit: (rel) => `latest ${rel}`,
  truncated: 'older history omitted',
  webglFail: 'WebGL is not available in this browser.',
  listLabel: 'Commit history',
  colGraph: 'Graph',
  colMessage: 'Description',
  colAuthor: 'Author',
  colDate: 'Date',
  colCommit: 'Commit',
  searchLabel: 'Search commits',
  searchPlaceholder: 'Search message, author, sha, branch…',
  clearSearch: 'Clear search',
  noMatches: 'No matching commits',
  matchCount: (c, n) => `${c} / ${n}`,
  nextMatch: 'Next match',
  prevMatch: 'Previous match',
  branchFilterLabel: 'Branches',
  focusBranch: (name) => `Show only the history of ${name}`,
  branchTitle: (name, sha, commits, ahead, base) =>
    `${name} · ${sha} · ${commits} commit${commits === 1 ? '' : 's'}${ahead > 0 ? ` · ${ahead} ahead of ${base}` : ''}`,
  filtering: (n, total) => `Showing ${n} of ${total} commits`,
  startOfHistory: 'the first commit lives here',
  headLabel: 'HEAD',
  mergeLabel: 'merge',
  remoteLabel: 'remote branch',
  defaultLabel: 'default branch',
  tagLabel: 'tag',
  moreRefs: (n) => `+${n}`,
  detailTitle: 'Commit details',
  closeDetail: 'Close details',
  copySha: 'Copy SHA',
  copyShaFull: 'Copy full SHA',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  openCommit: 'Open on GitHub',
  fullSha: 'Full SHA',
  authorLabel: 'Author',
  dateLabel: 'Date',
  parentsLabel: 'Parents',
  childrenLabel: 'Children',
  noParents: 'Initial commit (no parent)',
  mergeOf: (n) => `merges ${n} lines of history`,
  refsLabel: 'Branches / tags at this commit',
  containedIn: 'In branches',
  containedInNote: 'only counts the loaded range',
  noMessage: '(no message)',
  prevCommit: 'Previous (newer)',
  nextCommit: 'Next (older)',
  kinds: {
    root: 'initial',
    merge: 'merge',
    feat: 'feature',
    fix: 'fix',
    revert: 'revert',
    docs: 'docs',
    chore: 'chore',
    normal: 'commit',
  },
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
