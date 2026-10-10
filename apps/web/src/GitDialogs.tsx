import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import type { GraphData } from '@adorable/graph-core';
import { formatRelative } from '@adorable/graph-ui';
import type { GitAction, RepoStatus, WorktreeInfo } from './protocol';
import {
  STASH_MESSAGE_MAX,
  TAG_MESSAGE_MAX,
  availability,
  blockingOperation,
  branchNameProblem,
  canStashSave,
  changeCount,
  defaultRemote,
  fetchRepoStatus,
  pushTarget,
  refNameProblem,
  shortSha,
  suggestWorktreePath,
  tagRemote,
} from './git';
import type { ActionOutcome } from './git';
import { progressNotice, resultNotice } from './gitMessages';
import type { Notice } from './gitMessages';
import type { GitControl } from './useGitControl';
import { NoticeLine } from './GitBar';
import { PushIcon, StashIcon, TagIcon, WorktreeIcon } from './GitIcons';
import { locale, t } from './i18n';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * 共用的對話框外殼（沿用 .web-dialog 的樣式）：開啟時把焦點放進來、Tab 在裡面循環、Esc / 點背景關閉，
 * 關閉後焦點回到開啟它的按鈕。對話框放在 viewer 之外，鍵盤事件不會被 viewer 的快捷鍵（j/k、Esc 收詳情）吃掉。
 */
function Dialog({
  title,
  icon,
  onClose,
  children,
  dialogRef,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
  dialogRef?: RefObject<HTMLDivElement | null>;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = dialogRef ?? ownRef;
  const titleId = useId();
  // onClose 的身分每次 render 都會變：放進 ref，effect 才不會重跑而把焦點搶回第一個欄位
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    const first =
      root?.querySelector<HTMLElement>('[data-autofocus]') ??
      root?.querySelector<HTMLElement>(FOCUSABLE) ??
      root;
    first?.focus();
    // 焦點被移出去（例如動作完成後按鈕消失、焦點掉到 body 以外的地方）：拉回對話框
    const onFocusIn = (e: FocusEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) el.focus();
    };
    // 焦點掉到 <body>（剛按的按鈕被移除）時 keydown 不會經過對話框：Esc 由 window 收
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) onCloseRef.current();
    };
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.agg-root')?.focus({ preventScroll: true });
    };
  }, [ref]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    );
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="web-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="web-dialog web-git-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="web-git-head">
          <h2 id={titleId}>
            <span className="web-git-head-icon">{icon}</span>
            <span className="web-git-head-text">{title}</span>
          </h2>
          <button
            type="button"
            className="web-icon web-git-close"
            aria-label={t.git.close}
            title={t.git.close}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 對話框裡的動作：結果顯示在對話框底部的狀態列（不是動作列下方）。 */
function useDialogAction(git: GitControl) {
  const [notice, setNotice] = useState<Notice | null>(null);
  /** `verify`：執行前的檢查（例如 stash 的位置有沒有變）；不通過就不執行，訊息由它自己設定 */
  const exec = async (
    action: GitAction,
    verify?: () => Promise<boolean>,
  ): Promise<ActionOutcome | null> => {
    const before = git.status;
    setNotice(progressNotice(action));
    if (verify && !(await verify())) return null;
    const result = await git.run(action);
    setNotice(result ? resultNotice(action, result, before) : null);
    return result;
  };
  return { notice, setNotice, exec };
}

/** 破壞性動作的第二次確認（列內）：預設焦點在「保留」，Esc = 保留。 */
function ConfirmRow({
  text,
  yes,
  no,
  onYes,
  onNo,
}: {
  text: string;
  yes: string;
  no: string;
  onYes: () => void;
  onNo: () => void;
}) {
  const noRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  useEffect(() => noRef.current?.focus(), []);
  return (
    <div
      className="web-git-confirm"
      role="group"
      aria-labelledby={textId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          onNo();
        }
      }}
    >
      <span id={textId} className="web-git-confirm-text">
        {text}
      </span>
      <span className="web-git-item-actions">
        <button type="button" className="web-cta web-cta--sm web-cta--danger" onClick={onYes}>
          {yes}
        </button>
        <button
          type="button"
          ref={noRef}
          className="web-cta web-cta--sm web-cta--ghost"
          onClick={onNo}
        >
          {no}
        </button>
      </span>
    </div>
  );
}

/** aria-disabled 的按鈕：保留焦點，不能用的原因放在 title 與 aria-describedby */
function ActionButton({
  label,
  onClick,
  disabledReason,
  danger,
  hint,
  autoFocus,
  type = 'button',
  small = true,
}: {
  label: string;
  onClick?: () => void;
  /** 有值 = 不能用 */
  disabledReason?: string | null;
  danger?: boolean;
  hint?: string;
  autoFocus?: boolean;
  type?: 'button' | 'submit';
  small?: boolean;
}) {
  const whyId = useId();
  const disabled = Boolean(disabledReason);
  return (
    <>
      <button
        type={type}
        className={`web-cta${small ? ' web-cta--sm' : ''}${danger ? ' web-cta--danger' : ''}${
          small && !danger ? ' web-cta--ghost' : ''
        }`}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? whyId : undefined}
        title={disabledReason ?? hint}
        data-autofocus={autoFocus || undefined}
        onClick={(e) => {
          if (disabled) {
            e.preventDefault();
            return;
          }
          onClick?.();
        }}
      >
        {label}
      </button>
      {disabled && (
        <span id={whyId} className="web-sr">
          {disabledReason}
        </span>
      )}
    </>
  );
}

const reasonText = (r: string | undefined) => (r ? (t.git.reasons[r] ?? r) : null);

// ───────────────────────── Push ─────────────────────────

function PushDialog({ git }: { git: GitControl }) {
  const s = git.status!;
  const target = pushTarget(s);
  const [remote, setRemote] = useState(() => defaultRemote(s.remotes));
  const avail = availability(s, 'push', git.running !== null);
  const branch = s.branch ?? 'HEAD';
  const remoteId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target || !avail.enabled) return;
    const action: GitAction =
      target.mode === 'set-upstream'
        ? { type: 'push', confirm: true, setUpstream: { remote } }
        : { type: 'push', confirm: true };
    // 網路動作可能要等一陣子：關掉對話框，進度與結果顯示在動作列下方
    git.closeDialog();
    void git.runInBar(action);
  };

  return (
    <Dialog title={t.git.push.title(branch)} icon={<PushIcon />} onClose={git.closeDialog}>
      <form onSubmit={submit} className="web-git-form">
        {target?.mode === 'upstream' && (
          <p className="web-git-lead">{t.git.push.summary(s.ahead, branch, target.upstream)}</p>
        )}
        {target?.mode === 'upstream' && s.behind > 0 && (
          <p className="web-warn">{t.git.push.behindWarn(s.behind, target.upstream)}</p>
        )}
        {target?.mode === 'set-upstream' && (
          <>
            <p className="web-git-lead">{t.git.push.noUpstream(branch)}</p>
            <div className="web-field">
              <label htmlFor={remoteId}>{t.git.push.remote}</label>
              <select
                id={remoteId}
                className="web-select web-git-select"
                value={remote}
                data-autofocus
                onChange={(e) => setRemote(e.target.value)}
              >
                {target.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <p className="web-git-hint">{t.git.push.as(remote, branch)}</p>
          </>
        )}
        {!avail.enabled && <p className="web-warn">{reasonText(avail.reason)}</p>}
        <p className="web-git-hint">{t.git.neverForce}</p>
        <div className="web-row">
          <ActionButton
            type="submit"
            small={false}
            label={
              target?.mode === 'set-upstream' ? t.git.push.submitSetUpstream : t.git.push.submit
            }
            disabledReason={!target || !avail.enabled ? reasonText(avail.reason) : null}
            autoFocus={target?.mode !== 'set-upstream'}
          />
          <button type="button" className="web-cta web-cta--ghost" onClick={git.closeDialog}>
            {t.git.cancel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────── Stash ─────────────────────────

type StashEntry = RepoStatus['stashes'][number];
const stashKey = (st: StashEntry) => `${st.index}\u0000${st.date}\u0000${st.message}`;

function StashDialog({ git }: { git: GitControl }) {
  const s = git.status!;
  const dialogRef = useRef<HTMLDivElement>(null);
  const { notice, setNotice, exec } = useDialogAction(git);
  const [message, setMessage] = useState('');
  // 只有未追蹤的檔案時預設勾選（否則 git 會說沒有東西可以 stash）
  const [untracked, setUntracked] = useState(
    () => s.changes.untracked > 0 && s.changes.staged + s.changes.unstaged === 0,
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  const running = git.running !== null;
  const save = canStashSave(s, running);
  const blocked = blockingOperation(s);
  const changes = changeCount(s);
  const messageId = useId();

  /**
   * 會丟掉 stash 的動作（pop / drop）只用 index 指定：執行前再讀一次狀態，確定那個位置還是同一個 stash
   * （例如在終端機又 stash 了一次，index 就全部往後移）。
   */
  const verified = async (st: StashEntry): Promise<boolean> => {
    if (!git.repo) return false;
    const fresh = await fetchRepoStatus(git.repo);
    const same =
      fresh.kind === 'ok' && fresh.status.stashes.some((x) => stashKey(x) === stashKey(st));
    if (!same) {
      setNotice({ id: Date.now(), tone: 'error', text: t.git.errors['not_found']! });
      git.refresh();
    }
    return same;
  };

  const afterRemoval = () => dialogRef.current?.focus();

  return (
    <Dialog
      title={t.git.stash.title}
      icon={<StashIcon />}
      onClose={git.closeDialog}
      dialogRef={dialogRef}
    >
      <form
        className="web-git-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!save.enabled) return;
          const text = message.trim();
          const result = await exec({
            type: 'stash-save',
            ...(text ? { message: text } : {}),
            ...(untracked ? { includeUntracked: true } : {}),
          });
          if (result?.ok) setMessage('');
        }}
      >
        <p className="web-git-lead">
          {changes
            ? t.git.changes(changes) +
              t.git.paren(
                t.git.changesDetail(
                  s.changes.staged,
                  s.changes.unstaged,
                  s.changes.untracked,
                  s.changes.conflicted,
                ),
              )
            : t.git.clean}
        </p>
        <div className="web-field">
          <label htmlFor={messageId}>{t.git.stash.message}</label>
          <input
            id={messageId}
            className="web-input web-input--wide"
            value={message}
            maxLength={STASH_MESSAGE_MAX}
            spellCheck={false}
            autoComplete="off"
            data-autofocus
            onChange={(e) => setMessage(e.target.value.replace(/[\r\n]+/g, ' '))}
          />
        </div>
        <label className="web-check">
          <input
            type="checkbox"
            checked={untracked}
            onChange={(e) => setUntracked(e.target.checked)}
          />
          {t.git.stash.includeUntracked}
        </label>
        <div className="web-row">
          <ActionButton
            type="submit"
            small={false}
            label={t.git.stash.save}
            disabledReason={reasonText(save.reason)}
          />
        </div>
      </form>

      <h3 className="web-git-sub">{t.git.stash.list}</h3>
      {s.stashes.length === 0 ? (
        <p className="web-git-empty">{t.git.stash.empty}</p>
      ) : (
        <ul className="web-git-list">
          {s.stashes.map((st) => {
            const key = stashKey(st);
            const why = running ? reasonText('busy') : blocked ? reasonText('operation') : null;
            return (
              <li key={key} className="web-git-li">
                <div className="web-git-item">
                  <code className="web-git-code">{`stash@{${st.index}}`}</code>
                  <span className="web-git-item-text" title={st.message}>
                    {st.message}
                  </span>
                  <span className="web-git-item-meta">{formatRelative(st.date, locale)}</span>
                </div>
                {confirm === key ? (
                  <ConfirmRow
                    text={t.git.stash.dropConfirm(st.index)}
                    yes={t.git.stash.dropYes}
                    no={t.git.stash.keep}
                    onNo={() => setConfirm(null)}
                    onYes={async () => {
                      setConfirm(null);
                      afterRemoval();
                      await exec({ type: 'stash-drop', index: st.index, confirm: true }, () =>
                        verified(st),
                      );
                    }}
                  />
                ) : (
                  <span className="web-git-item-actions">
                    <ActionButton
                      label={t.git.stash.apply}
                      hint={t.git.stash.applyHint}
                      disabledReason={why}
                      onClick={() => void exec({ type: 'stash-apply', index: st.index })}
                    />
                    <ActionButton
                      label={t.git.stash.pop}
                      hint={t.git.stash.popHint}
                      disabledReason={why}
                      onClick={async () => {
                        afterRemoval();
                        await exec({ type: 'stash-pop', index: st.index }, () => verified(st));
                      }}
                    />
                    <ActionButton
                      label={t.git.stash.drop}
                      danger
                      disabledReason={running ? reasonText('busy') : null}
                      onClick={() => setConfirm(key)}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />
    </Dialog>
  );
}

// ───────────────────────── Tag ─────────────────────────

function TagDialog({
  git,
  graph,
  target,
  head,
}: {
  git: GitControl;
  graph: GraphData | null;
  target: string;
  head: boolean;
}) {
  const s = git.status!;
  const dialogRef = useRef<HTMLDivElement>(null);
  const { notice, setNotice, exec } = useDialogAction(git);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(false);
  const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const nameId = useId();
  const nameErrId = useId();
  const messageId = useId();
  const running = git.running !== null;
  const remote = tagRemote(s);

  const commit = graph?.commits.find((c) => c.sha === target);
  const subject = commit?.message.split('\n', 1)[0] ?? '';
  const tagsHere = (graph?.refs ?? []).filter((r) => r.kind === 'tag' && r.sha === target);
  const allTags = new Set((graph?.refs ?? []).filter((r) => r.kind === 'tag').map((r) => r.name));
  const trimmed = name.trim();
  const problem = refNameProblem(trimmed);
  const problemText = problem
    ? t.git.refProblems[problem]
    : allTags.has(trimmed)
      ? t.git.tag.exists
      : null;
  const showProblem = touched && problemText;
  const where = head
    ? `${t.git.tag.head}${s.branch ? ` · ${s.branch}` : ''} · ${shortSha(target)}`
    : `${shortSha(target)}${subject ? ` · ${subject}` : ''}`;

  return (
    <Dialog
      title={t.git.tag.title}
      icon={<TagIcon />}
      onClose={git.closeDialog}
      dialogRef={dialogRef}
    >
      <p className="web-git-lead">
        <span className="web-git-k">{t.git.tag.on}</span>{' '}
        <span className="web-git-where" title={where}>
          {where}
        </span>
      </p>
      <form
        className="web-git-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setTouched(true);
          if (problemText || running) return;
          const text = message.trim();
          const result = await exec({
            type: 'tag-create',
            name: trimmed,
            target,
            ...(text ? { message: text } : {}),
            ...(push && remote ? { push: true } : {}),
          });
          if (result?.ok) {
            setName('');
            setMessage('');
            setTouched(false);
          }
        }}
      >
        <div className="web-field">
          <label htmlFor={nameId}>{t.git.tag.name}</label>
          <input
            id={nameId}
            className="web-input web-input--wide"
            value={name}
            placeholder={t.git.tag.namePlaceholder}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={255}
            data-autofocus
            aria-invalid={Boolean(showProblem)}
            aria-describedby={showProblem ? nameErrId : undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name && setTouched(true)}
          />
          {showProblem && (
            <span id={nameErrId} className="web-error" role="alert">
              {problemText}
            </span>
          )}
        </div>
        <div className="web-field">
          <label htmlFor={messageId}>{t.git.tag.message}</label>
          <textarea
            id={messageId}
            className="web-input web-input--wide web-git-textarea"
            value={message}
            rows={2}
            maxLength={TAG_MESSAGE_MAX}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        <label className="web-check" data-disabled={remote ? undefined : ''}>
          <input
            type="checkbox"
            checked={push && Boolean(remote)}
            disabled={!remote}
            onChange={(e) => setPush(e.target.checked)}
          />
          {remote ? t.git.tag.push(remote) : t.git.tag.noRemote}
        </label>
        <div className="web-row">
          <ActionButton
            type="submit"
            small={false}
            label={t.git.tag.submit}
            disabledReason={running ? reasonText('busy') : null}
          />
        </div>
      </form>

      <h3 className="web-git-sub">{t.git.tag.existing}</h3>
      {tagsHere.length === 0 ? (
        <p className="web-git-empty">{t.git.tag.none}</p>
      ) : (
        <ul className="web-git-list">
          {tagsHere.map((tag) => (
            <li key={tag.name} className="web-git-li">
              <div className="web-git-item">
                <TagIcon />
                <span className="web-git-item-text web-git-code" title={tag.name}>
                  {tag.name}
                </span>
              </div>
              {confirm === tag.name ? (
                <ConfirmRow
                  text={t.git.tag.deleteConfirm(tag.name)}
                  yes={t.git.tag.deleteYes}
                  no={t.git.tag.keep}
                  onNo={() => setConfirm(null)}
                  onYes={() => {
                    setConfirm(null);
                    dialogRef.current?.focus();
                    void exec({ type: 'tag-delete', name: tag.name, confirm: true });
                  }}
                />
              ) : (
                <span className="web-git-item-actions">
                  <ActionButton
                    label={t.git.tag.pushOne}
                    hint={remote ? t.git.tag.pushOneHint(remote) : undefined}
                    disabledReason={
                      running ? reasonText('busy') : remote ? null : reasonText('noRemote')
                    }
                    onClick={() => void exec({ type: 'tag-push', name: tag.name })}
                  />
                  <ActionButton
                    label={t.git.tag.delete}
                    danger
                    disabledReason={running ? reasonText('busy') : null}
                    onClick={() => setConfirm(tag.name)}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />
    </Dialog>
  );
}

// ───────────────────────── Worktree ─────────────────────────

type WorktreeMode = 'new' | 'existing' | 'detached';

function removeReason(w: WorktreeInfo, running: boolean): string | null {
  if (running) return reasonText('busy');
  if (w.main) return t.git.worktree.cannotRemoveMain;
  if (w.current) return t.git.worktree.cannotRemoveCurrent;
  if (w.id === 'default') return t.git.worktree.cannotRemoveDefault;
  if (w.locked) return t.git.worktree.cannotRemoveLocked;
  return null;
}

function WorktreeDialog({
  git,
  graph,
  base,
  onOpenRepo,
}: {
  git: GitControl;
  graph: GraphData | null;
  base?: string;
  onOpenRepo: (id: string) => void;
}) {
  const s = git.status!;
  const dialogRef = useRef<HTMLDivElement>(null);
  const { notice, setNotice, exec } = useDialogAction(git);
  const running = git.running !== null;
  const repoName = graph?.repo.name || 'repo';
  const checkedOut = new Set(s.worktrees.map((w) => w.branch).filter((b): b is string => !!b));
  const localBranches = [
    ...new Set(
      (graph?.refs ?? [])
        .filter((r) => r.kind === 'branch' && !r.remote && !checkedOut.has(r.name))
        .map((r) => r.name),
    ),
  ];
  const [mode, setMode] = useState<WorktreeMode>('new');
  const [newBranch, setNewBranch] = useState('');
  const [branch, setBranch] = useState(localBranches[0] ?? '');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; label: string } | null>(null);
  const ids = {
    path: useId(),
    pathHelp: useId(),
    newBranch: useId(),
    branch: useId(),
    branchList: useId(),
    err: useId(),
  };

  const commit = base ? graph?.commits.find((c) => c.sha === base) : undefined;
  const baseLabel = base
    ? `${shortSha(base)}${commit ? ` · ${commit.message.split('\n', 1)[0]}` : ''}`
    : `HEAD${s.branch ? ` (${s.branch})` : s.head ? ` (${shortSha(s.head)})` : ''}`;
  const suggested = suggestWorktreePath(
    repoName,
    mode === 'new' ? newBranch : mode === 'existing' ? branch : shortSha(base ?? s.head),
  );
  const effectivePath = pathTouched ? path : suggested;

  const branchProblem =
    mode === 'new'
      ? branchNameProblem(newBranch.trim())
      : mode === 'existing'
        ? refNameProblem(branch.trim())
        : null;
  const problemText = !effectivePath.trim()
    ? t.git.refProblems['empty']!
    : branchProblem
      ? t.git.refProblems[branchProblem]!
      : null;
  const showProblem = touched && problemText;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problemText || running) return;
    setCreated(null);
    const action: GitAction = {
      type: 'worktree-add',
      path: effectivePath.trim(),
      ...(mode === 'new'
        ? { newBranch: newBranch.trim(), ...(base ? { base } : {}) }
        : mode === 'existing'
          ? { branch: branch.trim() }
          : base
            ? { base }
            : {}),
    };
    const result = await exec(action);
    if (result?.ok) {
      setTouched(false);
      setNewBranch('');
      setPath('');
      setPathTouched(false);
      if (result.repo) setCreated({ id: result.repo.id, label: result.repo.label });
    }
  };

  return (
    <Dialog
      title={t.git.worktree.title}
      icon={<WorktreeIcon />}
      onClose={git.closeDialog}
      dialogRef={dialogRef}
    >
      <h3 className="web-git-sub web-git-sub--first">{t.git.worktree.list}</h3>
      <ul className="web-git-list">
        {s.worktrees.map((w) => {
          const why = removeReason(w, running);
          return (
            <li key={w.id} className="web-git-li" data-current={w.current ? '' : undefined}>
              <div className="web-git-item">
                <WorktreeIcon />
                {/* 資料夾名稱在前（一定看得到），完整位置接在後面、放不下就省略 */}
                <span className="web-git-item-text" title={w.label}>
                  <strong>{w.label.split(/[\\/]/).filter(Boolean).pop() ?? w.label}</strong>{' '}
                  <span className="web-git-dim">{w.label}</span>
                </span>
                <span className="web-git-item-meta web-git-code">
                  {w.branch ?? t.git.worktree.detachedAt(shortSha(w.head))}
                </span>
                {w.current && <span className="web-git-tag">{t.git.worktree.current}</span>}
                {w.main && <span className="web-git-tag">{t.git.worktree.main}</span>}
                {w.locked && <span className="web-git-tag">{t.git.worktree.locked}</span>}
                {w.prunable && (
                  <span className="web-git-tag web-git-tag--warn">{t.git.worktree.prunable}</span>
                )}
              </div>
              {confirm === w.id ? (
                <ConfirmRow
                  text={t.git.worktree.removeConfirm(w.label)}
                  yes={t.git.worktree.removeYes}
                  no={t.git.worktree.keep}
                  onNo={() => setConfirm(null)}
                  onYes={() => {
                    setConfirm(null);
                    dialogRef.current?.focus();
                    void exec({ type: 'worktree-remove', id: w.id, confirm: true });
                  }}
                />
              ) : (
                <span className="web-git-item-actions">
                  <ActionButton
                    label={t.git.worktree.open}
                    hint={t.git.worktree.openHint(w.label)}
                    disabledReason={
                      w.current
                        ? t.git.worktree.current
                        : w.prunable
                          ? t.git.worktree.prunable
                          : null
                    }
                    onClick={() => onOpenRepo(w.id)}
                  />
                  <ActionButton
                    label={t.git.worktree.remove}
                    danger
                    disabledReason={why}
                    onClick={() => setConfirm(w.id)}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <h3 className="web-git-sub">{t.git.worktree.add}</h3>
      <form className="web-git-form" noValidate onSubmit={(e) => void submit(e)}>
        <fieldset className="web-git-modes">
          <legend>{t.git.worktree.mode}</legend>
          {(['new', 'existing', 'detached'] as const).map((m) => (
            <label key={m} className="web-check">
              <input
                type="radio"
                name="web-wt-mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {m === 'new'
                ? t.git.worktree.modeNew
                : m === 'existing'
                  ? t.git.worktree.modeExisting
                  : t.git.worktree.modeDetached}
            </label>
          ))}
        </fieldset>
        {mode === 'new' && (
          <div className="web-field">
            <label htmlFor={ids.newBranch}>{t.git.worktree.newBranch}</label>
            <input
              id={ids.newBranch}
              className="web-input web-input--wide"
              value={newBranch}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              maxLength={255}
              aria-invalid={Boolean(showProblem && branchProblem)}
              aria-describedby={showProblem && branchProblem ? ids.err : undefined}
              onChange={(e) => setNewBranch(e.target.value)}
            />
          </div>
        )}
        {mode === 'existing' && (
          <div className="web-field">
            <label htmlFor={ids.branch}>{t.git.worktree.branch}</label>
            <input
              id={ids.branch}
              className="web-input web-input--wide"
              value={branch}
              list={ids.branchList}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              maxLength={255}
              aria-invalid={Boolean(showProblem && branchProblem)}
              aria-describedby={showProblem && branchProblem ? ids.err : undefined}
              onChange={(e) => setBranch(e.target.value)}
            />
            <datalist id={ids.branchList}>
              {localBranches.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
          </div>
        )}
        {mode !== 'existing' && <p className="web-git-hint">{t.git.worktree.base(baseLabel)}</p>}
        <div className="web-field">
          <label htmlFor={ids.path}>{t.git.worktree.path}</label>
          <input
            id={ids.path}
            className="web-input web-input--wide"
            value={effectivePath}
            placeholder={t.git.worktree.pathPlaceholder}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={4096}
            aria-invalid={Boolean(showProblem && !effectivePath.trim())}
            aria-describedby={
              showProblem && !effectivePath.trim() ? `${ids.err} ${ids.pathHelp}` : ids.pathHelp
            }
            onChange={(e) => {
              setPath(e.target.value);
              setPathTouched(true);
            }}
          />
          <span id={ids.pathHelp} className="web-git-hint">
            {t.git.worktree.pathHelp}
          </span>
        </div>
        {showProblem && (
          <span id={ids.err} className="web-error" role="alert">
            {problemText}
          </span>
        )}
        <div className="web-row">
          <ActionButton
            type="submit"
            small={false}
            label={t.git.worktree.submit}
            disabledReason={running ? reasonText('busy') : null}
          />
          {created && (
            <button
              type="button"
              className="web-cta web-cta--ghost"
              title={t.git.worktree.openHint(created.label)}
              onClick={() => onOpenRepo(created.id)}
            >
              {t.git.worktree.openNew}
            </button>
          )}
        </div>
      </form>
      <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />
    </Dialog>
  );
}

// ───────────────────────── 對話框的進入點 ─────────────────────────

export function GitDialogs({
  git,
  graph,
  onOpenRepo,
}: {
  git: GitControl;
  graph: GraphData | null;
  onOpenRepo: (id: string) => void;
}) {
  const d = git.dialog;
  if (!d || !git.status) return null;
  switch (d.kind) {
    case 'push':
      return <PushDialog git={git} />;
    case 'stash':
      return <StashDialog git={git} />;
    case 'tag':
      return <TagDialog key={d.target} git={git} graph={graph} target={d.target} head={d.head} />;
    case 'worktree':
      return (
        <WorktreeDialog
          key={d.base ?? ''}
          git={git}
          graph={graph}
          base={d.base}
          onOpenRepo={onOpenRepo}
        />
      );
  }
}
