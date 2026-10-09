import { useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref, RefObject } from 'react';
import type { GraphLayout } from '@adorable/graph-core';
import { LogGraphScene } from '../scene/LogGraphScene';
import type { SceneFocus, SceneTheme } from '../scene/LogGraphScene';
import type { LogMetrics } from '../scene/geometry';

export interface GitGraphCanvasHandle {
  replay(): void;
  setHover(sha: string | null): void;
}

export interface GitGraphCanvasProps {
  layout: GraphLayout;
  metrics: LogMetrics;
  theme: SceneTheme;
  /** 捲動容器（canvas 的視窗位置跟著它的 scrollTop 走） */
  scrollerRef: RefObject<HTMLElement | null>;
  /** 捲動內容（canvas 的定位基準；pointermove 也掛在這上面讓小球的眼睛跟著游標） */
  trackRef: RefObject<HTMLElement | null>;
  selectedSha: string | null;
  focus: SceneFocus;
  handleRef?: Ref<GitGraphCanvasHandle>;
  onError?: (error: unknown) => void;
  /** 資料來源的識別（例如 local / github）。換來源時即使 repo 同名也要當成全新的圖，而不是增量更新。 */
  sourceKey?: string;
}

/**
 * 把 LogGraphScene 接到 React：建立 / 銷毀、把捲動與尺寸變化餵給場景、把 layout 的更新轉成「增量」或「重播」。
 * 這個元件本身只輸出一個 `.agg-canvas` 容器（位於捲動內容裡的絕對定位視窗）。
 */
export function GitGraphCanvas({
  layout,
  metrics,
  theme,
  scrollerRef,
  trackRef,
  selectedSha,
  focus,
  handleRef,
  onError,
  sourceKey,
}: GitGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<LogGraphScene | null>(null);
  const cb = useRef({ onError, theme, metrics, selectedSha, focus });
  cb.current = { onError, theme, metrics, selectedSha, focus };

  useEffect(() => {
    const host = hostRef.current;
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!host || !scroller || !track) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scene: LogGraphScene;
    try {
      scene = new LogGraphScene(host, { theme: cb.current.theme, reducedMotion: mq.matches });
    } catch (err) {
      cb.current.onError?.(err);
      return;
    }
    sceneRef.current = scene;
    scene.setMetrics(cb.current.metrics);
    scene.setViewport(scroller.scrollTop, scroller.clientHeight);

    const sync = () => scene.setViewport(scroller.scrollTop, scroller.clientHeight);
    const onMove = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      scene.setPointer(e.clientX - r.left, e.clientY - r.top);
    };
    const onLeave = () => scene.setPointer(null);
    const onMq = () => scene.setReducedMotion(mq.matches);
    scroller.addEventListener('scroll', sync, { passive: true });
    track.addEventListener('pointermove', onMove, { passive: true });
    track.addEventListener('pointerleave', onLeave);
    mq.addEventListener('change', onMq);
    const ro = new ResizeObserver(sync);
    ro.observe(scroller);
    // 分頁被切到背景時省電
    const onVisibility = () => scene.setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      mq.removeEventListener('change', onMq);
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerleave', onLeave);
      scroller.removeEventListener('scroll', sync);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [scrollerRef, trackRef]);

  // 尺寸（列高 / lane 間距 / 欄寬）改變：不重播
  useEffect(() => {
    sceneRef.current?.setMetrics(metrics);
  }, [metrics]);

  // 同一個 repo 的更新（例如剛 commit）走增量：只讓新的 commit 彈出來；換 repo / 來源就整個重播
  const prev = useRef<{ repo: string; nodes: number } | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    const scroller = scrollerRef.current;
    if (!scene) return;
    // 父層可能剛調整過 scrollTop（保持使用者的位置），先讓場景看到最新的捲動位置再決定誰要彈出來
    if (scroller) scene.setViewport(scroller.scrollTop, scroller.clientHeight);
    const repo = `${sourceKey ?? ''}|${layout.repo.owner}/${layout.repo.name}`;
    const incremental = prev.current?.repo === repo && prev.current.nodes > 0;
    scene.setLayout(layout, { incremental });
    scene.setSelected(cb.current.selectedSha);
    scene.setFocus(cb.current.focus);
    prev.current = { repo, nodes: layout.nodes.length };
  }, [layout, sourceKey, scrollerRef]);

  useEffect(() => {
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    sceneRef.current?.setSelected(selectedSha);
  }, [selectedSha]);

  useEffect(() => {
    sceneRef.current?.setFocus(focus);
  }, [focus]);

  useImperativeHandle(
    handleRef,
    () => ({
      replay: () => sceneRef.current?.replay(true),
      setHover: (sha) => sceneRef.current?.setHover(sha),
    }),
    [],
  );

  return <div ref={hostRef} className="agg-canvas" />;
}
