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
    // overlay 開著時，滾輪不該捲動後面的 GitHub 頁面（canvas 自己處理縮放）
    const el = backdropRef.current;
    const stop = (e: WheelEvent) => e.preventDefault();
    el?.addEventListener('wheel', stop, { passive: false });
    return () => el?.removeEventListener('wheel', stop);
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

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
