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
  const downOnBackdrop = useRef(false);

  // overlay 開著時，後面的 GitHub 頁面不能被滾輪 / 觸控捲動（捲動鏈接）：直接鎖住頁面的捲動，
  // 並保留捲軸的位置（scrollbar-gutter），背景才不會因為捲軸消失而位移。
  // 同時把頁面設成 inert：Tab / Shift+Tab 不會跑進後面看不見的 GitHub 元素（也就不會把頁面捲到那裡）。
  // overlay 的 shadow host 掛在 <html> 底下、不在 <body> 裡，所以不受影響。GitHub（Turbo）換頁會換掉 <body>，新的也要設。
  useEffect(() => {
    const html = document.documentElement;
    const hadScrollbar = window.innerWidth > html.clientWidth;
    const prev = { overflow: html.style.overflow, gutter: html.style.scrollbarGutter };
    html.style.overflow = 'hidden';
    // 原本有捲軸才保留它的位置；沒有捲軸的頁面加上 gutter 反而會讓版面位移
    if (hadScrollbar) html.style.scrollbarGutter = 'stable';
    const inerted = new Map<HTMLElement, boolean>();
    const makeInert = () => {
      const body = document.body;
      if (body && !inerted.has(body)) {
        inerted.set(body, body.inert);
        body.inert = true;
      }
    };
    makeInert();
    const mo = new MutationObserver(makeInert);
    mo.observe(html, { childList: true });
    return () => {
      mo.disconnect();
      for (const [el, was] of inerted) el.inert = was;
      html.style.overflow = prev.overflow;
      html.style.scrollbarGutter = prev.gutter;
    };
  }, []);

  // viewer 會自己拿到鍵盤焦點（見 GitGraphViewer）；這裡只處理兩件事：
  // 1. 萬一焦點掉到 overlay 外面（例如點了被 disable 的按鈕、focus 的元素被移除），按鍵不能漏給 GitHub 的快捷鍵，
  //    Esc 仍然要能關閉，其他按鍵把焦點拉回 overlay。
  // 2. viewer 沒有渲染出來（ErrorBoundary 的當機畫面）時，由 panel 接手焦點。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const scope = panel.getRootNode() as Document | ShadowRoot;
    if (!scope.activeElement || !panel.contains(scope.activeElement)) panel.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.composedPath().includes(panel)) return; // overlay 內部：由 React / viewer 的處理器負責
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
      else
        (panel.querySelector<HTMLElement>('.agg-root[tabindex]') ?? panel).focus({
          preventScroll: true,
        });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="agg-backdrop"
      // 點背景才關閉；從面板裡按下、拖到背景放開（選文字）不算。用 click 而不是 pointerdown：
      // 觸控時 pointerdown 就關掉的話，同一下點擊會穿透到底下的 GitHub 元素。
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
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
