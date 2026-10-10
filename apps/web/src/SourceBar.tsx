import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { localSource, parseRepoInput } from './source';
import type { Source } from './source';
import { DEFAULT_REPO } from './protocol';
import type { ReposResponse } from './protocol';
import { LOCAL_ONLY, addLocalRepo, fetchLocalRepos } from './localRepos';
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
  lastLocal,
  onNavigate,
  theme,
  onThemeChange,
  extra,
}: {
  source: Source;
  /** 最近一次看的本機 repo：從 GitHub 切回「本機」時回到它，而不是預設 repo */
  lastLocal: Source;
  onNavigate: (s: Source) => void;
  theme: ThemeSetting;
  onThemeChange: (t: ThemeSetting) => void;
  /** 接在同一排最後面的內容（本機 repo 的 git 動作列）：寬螢幕靠右，放不下時換行 */
  extra?: ReactNode;
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
            if (source.kind !== 'local') onNavigate(lastLocal);
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

      {extra}
    </div>
  );
}

const CURRENT = '__current';
/** 鍵盤在「關著的」select 上移動時，Chrome / Firefox 每按一下就觸發一次 change：停下來這麼久才真的切換 */
const KEY_SETTLE_MS = 700;
const isKeyNav = (e: KeyboardEvent<HTMLSelectElement>) =>
  /^(Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down))$/.test(e.key) ||
  (e.key.length === 1 && e.key !== ' ' && !e.altKey && !e.ctrlKey && !e.metaKey);

/** 本機 repo 選單：dev server 掃描到的 repo + 手動輸入路徑。瀏覽器只送出 repo id（和使用者自己輸入的路徑）。 */
function LocalPicker({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const [list, setList] = useState<ReposResponse | null>(null);
  const [failed, setFailed] = useState<false | 'offline' | typeof LOCAL_ONLY>(false);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 鍵盤移動中、還沒確定的選擇 */
  const [pending, setPending] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listSeq = useRef(0);
  const addSeq = useRef(0);
  const keyNav = useRef(false);
  const settle = useRef<number | undefined>(undefined);
  const currentRef = useRef(current);
  currentRef.current = current;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** 卸載後才回來的「加入路徑」結果不能再切換畫面（不用 addSeq：Fast Refresh 重跑 effect 時不算卸載） */
  const alive = useRef(true);

  const reload = useCallback(async () => {
    const seq = ++listSeq.current;
    const next = await fetchLocalRepos();
    if (seq !== listSeq.current) return; // 比較晚發出的請求已經回來了
    if (next && next !== LOCAL_ONLY) setList(next);
    setFailed(next === LOCAL_ONLY ? LOCAL_ONLY : next ? false : 'offline');
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    // 回到這個分頁時（例如剛在終端機 clone / git init 了新的 repo）更新清單
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      window.removeEventListener('focus', onFocus);
      window.clearTimeout(settle.current);
    };
  }, [reload]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  // 切到清單裡還沒有的 repo（例如剛新增、從 worktree 清單開啟的 worktree）：重新拿一次清單，選單才顯示得出名字
  const listed = list ? list.repos.some((r) => r.id === current) : true;
  useEffect(() => {
    if (!listed && current !== DEFAULT_REPO) void reload();
    // 只在換了 repo 時檢查（清單回來後仍不在裡面就維持「不在清單中」，不會一直重抓）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const commit = (value: string) => {
    window.clearTimeout(settle.current);
    keyNav.current = false;
    setPending(null);
    if (value !== CURRENT && value !== currentRef.current) onPick(value);
  };

  const repos = list?.repos ?? [];
  const selected = repos.find((r) => r.id === current);
  const shown = pending ?? (selected ? current : CURRENT);

  const cancel = () => {
    addSeq.current++; // 還在路上的請求回來後不要切換
    setBusy(false);
    setAdding(false);
    setError(null);
    selectRef.current?.focus();
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !path.trim()) return;
    const form = e.currentTarget;
    // 等待期間使用者可能已經去做別的事（點了 commit、在搜尋框打字）：焦點還在表單（或掉到 body）才移動它
    const focusIsOurs = () => {
      const active = document.activeElement;
      return !active || active === document.body || form.contains(active);
    };
    const seq = ++addSeq.current;
    const before = currentRef.current;
    setBusy(true);
    setError(null);
    const result = await addLocalRepo(path);
    if (!alive.current || seq !== addSeq.current) return; // 卸載了 / 取消了（cancel 已經把 busy 收掉）
    setBusy(false);
    if (!result.ok) {
      setError(t.pathErrors[result.error]);
      if (focusIsOurs()) inputRef.current?.focus();
      return;
    }
    const repo = result.repo;
    // 先放進清單（重新掃描回來之前，選單就要顯示它的名字，而不是「不在清單中」）
    setList((prev) =>
      prev && !prev.repos.some((r) => r.id === repo.id)
        ? { ...prev, repos: [...prev.repos, repo] }
        : prev,
    );
    if (focusIsOurs()) selectRef.current?.focus();
    setAdding(false);
    setPath('');
    void reload();
    // 等待期間使用者已經換到（或正用鍵盤瀏覽到）別的 repo：尊重他的選擇，不切換
    if (currentRef.current !== before || pendingRef.current !== null) return;
    // 同一個 id 也要「導覽」一次：網址不變（不多一筆歷史），但畫面會重抓（例如原本顯示「不認得這個 repo」）
    onPick(repo.id);
  };

  return (
    <>
      <select
        ref={selectRef}
        className="web-select"
        aria-label={t.pickRepo}
        title={repos.find((r) => r.id === shown)?.label ?? t.pickRepo}
        value={shown}
        onPointerDown={() => {
          keyNav.current = false;
        }}
        onKeyDown={(e) => {
          if (isKeyNav(e)) keyNav.current = true;
          else if (e.key === 'Enter' && pending !== null) commit(pending);
        }}
        onBlur={() => {
          if (pending !== null) commit(pending);
        }}
        onChange={(e) => {
          const value = e.target.value;
          if (!keyNav.current) return commit(value);
          // 鍵盤瀏覽：先只改顯示，停下來（或按 Enter / 離開選單）才切換，不會每經過一個 repo 就多一筆歷史和一次讀取
          setPending(value);
          window.clearTimeout(settle.current);
          settle.current = window.setTimeout(() => commit(value), KEY_SETTLE_MS);
        }}
      >
        {!selected && (
          <option value={CURRENT}>
            {current === DEFAULT_REPO || !list ? t.localTitle : t.localUnlisted}
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
            {failed === LOCAL_ONLY ? t.localOnly : t.reposFailed}
          </option>
        )}
      </select>

      {failed !== LOCAL_ONLY && !adding && (
        <button
          type="button"
          className="web-icon web-add"
          aria-label={t.addPath}
          title={t.addPath}
          onClick={() => setAdding(true)}
        >
          ＋
        </button>
      )}

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
          {/* 送出中不用 disabled：disabled 會讓按鈕失去焦點，鍵盤使用者就掉回 <body> */}
          <button type="submit" className="web-go" aria-disabled={busy || !path.trim()}>
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
