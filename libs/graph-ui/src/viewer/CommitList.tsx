import { memo } from 'react';
import type { GraphNode } from '@adorable/graph-core';
import { formatRelative } from '../i18n';
import type { Locale, Messages } from '../i18n';
import type { SizeClass } from '../scene/geometry';
import { Avatar } from './Avatar';
import { useCopy } from './hooks';
import { RefBadges } from './RefBadges';
import { CheckIcon, CopyIcon, MergeIcon } from './icons';
import { copyText, formatAbsolute, parseSubject } from './format';

export const rowDomId = (sha: string) => `agg-row-${sha}`;

export function ColumnHeader({ t }: { t: Messages }) {
  return (
    <div className="agg-colhead" aria-hidden="true">
      <span className="agg-c-g">{t.colGraph}</span>
      <span className="agg-c-main">{t.colMessage}</span>
      <span className="agg-c-author">{t.colAuthor}</span>
      <span className="agg-c-date">{t.colDate}</span>
      <span className="agg-c-sha">{t.colCommit}</span>
    </div>
  );
}

function ShaButton({ node, t }: { node: GraphNode; t: Messages }) {
  const [state, copy] = useCopy(copyText);
  return (
    <button
      type="button"
      className="agg-sha"
      // 400 列各一個 tab 停駐點太多：鍵盤使用者用詳情面板的「複製 SHA」；滑鼠 / 觸控照常
      tabIndex={-1}
      data-state={state}
      title={
        state === 'ok'
          ? t.copied
          : state === 'fail'
            ? t.copyFailed
            : `${t.copyShaFull}\n${node.sha}`
      }
      aria-label={`${t.copyShaFull} ${node.shortSha}`}
      // 不要讓這顆按鈕的點擊同時選取整列
      onClick={(e) => {
        e.stopPropagation();
        copy(node.sha);
      }}
    >
      <code>{node.shortSha}</code>
      {state === 'ok' ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export interface CommitRowProps {
  node: GraphNode;
  t: Messages;
  locale: Locale;
  size: SizeClass;
  selected: boolean;
  dim: boolean;
  currentBranch?: string;
  /** 算相對時間用的「現在」。由父層固定，避免每次 render 都不一樣。 */
  now: number;
  onSelect: (sha: string) => void;
}

export const CommitRow = memo(function CommitRow({
  node,
  t,
  locale,
  size,
  selected,
  dim,
  currentBranch,
  now,
  onSelect,
}: CommitRowProps) {
  const parsed = parseSubject(node.subject);
  const relative = formatRelative(node.date, locale, now);
  const absolute = formatAbsolute(node.date, locale);
  const author = node.authorLogin ?? node.authorName;
  const isMerge = node.kind === 'merge';
  return (
    <div
      id={rowDomId(node.sha)}
      role="option"
      aria-selected={selected}
      className="agg-commit"
      data-sha={node.sha}
      data-row={node.row}
      data-lane={node.lane}
      data-kind={node.kind}
      data-selected={selected || undefined}
      data-dim={dim || undefined}
      onClick={() => onSelect(node.sha)}
    >
      <span className="agg-c-g" aria-hidden="true" />
      <div className="agg-c-main">
        <RefBadges
          refs={node.refs}
          color={node.color}
          currentBranch={currentBranch}
          t={t}
          max={size === 'narrow' ? 1 : 4}
        />
        {isMerge && (
          <span className="agg-merge" title={t.mergeOf(new Set(node.parents).size)}>
            <MergeIcon />
            <span>{t.mergeLabel}</span>
          </span>
        )}
        <span className="agg-subject" title={node.message}>
          {parsed.type && (
            <span className={`agg-type agg-type--${parsed.type}`}>
              {parsed.type}
              {parsed.breaking ? '!' : ''}
            </span>
          )}
          {parsed.scope && <span className="agg-scope">{parsed.scope}</span>}
          {parsed.type ? parsed.rest : node.subject || t.noMessage}
        </span>
      </div>
      <div className="agg-c-author" title={node.authorName}>
        <Avatar url={node.avatarUrl} name={node.authorName} size={size === 'narrow' ? 18 : 22} />
        <span className="agg-author-name">{author}</span>
      </div>
      <time
        className="agg-c-date"
        dateTime={node.date}
        title={absolute ? `${absolute} · ${relative}` : relative}
      >
        <span className="agg-date-abs">{absolute || relative}</span>
        <span className="agg-date-rel">{relative}</span>
      </time>
      <span className="agg-c-sha">
        <ShaButton node={node} t={t} />
      </span>
    </div>
  );
});
