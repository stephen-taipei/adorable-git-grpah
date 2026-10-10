import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { localSource, parseRepoInput } from './source';
import type { Source } from './source';
import { DEFAULT_REPO } from './protocol';
import type { ReposResponse } from './protocol';
import { addLocalRepo, fetchLocalRepos } from './localRepos';
import { t } from './i18n';

export type ThemeSetting = 'auto' | 'day' | 'night';
export const isThemeSetting = (v: string): v is ThemeSetting =>
  v === 'auto' || v === 'day' || v === 'night';

const NEXT_THEME: Record<ThemeSetting, ThemeSetting> = { auto: 'day', day: 'night', night: 'auto' };
const THEME_ICON: Record<ThemeSetting, string> = { auto: '🌓', day: '☀️', night: '🌙' };
const THEME_LABEL: Record<ThemeSetting, string> = {
  auto: t.themeAuto,
  day: t.themeDay,
  night: t.themeNight,
};

export function SourceBar({
  source,
  onNavigate,
  theme,
  onThemeChange,
}: {
  source: Source;
  onNavigate: (s: Source) => void;
  theme: ThemeSetting;
  onThemeChange: (t: ThemeSetting) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(
    source.kind === 'github' ? `${source.owner}/${source.repo}` : '',
  );
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const showInput = source.kind === 'github' || editing;

  useEffect(() => {
    if (source.kind === 'github') setText(`${source.owner}/${source.repo}`);
    else setEditing(false);
  }, [source]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRepoInput(text);
    setInvalid(!parsed);
    if (parsed) onNavigate({ kind: 'github', ...parsed });
  };

  return (
    <div className="web-bar">
      <div className="web-seg" role="group" aria-label="source">
        <button
          type="button"
          aria-pressed={source.kind === 'local'}
          onClick={() => {
            setEditing(false);
            setInvalid(false);
            // 已經在本機時不要把選好的 repo 換回預設
            if (source.kind !== 'local') onNavigate({ kind: 'local' });
          }}
        >
          📍 {t.local}
        </button>
        <button
          type="button"
          aria-pressed={source.kind === 'github' || editing}
          onClick={() => setEditing(true)}
        >
          🐙 {t.github}
        </button>
      </div>

      {/* 只有 dev server 能列出 / 讀取其他本機 repo；靜態建置只有建置當下的那一個 */}
      {import.meta.env.DEV && source.kind === 'local' && !editing && (
        <LocalPicker
          current={source.id ?? DEFAULT_REPO}
          onPick={(id) => onNavigate(localSource(id))}
        />
      )}

      {showInput && (
        <form className="web-form" onSubmit={submit}>
          <input
            ref={inputRef}
            className="web-input"
            value={text}
            placeholder={t.repoPlaceholder}
            aria-label={t.repoPlaceholder}
            aria-invalid={invalid}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
            }}
          />
          <button type="submit" className="web-go">
            {t.go}
          </button>
        </form>
      )}

      <button
        type="button"
        className="web-icon web-theme"
        title={THEME_LABEL[theme]}
        aria-label={THEME_LABEL[theme]}
        onClick={() => onThemeChange(NEXT_THEME[theme])}
      >
        {THEME_ICON[theme]}
      </button>
    </div>
  );
}

const ADD = '__add';
const CURRENT = '__current';

/** 本機 repo 選單：dev server 掃描到的 repo + 手動輸入路徑。瀏覽器只送出 repo id（和使用者自己輸入的路徑）。 */
function LocalPicker({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const [list, setList] = useState<ReposResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const next = await fetchLocalRepos();
    if (next) setList(next);
    setFailed(!next);
  }, []);

  useEffect(() => {
    void reload();
    // 回到這個分頁時（例如剛在終端機 clone / git init 了新的 repo）更新清單
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const repos = list?.repos ?? [];
  const selected = repos.find((r) => r.id === current);

  const cancel = () => {
    setAdding(false);
    setError(null);
    selectRef.current?.focus();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await addLocalRepo(path);
    setBusy(false);
    if (!result.ok) {
      setError(t.pathErrors[result.error]);
      return;
    }
    setAdding(false);
    setPath('');
    void reload();
    onPick(result.repo.id);
  };

  return (
    <>
      <select
        ref={selectRef}
        className="web-select"
        aria-label={t.pickRepo}
        title={selected?.label ?? t.pickRepo}
        value={selected ? current : CURRENT}
        onChange={(e) => {
          const value = e.target.value;
          if (value === ADD) setAdding(true);
          else if (value !== CURRENT) onPick(value);
        }}
      >
        {!selected && (
          <option value={CURRENT}>
            {current === DEFAULT_REPO ? t.localTitle : t.localUnlisted}
          </option>
        )}
        {repos.map((r) => (
          <option key={r.id} value={r.id} title={r.label}>
            {r.isDefault ? '★ ' : ''}
            {r.name} — {r.label}
          </option>
        ))}
        {list?.truncated && (
          <option value="" disabled>
            {t.reposTruncated}
          </option>
        )}
        {failed && !list && (
          <option value="" disabled>
            {t.reposFailed}
          </option>
        )}
        <option value={ADD}>{t.addPath}</option>
      </select>

      {adding && (
        <form className="web-form" onSubmit={(e) => void submit(e)}>
          <input
            ref={inputRef}
            className="web-input"
            value={path}
            placeholder={t.pathPlaceholder}
            aria-label={t.pathLabel}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'web-path-error' : undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                e.stopPropagation();
                cancel();
              }
            }}
          />
          <button type="submit" className="web-go" disabled={busy || !path.trim()}>
            {t.open}
          </button>
          <button
            type="button"
            className="web-icon"
            aria-label={t.cancel}
            title={t.cancel}
            onClick={cancel}
          >
            ✕
          </button>
        </form>
      )}
      {error && (
        <span id="web-path-error" className="web-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
