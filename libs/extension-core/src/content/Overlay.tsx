import { useEffect, useRef } from 'react';
import { ErrorBoundary, GitGraphViewer } from '@adorable/graph-ui';
import { sendToBackground } from '../shared/messages';
import type { RepoRef } from '../shared/repo';
import { useGraph } from './useGraph';

function githubTheme(): 'day' | 'night' | 'auto' {
  const mode = document.documentElement.getAttribute('data-color-mode');
  return mode === 'dark' ? 'night' : mode === 'light' ? 'day' : 'auto';
}

export function Overlay({ repo, onClose }: { repo: RepoRef; onClose: () => void }) {
  const { state, refresh } = useGraph(repo);
  const panelRef = useRef<HTMLDivElement>(null);

  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // overlay 開著時，滾輪不該捲動後面的 GitHub 頁面：捲動區自己處理（overscroll-behavior: contain），
    // 其餘地方（標題列、背景）的滾輪直接吃掉。
    const el = backdropRef.current;
    const stop = (e: WheelEvent) => {
      if (!(e.target as Element | null)?.closest?.('.agg-scroll, .agg-detail-body, .agg-branches'))
        e.preventDefault();
    };
    el?.addEventListener('wheel', stop, { passive: false });
    return () => el?.removeEventListener('wheel', stop);
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      className="agg-backdrop"
      ref={backdropRef}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="agg-panel"
        ref={panelRef}
        tabIndex={-1}
        // Esc 由 viewer 先處理（關詳情 → 清搜尋 → 清 branch 聚焦），都沒有東西可收時才會冒泡到這裡關閉 overlay
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={`Git graph · ${repo.owner}/${repo.repo}`}
      >
        <ErrorBoundary onClose={onClose}>
          <GitGraphViewer
            title={`${repo.owner}/${repo.repo}`}
            state={state}
            theme={githubTheme()}
            onRefresh={refresh}
            onClose={onClose}
            onOpenSettings={() => void sendToBackground({ type: 'open-options' })}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
