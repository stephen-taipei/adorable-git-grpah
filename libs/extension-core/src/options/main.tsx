import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Mascot, detectLocale } from '@adorable/graph-ui';
import type { Locale } from '@adorable/graph-ui';
import { sendToBackground } from '../shared/messages';
import type { RateLimitResponse } from '../shared/messages';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings';
import type { Settings } from '../shared/settings';
import './options.css';

const T = {
  'zh-TW': {
    title: 'Adorable Git Graph 設定',
    token: 'GitHub Token（選填）',
    tokenHelp:
      '未登入每小時只能呼叫 60 次 GitHub API；加入 token 可提升到 5,000 次，並可讀取私有 repo。',
    tokenWarn:
      '請使用 fine-grained token，Repository access 只勾要看的 repo，權限只開 Contents: Read-only 與 Metadata: Read-only。Token 只存在這個瀏覽器的本機 extension 儲存空間，且只會送往 api.github.com。請勿使用有寫入權限的 token。',
    maxBranches: '最多顯示幾條分支',
    maxCommits: '每條分支抓幾筆 commit',
    cache: '快取（分鐘，0 = 不快取）',
    save: '儲存',
    saved: '已儲存 ✓',
    test: '測試 / 查看額度',
    clear: '清除快取',
    cleared: '快取已清除 ✓',
    limit: (r: number, l: number, auth: boolean) =>
      `剩餘 ${r} / ${l} 次（${auth ? '已使用 token' : '未登入'}）`,
    fail: (m: string) => `失敗：${m}`,
  },
  en: {
    title: 'Adorable Git Graph settings',
    token: 'GitHub token (optional)',
    tokenHelp:
      'Anonymous requests are limited to 60 GitHub API calls per hour. A token raises that to 5,000 and unlocks private repositories.',
    tokenWarn:
      'Use a fine-grained token limited to the repositories you want to view, with only Contents: Read-only and Metadata: Read-only. It is stored only in the local extension storage of this browser and sent solely to api.github.com. Never use a token with write access.',
    maxBranches: 'Max branches to show',
    maxCommits: 'Commits fetched per branch',
    cache: 'Cache (minutes, 0 = off)',
    save: 'Save',
    saved: 'Saved ✓',
    test: 'Test / check quota',
    clear: 'Clear cache',
    cleared: 'Cache cleared ✓',
    limit: (r: number, l: number, auth: boolean) =>
      `${r} / ${l} left (${auth ? 'with token' : 'anonymous'})`,
    fail: (m: string) => `Failed: ${m}`,
  },
} satisfies Record<Locale, unknown>;

function Options() {
  const locale = detectLocale();
  const t = T[locale];
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void loadSettings().then((v) => {
      setS(v);
      setLoaded(true);
    });
  }, []);

  const num = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS((p) => ({ ...p, [key]: Number(e.target.value) }));

  const save = async () => {
    await saveSettings(s);
    setS(await loadSettings());
    setStatus(t.saved);
  };

  const test = async () => {
    await saveSettings(s);
    const res = await sendToBackground<RateLimitResponse>({ type: 'rate-limit' });
    setStatus(
      res.ok
        ? t.limit(res.data.remaining, res.data.limit, res.data.authenticated)
        : t.fail(res.error.message),
    );
  };

  const clear = async () => {
    await sendToBackground({ type: 'clear-cache' });
    setStatus(t.cleared);
  };

  return (
    <main className="card">
      <h1>
        <Mascot size={44} /> {t.title}
      </h1>
      <label>
        <span>{t.token}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="github_pat_…"
          value={s.token}
          disabled={!loaded}
          onChange={(e) => setS((p) => ({ ...p, token: e.target.value }))}
        />
      </label>
      <p className="help">{t.tokenHelp}</p>
      <p className="warn">{t.tokenWarn}</p>
      <div className="grid">
        <label>
          <span>{t.maxBranches}</span>
          <input
            type="number"
            min={1}
            max={12}
            value={s.maxBranches}
            onChange={num('maxBranches')}
          />
        </label>
        <label>
          <span>{t.maxCommits}</span>
          <input
            type="number"
            min={10}
            max={100}
            value={s.maxCommitsPerBranch}
            onChange={num('maxCommitsPerBranch')}
          />
        </label>
        <label>
          <span>{t.cache}</span>
          <input
            type="number"
            min={0}
            max={120}
            value={s.cacheMinutes}
            onChange={num('cacheMinutes')}
          />
        </label>
      </div>
      <div className="row">
        <button type="button" className="cta" onClick={save}>
          {t.save}
        </button>
        <button type="button" className="cta ghost" onClick={test}>
          {t.test}
        </button>
        <button type="button" className="cta ghost" onClick={clear}>
          {t.clear}
        </button>
        <output aria-live="polite">{status}</output>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
