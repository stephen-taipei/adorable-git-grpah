import type { CSSProperties } from 'react';
import type { RefInput } from '@adorable/graph-core';
import type { Messages } from '../i18n';
import { CloudIcon, TagIcon } from './icons';

/** 顯示順序：目前 checkout 的 → default → 本機 branch → remote branch → tag。 */
export function orderRefs(refs: readonly RefInput[], currentBranch?: string): RefInput[] {
  const rank = (r: RefInput) =>
    r.kind === 'tag'
      ? 4
      : !r.remote && r.name === currentBranch
        ? 0
        : r.isDefault
          ? 1
          : r.remote
            ? 3
            : 2;
  return [...refs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function RefBadge({
  r,
  color,
  currentBranch,
  t,
}: {
  r: RefInput;
  color: string;
  currentBranch?: string;
  t: Messages;
}) {
  const current = r.kind === 'branch' && !r.remote && r.name === currentBranch;
  const cls = [
    'agg-ref',
    r.kind === 'tag' ? 'agg-ref--tag' : r.remote ? 'agg-ref--remote' : 'agg-ref--branch',
    current ? 'agg-ref--current' : '',
    r.isDefault ? 'agg-ref--default' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = r.kind === 'branch' ? ({ '--agg-ref-color': color } as CSSProperties) : undefined;
  const title = [
    r.name,
    r.kind === 'tag' ? t.tagLabel : r.remote ? t.remoteLabel : '',
    r.isDefault ? t.defaultLabel : '',
    current ? t.headLabel : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={cls} style={style} title={title}>
      {current && <b className="agg-ref-head">{t.headLabel} ➜</b>}
      {r.isDefault && !current && <span aria-hidden="true">★</span>}
      {r.kind === 'tag' ? <TagIcon /> : r.remote ? <CloudIcon /> : null}
      <span className="agg-ref-name">{r.name}</span>
    </span>
  );
}

export function RefBadges({
  refs,
  color,
  currentBranch,
  t,
  max = Infinity,
}: {
  refs: readonly RefInput[];
  color: string;
  currentBranch?: string;
  t: Messages;
  max?: number;
}) {
  if (refs.length === 0) return null;
  const ordered = orderRefs(refs, currentBranch);
  const shown = ordered.slice(0, max);
  const hidden = ordered.slice(max);
  return (
    <span className="agg-refs">
      {shown.map((r) => (
        <RefBadge
          key={`${r.kind}:${r.name}`}
          r={r}
          color={color}
          currentBranch={currentBranch}
          t={t}
        />
      ))}
      {hidden.length > 0 && (
        <span className="agg-ref agg-ref--more" title={hidden.map((r) => r.name).join('\n')}>
          {t.moreRefs(hidden.length)}
        </span>
      )}
    </span>
  );
}
