import type { GraphBranch, GraphLayout, GraphNode } from '@adorable/graph-core';
import { formatRelative } from '../i18n';
import type { Locale, Messages } from '../i18n';
import { Avatar } from './Avatar';
import { RefBadges } from './RefBadges';
import { copyText, formatAbsolute } from './format';
import { useCopy } from './hooks';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  CopyIcon,
  ExternalIcon,
  MergeIcon,
} from './icons';

export interface CommitDetailProps {
  node: GraphNode;
  layout: GraphLayout;
  bySha: ReadonlyMap<string, GraphNode>;
  /** 哪些 branch 包含這個 commit（只計算已載入的範圍） */
  containing: readonly GraphBranch[];
  t: Messages;
  locale: Locale;
  now: number;
  onClose: () => void;
  /** 跳到另一個 commit（parent / child / 上一個 / 下一個） */
  onGoto: (sha: string) => void;
  onOpenCommit?: (node: GraphNode) => void;
  /** 點作者名稱＝以作者搜尋 */
  onSearch?: (query: string) => void;
}

function CopyButton({ text, label, t }: { text: string; label: string; t: Messages }) {
  const [state, copy] = useCopy(copyText);
  return (
    <button
      type="button"
      className="agg-mini-btn"
      data-state={state}
      onClick={() => copy(text)}
      title={state === 'ok' ? t.copied : state === 'fail' ? t.copyFailed : label}
      aria-label={label}
    >
      {state === 'ok' ? <CheckIcon /> : <CopyIcon />}
      <span>{state === 'ok' ? t.copied : state === 'fail' ? t.copyFailed : label}</span>
    </button>
  );
}

function CommitLink({
  sha,
  bySha,
  onGoto,
}: {
  sha: string;
  bySha: ReadonlyMap<string, GraphNode>;
  onGoto: (sha: string) => void;
}) {
  const n = bySha.get(sha);
  if (!n) {
    return (
      <span className="agg-link agg-link--off" title={sha}>
        <code>{sha.slice(0, 7)}</code>
      </span>
    );
  }
  return (
    <button type="button" className="agg-link" onClick={() => onGoto(sha)} title={n.subject}>
      <code style={{ background: n.color }}>{n.shortSha}</code>
      <span>{n.subject}</span>
    </button>
  );
}

export function CommitDetail({
  node,
  layout,
  bySha,
  containing,
  t,
  locale,
  now,
  onClose,
  onGoto,
  onOpenCommit,
  onSearch,
}: CommitDetailProps) {
  const parents = [...new Set(node.parents)];
  const body = node.message.split('\n').slice(1).join('\n').trim();
  const prev = layout.nodes[node.row - 1];
  const next = layout.nodes[node.row + 1];
  const author = node.authorLogin ?? node.authorName;
  return (
    <aside className="agg-detail" aria-label={t.detailTitle} data-kind={node.kind}>
      <header className="agg-detail-head">
        <span className="agg-kind" style={{ background: node.color }}>
          {node.kind === 'merge' && <MergeIcon />}
          {t.kinds[node.kind] ?? node.kind}
        </span>
        <div className="agg-detail-nav">
          <button
            type="button"
            className="agg-btn agg-btn--sm"
            onClick={() => prev && onGoto(prev.sha)}
            disabled={!prev}
            title={t.prevCommit}
            aria-label={t.prevCommit}
          >
            <ChevronUpIcon />
          </button>
          <button
            type="button"
            className="agg-btn agg-btn--sm"
            onClick={() => next && onGoto(next.sha)}
            disabled={!next}
            title={t.nextCommit}
            aria-label={t.nextCommit}
          >
            <ChevronDownIcon />
          </button>
          <button
            type="button"
            className="agg-btn agg-btn--sm agg-btn--danger"
            onClick={onClose}
            title={t.closeDetail}
            aria-label={t.closeDetail}
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="agg-detail-body">
        <h2 className="agg-detail-subject">{node.subject || t.noMessage}</h2>
        {body && <pre className="agg-detail-message">{body}</pre>}

        <dl className="agg-facts">
          <dt>{t.fullSha}</dt>
          <dd>
            <code className="agg-sha-full">{node.sha}</code>
            <CopyButton text={node.sha} label={t.copySha} t={t} />
          </dd>

          <dt>{t.authorLabel}</dt>
          <dd>
            <Avatar url={node.avatarUrl} name={node.authorName} size={22} />
            {onSearch ? (
              <button
                type="button"
                className="agg-link agg-link--plain"
                onClick={() => onSearch(author)}
                title={node.authorName}
              >
                {author}
              </button>
            ) : (
              <span>{author}</span>
            )}
            {node.authorLogin && node.authorLogin !== node.authorName && (
              <span className="agg-dim">({node.authorName})</span>
            )}
          </dd>

          <dt>{t.dateLabel}</dt>
          <dd>
            <time dateTime={node.date}>{formatAbsolute(node.date, locale)}</time>
            <span className="agg-dim">· {formatRelative(node.date, locale, now)}</span>
          </dd>

          <dt>{t.parentsLabel}</dt>
          <dd className="agg-stack">
            {parents.length === 0 && <span className="agg-dim">{t.noParents}</span>}
            {parents.length > 1 && <span className="agg-dim">{t.mergeOf(parents.length)}</span>}
            {parents.map((p) => (
              <CommitLink key={p} sha={p} bySha={bySha} onGoto={onGoto} />
            ))}
            {node.hasHiddenParents && <span className="agg-dim">… {t.truncated}</span>}
          </dd>

          {node.children.length > 0 && (
            <>
              <dt>{t.childrenLabel}</dt>
              <dd className="agg-stack">
                {node.children.map((c) => (
                  <CommitLink key={c} sha={c} bySha={bySha} onGoto={onGoto} />
                ))}
              </dd>
            </>
          )}

          {node.refs.length > 0 && (
            <>
              <dt>{t.refsLabel}</dt>
              <dd>
                <RefBadges
                  refs={node.refs}
                  color={node.color}
                  currentBranch={layout.repo.currentBranch}
                  t={t}
                />
              </dd>
            </>
          )}

          {containing.length > 0 && (
            <>
              <dt>
                {t.containedIn}
                <small className="agg-dim"> · {t.containedInNote}</small>
              </dt>
              <dd className="agg-chips-wrap">
                {containing.map((b) => (
                  <span
                    key={b.name}
                    className="agg-ref agg-ref--branch"
                    style={{ ['--agg-ref-color' as string]: b.color }}
                  >
                    <span className="agg-ref-name">{b.name}</span>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      </div>

      <footer className="agg-detail-foot">
        {node.url && onOpenCommit && (
          <button type="button" className="agg-cta agg-cta--sm" onClick={() => onOpenCommit(node)}>
            <ExternalIcon />
            {t.openCommit}
          </button>
        )}
      </footer>
    </aside>
  );
}
