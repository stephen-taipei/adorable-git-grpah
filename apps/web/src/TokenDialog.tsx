import { useEffect, useRef, useState } from 'react';
import { Mascot } from '@adorable/graph-ui';
import { t } from './i18n';

export function TokenDialog({
  token,
  onSave,
  onClose,
}: {
  token: string;
  onSave: (token: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(token);
  const inputRef = useRef<HTMLInputElement>(null);

  // onClose 的身分每次 render 都會變：放進 ref，避免 effect 重跑把焦點搶回輸入框
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="web-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="web-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t.tokenTitle}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value.trim());
        }}
      >
        <h2>
          <Mascot size={40} /> {t.tokenTitle}
        </h2>
        <input
          ref={inputRef}
          className="web-input web-input--wide"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="github_pat_…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <p>{t.tokenHelp}</p>
        <p className="web-warn">{t.tokenWarn}</p>
        <div className="web-row">
          <button type="submit" className="web-cta">
            {t.save}
          </button>
          <button
            type="button"
            className="web-cta web-cta--ghost"
            onClick={() => {
              setValue('');
              onSave('');
            }}
          >
            {t.clear}
          </button>
          <button type="button" className="web-cta web-cta--ghost" onClick={onClose}>
            {t.cancel}
          </button>
        </div>
      </form>
    </div>
  );
}
