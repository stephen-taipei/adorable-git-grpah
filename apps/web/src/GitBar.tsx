import { useEffect, useRef, useState } from 'react';
import type { GraphNode } from '@adorable/graph-core';
import { BAR_ACTIONS, availability, changeCount, outputTail, shortSha } from './git';
import type { BarAction } from './git';
import type { Notice } from './gitMessages';
import type { GitControl } from './useGitControl';
import { BranchIcon, ICONS, SpinnerIcon, TagIcon, WorktreeIcon } from './GitIcons';
import { t } from './i18n';

/** 動作列下方的成功訊息停留多久（失敗的訊息一直留到使用者關掉） */
const NOTICE_MS = 8000;

/** 這個動作列的按鈕正在執行的動作種類 */
const RUNS: Record<BarAction, readonly string[]> = {
  fetch: ['fetch'],
  pull: ['pull'],
  push: ['push'],
  stash: ['stash-save', 'stash-apply', 'stash-pop', 'stash-drop'],
  tag: ['tag-create', 'tag-delete', 'tag-push'],
  worktree: ['worktree-add', 'worktree-remove'],
};

/**
 * 本機 repo 的 git 動作列（放在來源列的同一排，窄螢幕時換行、按鈕只留圖示）：
 * 目前的 branch、↑領先 ↓落後、變更數、進行中的操作，以及 Fetch / Pull / Push / Stash / Tag / Worktree。
 * 不能用的按鈕用 aria-disabled（保留焦點與提示），原因同時放在 title 與 aria-describedby。
 */
export function GitBar({ git }: { git: GitControl }) {
  const s = git.status;
  if (!s) return null;
  const running = git.running !== null;
  const changes = changeCount(s);
  const branchText = s.branch ?? (s.head ? `${t.git.detached} ${shortSha(s.head)}` : t.git.unborn);
  const syncText = s.upstream
    ? t.git.aheadBehind(s.ahead, s.behind, s.upstream)
    : s.branch
      ? t.git.noUpstreamHint
      : '';
  const changesText = changes
    ? t.git.changes(changes) +
      t.git.paren(
        t.git.changesDetail(
          s.changes.staged,
          s.changes.unstaged,
          s.changes.untracked,
          s.changes.conflicted,
        ),
      )
    : t.git.clean;
  const statusTitle = [t.git.statusLabel(branchText), syncText, changesText]
    .filter(Boolean)
    .join('\n');

  const act = (a: BarAction) => {
    switch (a) {
      case 'fetch':
        return void git.runInBar({ type: 'fetch' });
      case 'pull':
        return void git.runInBar({ type: 'pull' });
      case 'push':
        return git.openDialog({ kind: 'push' });
      case 'stash':
        return git.openDialog({ kind: 'stash' });
      case 'tag':
        return s.head ? git.openDialog({ kind: 'tag', target: s.head, head: true }) : undefined;
      case 'worktree':
        return git.openDialog({ kind: 'worktree' });
    }
  };

  const badge = (a: BarAction): string | null => {
    if (a === 'push' && s.upstream && s.ahead > 0) return `↑${s.ahead}`;
    if (a === 'pull' && s.upstream && s.behind > 0) return `↓${s.behind}`;
    if (a === 'stash' && s.stashes.length > 0) return String(s.stashes.length);
    if (a === 'worktree' && s.worktrees.length > 1) return String(s.worktrees.length);
    return null;
  };

  return (
    <>
      <div className="web-git" role="group" aria-label={t.git.bar}>
        {s.operation && (
          <span className="web-git-op" role="note">
            ⚠ {t.git.operation[s.operation] ?? s.operation}
          </span>
        )}
        {/* 狀態與按鈕不分開換行：放不下時先省略 branch 名稱 */}
        <span className="web-git-main">
          <span className="web-git-status" title={statusTitle}>
            <BranchIcon />
            <span className="web-git-branch" data-detached={s.branch ? undefined : ''}>
              {branchText}
            </span>
            {s.upstream && (s.ahead > 0 || s.behind > 0) && (
              <span className="web-git-sync" aria-hidden="true">
                {s.ahead > 0 && <span>↑{s.ahead}</span>}
                {s.behind > 0 && <span>↓{s.behind}</span>}
              </span>
            )}
            {changes > 0 && (
              <span className="web-git-dirty" aria-hidden="true">
                ●{changes}
              </span>
            )}
            {/* 箭頭與圓點只是圖示：完整的說明給螢幕報讀器 */}
            <span className="web-sr">
              {[syncText, changesText].filter(Boolean).join(t.git.sep)}
            </span>
          </span>
          <span className="web-git-actions">
            {BAR_ACTIONS.map((a) => {
              const avail = availability(s, a, running);
              const busy = running && RUNS[a].includes(git.running!.type);
              const Icon = ICONS[a];
              const label = t.git.actions[a] ?? a;
              const reason = avail.reason ? t.git.reasons[avail.reason] : undefined;
              const b = badge(a);
              const whyId = `web-git-why-${a}`;
              return (
                <span key={a} className="web-git-slot">
                  <button
                    type="button"
                    className="web-git-btn"
                    data-action={a}
                    aria-label={label}
                    aria-disabled={!avail.enabled || undefined}
                    aria-busy={busy || undefined}
                    aria-describedby={reason && !busy ? whyId : undefined}
                    title={busy ? (t.git.running[a] ?? label) : (reason ?? t.git.hints[a] ?? label)}
                    onClick={() => {
                      if (avail.enabled) act(a);
                    }}
                  >
                    {busy ? <SpinnerIcon /> : <Icon />}
                    <span className="web-git-label" aria-hidden="true">
                      {label}
                    </span>
                    {b && (
                      <span className="web-git-badge" aria-hidden="true">
                        {b}
                      </span>
                    )}
                  </button>
                  {reason && !busy && (
                    <span id={whyId} className="web-sr">
                      {reason}
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        </span>
      </div>
      <NoticeLine
        notice={git.notice}
        onDismiss={git.dismissNotice}
        className="web-git-notice--bar"
      />
    </>
  );
}

/**
 * 動作的進度 / 結果。兩個 live region 一直都在（空的時候只是看不見），
 * 訊息出現時螢幕報讀器才唸得到：進度與成功用 status（polite），失敗用 alert。
 */
export function NoticeLine({
  notice,
  onDismiss,
  className,
  autoHideMs,
}: {
  notice: Notice | null;
  onDismiss?: () => void;
  className?: string;
  /** 成功 / 沒事可做的訊息過一陣子自己收掉（失敗的一直留著）；滑鼠在上面、焦點在裡面、展開了輸出時不收 */
  autoHideMs?: number;
}) {
  const error = notice?.tone === 'error';
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [open, setOpen] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const id = notice?.id;
  const hideable = Boolean(autoHideMs && notice && !notice.progress && !error && onDismiss);
  const held = hover || focusIn || open;

  useEffect(() => setOpen(false), [id]);
  useEffect(() => {
    if (!hideable || held) return;
    const timer = setTimeout(() => onDismissRef.current?.(), autoHideMs);
    return () => clearTimeout(timer);
  }, [id, hideable, held, autoHideMs]);

  return (
    <div
      className={`web-git-notice${className ? ` ${className}` : ''}`}
      data-tone={notice?.tone}
      data-progress={notice?.progress ? '' : undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocusIn(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIn(false);
      }}
    >
      <span className="web-git-notice-text" role="status">
        {notice && !error ? <span key={notice.id}>{notice.text}</span> : null}
      </span>
      <span className="web-git-notice-text" role="alert">
        {notice && error ? <span key={notice.id}>{notice.text}</span> : null}
      </span>
      {notice?.output && (
        <details
          key={notice.id}
          className="web-git-output"
          onToggle={(e) => setOpen(e.currentTarget.open)}
        >
          <summary>
            {t.git.output}
            {/* 最後一行的摘要（完整的輸出展開後看） */}
            <span className="web-git-snippet">{outputTail(notice.output, 1)}</span>
          </summary>
          <pre>{notice.output}</pre>
        </details>
      )}
      {notice && onDismiss && !notice.progress && (
        <button
          type="button"
          className="web-git-x"
          aria-label={t.git.dismiss}
          title={t.git.dismiss}
          onClick={onDismiss}
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** 詳情面板底部（renderDetailExtra）：在選取的 commit 上建立 tag / 從它新增 worktree。 */
export function DetailGitActions({ node, git }: { node: GraphNode; git: GitControl }) {
  if (!git.status) return null;
  const running = git.running !== null;
  return (
    <>
      <button
        type="button"
        className="web-detail-btn"
        title={t.git.tag.fromDetail}
        aria-disabled={running || undefined}
        onClick={() => {
          if (!running) git.openDialog({ kind: 'tag', target: node.sha, head: false });
        }}
      >
        <TagIcon />
        {t.git.tag.fromDetailShort}
      </button>
      <button
        type="button"
        className="web-detail-btn"
        title={t.git.worktree.fromDetail}
        aria-disabled={running || undefined}
        onClick={() => {
          if (!running) git.openDialog({ kind: 'worktree', base: node.sha });
        }}
      >
        <WorktreeIcon />
        {t.git.worktree.fromDetailShort}
      </button>
    </>
  );
}
