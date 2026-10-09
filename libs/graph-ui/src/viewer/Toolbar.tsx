import type { ReactNode, RefObject } from 'react';
import type { GraphBranch } from '@adorable/graph-core';
import type { Messages } from '../i18n';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, CloudIcon, SearchIcon } from './icons';

export interface ToolbarProps {
  t: Messages;
  branches: readonly GraphBranch[];
  /** 每個 branch 比 default 多幾個 commit（default 本身不放） */
  ahead: ReadonlyMap<string, number>;
  commitsOn: ReadonlyMap<string, number>;
  defaultName?: string;
  query: string;
  onQuery: (q: string) => void;
  matchTotal: number;
  /** 目前跳到第幾個符合的（0-based），還沒跳過是 -1 */
  matchCursor: number;
  onStep: (dir: 1 | -1) => void;
  focusBranch: string | null;
  onFocusBranch: (name: string | null) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** 統計 chips（commit / branch / tag … 數量），放在搜尋框旁邊 */
  stats?: ReactNode;
}

export function Toolbar({
  t,
  branches,
  ahead,
  commitsOn,
  defaultName,
  query,
  onQuery,
  matchTotal,
  matchCursor,
  onStep,
  focusBranch,
  onFocusBranch,
  searchRef,
  stats,
}: ToolbarProps) {
  const searching = query.trim().length > 0;
  return (
    <div className="agg-toolbar">
      <div className="agg-search" role="search">
        <SearchIcon />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchLabel}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              onQuery('');
            }
          }}
        />
        {searching && (
          <>
            <span className="agg-search-count" role="status" aria-live="polite">
              {matchTotal === 0
                ? t.noMatches
                : t.matchCount(Math.max(matchCursor, -1) + 1 || 0, matchTotal)}
            </span>
            <button
              type="button"
              className="agg-mini-icon"
              onClick={() => onStep(-1)}
              disabled={matchTotal === 0}
              title={t.prevMatch}
              aria-label={t.prevMatch}
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              className="agg-mini-icon"
              onClick={() => onStep(1)}
              disabled={matchTotal === 0}
              title={t.nextMatch}
              aria-label={t.nextMatch}
            >
              <ChevronDownIcon />
            </button>
            <button
              type="button"
              className="agg-mini-icon"
              onClick={() => {
                onQuery('');
                searchRef.current?.focus();
              }}
              title={t.clearSearch}
              aria-label={t.clearSearch}
            >
              <CloseIcon />
            </button>
          </>
        )}
      </div>

      {stats}

      {branches.length > 0 && (
        <div className="agg-branches" role="group" aria-label={t.branchFilterLabel}>
          {branches.map((b) => {
            const n = ahead.get(b.name) ?? 0;
            const pressed = focusBranch === b.name;
            return (
              <button
                type="button"
                key={b.name}
                className="agg-branch"
                data-remote={b.remote ? '' : undefined}
                aria-pressed={pressed}
                style={{ background: b.color }}
                onClick={() => onFocusBranch(pressed ? null : b.name)}
                title={`${t.focusBranch(b.name)}\n${t.branchTitle(
                  b.name,
                  b.sha.slice(0, 7),
                  commitsOn.get(b.name) ?? 0,
                  n,
                  defaultName ?? '',
                )}`}
              >
                {b.isDefault ? '★ ' : ''}
                {b.remote && <CloudIcon />}
                <span className="agg-branch-name">{b.name}</span>
                {n > 0 && <small>↑{n}</small>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
