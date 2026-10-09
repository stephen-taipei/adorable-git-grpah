import { detectLocale } from '@adorable/graph-ui';
import type { Locale } from '@adorable/graph-ui';

const zh = {
  local: '本機',
  github: 'GitHub',
  repoPlaceholder: 'owner/repo 或 GitHub 網址',
  go: '前往',
  themeAuto: '主題：跟隨系統',
  themeDay: '主題：白天',
  themeNight: '主題：夜晚',
  localTitle: '本機 repository',
  tokenTitle: 'GitHub Token（選填）',
  tokenHelp: '未登入每小時只能呼叫 60 次 GitHub API；加入 token 可提升到 5,000 次並讀取私有 repo。',
  tokenWarn:
    '請使用 fine-grained token，只勾要看的 repo，權限只開 Contents: Read-only 與 Metadata: Read-only，不要用有寫入權限的 token。Token 只存在這個瀏覽器的 localStorage，只會送往 api.github.com。',
  save: '儲存',
  clear: '清除',
  cancel: '取消',
  localHint: '正在讀取本機 git 歷史；有新 commit 時畫面會自己更新。',
};

const en: typeof zh = {
  local: 'Local',
  github: 'GitHub',
  repoPlaceholder: 'owner/repo or GitHub URL',
  go: 'Go',
  themeAuto: 'Theme: follow system',
  themeDay: 'Theme: day',
  themeNight: 'Theme: night',
  localTitle: 'Local repository',
  tokenTitle: 'GitHub token (optional)',
  tokenHelp:
    'Anonymous requests are limited to 60 GitHub API calls per hour. A token raises that to 5,000 and unlocks private repos.',
  tokenWarn:
    'Use a fine-grained token limited to the repos you want to view, with only Contents: Read-only and Metadata: Read-only. Never use a token with write access. It is stored in this browser’s localStorage and sent only to api.github.com.',
  save: 'Save',
  clear: 'Clear',
  cancel: 'Cancel',
  localHint: 'Reading your local git history; the view updates when you commit.',
};

export const locale: Locale = detectLocale();
export const t = locale === 'zh-TW' ? zh : en;
