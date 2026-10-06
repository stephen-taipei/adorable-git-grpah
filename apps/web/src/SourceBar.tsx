import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { parseRepoInput } from './source';
import type { Source } from './source';
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
            onNavigate({ kind: 'local' });
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
        className="web-icon"
        title={THEME_LABEL[theme]}
        aria-label={THEME_LABEL[theme]}
        onClick={() => onThemeChange(NEXT_THEME[theme])}
      >
        {THEME_ICON[theme]}
      </button>
    </div>
  );
}
