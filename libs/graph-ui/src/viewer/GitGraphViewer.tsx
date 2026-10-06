import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import { detectLocale, formatDuration, formatRelative, getMessages } from '../i18n';
import type { Locale } from '../i18n';
import { GitGraphCanvas } from './GitGraphCanvas';
import type { CanvasHover, GitGraphCanvasHandle } from './GitGraphCanvas';
import { Mascot } from './Mascot';
import { CloseIcon, FitIcon, GearIcon, PlayIcon, RefreshIcon } from './icons';

export type ViewerState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message?: string; resetAt?: number }
  | { kind: 'ready'; layout: GraphLayout };

export interface GitGraphViewerProps {
  /** 例如 `owner/repo` */
  title: string;
  state: ViewerState;
  theme?: 'day' | 'night' | 'auto';
  locale?: Locale;
  onRefresh?: () => void;
  onClose?: () => void;
  onOpenSettings?: () => void;
  /** 預設：開新分頁前往 commit 的 GitHub 頁面。 */
  onSelectNode?: (node: GraphNode) => void;
  /** 顯示在標題列正下方的額外控制項（例如資料來源切換）。 */
  headerExtra?: ReactNode;
  /** 資料來源的識別（例如 `local` / `github`）。同名 repo 換來源時不會被當成「剛 commit 了一筆」的增量更新。 */
  sourceKey?: string;
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  );
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return dark;
}

function Avatar({ url, name }: { url?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        className="agg-avatar"
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        width={28}
        height={28}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="agg-avatar agg-avatar--fallback">
      {(name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  tone,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      className={`agg-btn${tone ? ` agg-btn--${tone}` : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

export function GitGraphViewer({
  title,
  state,
  theme = 'auto',
  locale,
  onRefresh,
  onClose,
  onOpenSettings,
  onSelectNode,
  headerExtra,
  sourceKey,
}: GitGraphViewerProps) {
  const loc = locale ?? detectLocale();
  const t = getMessages(loc);
  const prefersDark = usePrefersDark();
  const sceneTheme = theme === 'auto' ? (prefersDark ? 'night' : 'day') : theme;

  const canvasRef = useRef<GitGraphCanvasHandle>(null);
  const [hover, setHover] = useState<CanvasHover | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  const layout = state.kind === 'ready' ? state.layout : null;
  useEffect(() => setHover(null), [layout]);

  const select = (node: GraphNode) => {
    if (onSelectNode) onSelectNode(node);
    else if (node.url) window.open(node.url, '_blank', 'noopener,noreferrer');
  };

  const tooltipStyle = useMemo(() => {
    if (!hover) return undefined;
    const w = 300;
    const flipX = hover.x + 18 + w > hover.width;
    const flipY = hover.y > hover.height * 0.55;
    return {
      left: flipX ? Math.max(8, hover.x - 18 - w) : hover.x + 18,
      top: flipY ? undefined : hover.y + 14,
      bottom: flipY ? hover.height - hover.y + 14 : undefined,
      width: w,
    };
  }, [hover]);

  return (
    <div className="agg-root" data-theme={sceneTheme}>
      <div className="agg-sky" />

      {layout && !webglFailed && layout.nodes.length > 0 && (
        <GitGraphCanvas
          layout={layout}
          theme={sceneTheme}
          handleRef={canvasRef}
          sourceKey={sourceKey}
          onHover={setHover}
          onSelect={select}
          onError={() => setWebglFailed(true)}
        />
      )}

      <header className="agg-top">
        <div className="agg-pill agg-title">
          <Mascot size={26} />
          <span className="agg-title-text">{title}</span>
          {layout && (
            <span className="agg-chips">
              <span className="agg-chip">{t.commits(layout.nodes.length)}</span>
              <span className="agg-chip">{t.branches(layout.branches.length)}</span>
            </span>
          )}
        </div>
        <div className="agg-pill agg-actions">
          <IconButton label={t.replay} onClick={() => canvasRef.current?.replay()}>
            <PlayIcon />
          </IconButton>
          <IconButton label={t.fit} onClick={() => canvasRef.current?.fit()}>
            <FitIcon />
          </IconButton>
          {onRefresh && (
            <IconButton label={t.refresh} onClick={onRefresh}>
              <RefreshIcon />
            </IconButton>
          )}
          {onOpenSettings && (
            <IconButton label={t.settings} onClick={onOpenSettings}>
              <GearIcon />
            </IconButton>
          )}
          {onClose && (
            <IconButton label={t.close} onClick={onClose} tone="danger">
              <CloseIcon />
            </IconButton>
          )}
        </div>
      </header>

      {headerExtra && <div className="agg-subbar">{headerExtra}</div>}

      {state.kind === 'loading' && (
        <div className="agg-center" role="status">
          <Mascot size={92} className="agg-bounce" />
          <div className="agg-shadow" />
          <div className="agg-msg-title">{t.loading}</div>
          <div className="agg-msg-sub">{t.loadingSub}</div>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="agg-center" role="alert">
          <Mascot size={92} mood="sad" color="#ff7a8a" className="agg-wobble" />
          <div className="agg-msg-title">{t.errorTitle}</div>
          <div className="agg-msg-sub">
            {t.errors[state.code] ?? state.message ?? t.errors['unknown']}
            {state.code === 'rate_limited' && state.resetAt ? (
              <>
                <br />
                {t.rateLimitReset(formatDuration(Math.max(0, state.resetAt - Date.now()), loc))}
                {onOpenSettings ? ` · ${t.addToken}` : ''}
              </>
            ) : null}
          </div>
          <div className="agg-row">
            {onRefresh && (
              <button type="button" className="agg-cta" onClick={onRefresh}>
                {t.retry}
              </button>
            )}
            {onOpenSettings &&
              (state.code === 'rate_limited' ||
                state.code === 'not_found' ||
                state.code === 'unauthorized') && (
                <button type="button" className="agg-cta agg-cta--ghost" onClick={onOpenSettings}>
                  {t.settings}
                </button>
              )}
          </div>
        </div>
      )}

      {layout && layout.nodes.length === 0 && (
        <div className="agg-center">
          <Mascot size={92} mood="sleepy" color="#b58cff" className="agg-bounce" />
          <div className="agg-msg-title">{t.emptyTitle}</div>
          <div className="agg-msg-sub">{t.emptySub}</div>
        </div>
      )}

      {webglFailed && (
        <div className="agg-center" role="alert">
          <Mascot size={92} mood="sad" color="#ffa45e" />
          <div className="agg-msg-sub">{t.webglFail}</div>
        </div>
      )}

      {layout && layout.branches.length > 0 && (
        <footer className="agg-legend">
          {layout.branches.map((b) => (
            <button
              type="button"
              key={b.name}
              className="agg-branch"
              style={{ background: b.color }}
              onClick={() => canvasRef.current?.focusSha(b.sha)}
              title={b.name}
            >
              {b.isDefault ? '★ ' : ''}
              {b.name}
            </button>
          ))}
          {layout.truncated && <span className="agg-note">… {t.truncated}</span>}
        </footer>
      )}

      {layout && layout.nodes.length > 0 && <div className="agg-hint">{t.hint}</div>}

      {hover && tooltipStyle && (
        <div className="agg-tip" style={tooltipStyle}>
          <div className="agg-tip-head">
            <Avatar key={hover.node.sha} url={hover.node.avatarUrl} name={hover.node.authorName} />
            <span className="agg-tip-author">
              {hover.node.authorLogin ?? hover.node.authorName}
            </span>
            <span className="agg-tip-date">{formatRelative(hover.node.date, loc)}</span>
          </div>
          <div className="agg-tip-subject">{hover.node.subject || '(no message)'}</div>
          <div className="agg-tip-foot">
            <code style={{ background: hover.node.color }}>{hover.node.shortSha}</code>
            {hover.node.hasHiddenParents && <span>… {t.truncated}</span>}
            {hover.node.url && <span className="agg-tip-open">{t.clickToOpen} ↗</span>}
          </div>
        </div>
      )}
    </div>
  );
}
