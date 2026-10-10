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
  pickRepo: '選擇本機 repository',
  localUnlisted: '（不在清單中的 repository）',
  addPath: '＋ 開啟其他路徑…',
  pathLabel: 'git repository 的路徑',
  pathPlaceholder: '/path/to/repo 或 ~/code/repo',
  open: '開啟',
  reposTruncated: '…清單已達掃描上限（可用 AGG_REPO_ROOTS 指定資料夾）',
  reposFailed: '無法取得 repository 清單',
  pathErrors: {
    invalid_path: '請輸入路徑。',
    not_absolute: '請輸入絕對路徑（可以用 ~ 代表家目錄）。',
    not_found: '找不到這個資料夾。',
    not_git: '這個資料夾不在 git repository 裡。',
    failed: '無法開啟（dev server 沒有回應）。',
  },
  localUnknown:
    'dev server 找不到這個本機 repository（可能已移動、刪除，或 dev server 重新啟動後不在掃描範圍內）。請從上方選單重新選擇。',
  localOffline: '連不到 dev server，無法讀取這個本機 repository。',
  localFailed: '無法讀取本機的 git 歷史。',
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
  pickRepo: 'Choose a local repository',
  localUnlisted: '(repository not in the list)',
  addPath: '+ Open another path…',
  pathLabel: 'Path to a git repository',
  pathPlaceholder: '/path/to/repo or ~/code/repo',
  open: 'Open',
  reposTruncated: '…scan limit reached (set AGG_REPO_ROOTS to pick folders)',
  reposFailed: 'Could not load the repository list',
  pathErrors: {
    invalid_path: 'Enter a path.',
    not_absolute: 'Enter an absolute path (~ for your home folder works).',
    not_found: 'That folder does not exist.',
    not_git: 'That folder is not inside a git repository.',
    failed: 'Could not open it (the dev server did not respond).',
  },
  localUnknown:
    'The dev server does not know this local repository (it may have moved, been deleted, or fallen outside the scanned folders after a restart). Pick one from the menu above.',
  localOffline: 'Cannot reach the dev server to read this local repository.',
  localFailed: 'Could not read the local git history.',
};

export const locale: Locale = detectLocale();
export const t = locale === 'zh-TW' ? zh : en;
