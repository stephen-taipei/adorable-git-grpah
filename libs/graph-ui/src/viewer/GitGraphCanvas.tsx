import { useEffect, useImperativeHandle, useRef } from 'react';
import type { Ref } from 'react';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import { GitGraphScene } from '../scene/GitGraphScene';
import type { SceneTheme } from '../scene/GitGraphScene';

export interface GitGraphCanvasHandle {
  replay(): void;
  fit(): void;
  focusHead(): void;
  focusSha(sha: string): void;
}

export interface CanvasHover {
  node: GraphNode;
  /** 相對於 canvas 容器左上角 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GitGraphCanvasProps {
  layout: GraphLayout;
  theme: SceneTheme;
  handleRef?: Ref<GitGraphCanvasHandle>;
  onHover?: (hover: CanvasHover | null) => void;
  onSelect?: (node: GraphNode) => void;
  onError?: (error: unknown) => void;
}

export function GitGraphCanvas({
  layout,
  theme,
  handleRef,
  onHover,
  onSelect,
  onError,
}: GitGraphCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GitGraphScene | null>(null);
  const cb = useRef({ onHover, onSelect, onError, theme });
  cb.current = { onHover, onSelect, onError, theme };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scene: GitGraphScene;
    try {
      scene = new GitGraphScene(host, {
        theme: cb.current.theme,
        reducedMotion: mq.matches,
        onHover: (h) => {
          if (!h) return cb.current.onHover?.(null);
          const r = host.getBoundingClientRect();
          cb.current.onHover?.({
            node: h.node,
            x: h.clientX - r.left,
            y: h.clientY - r.top,
            width: r.width,
            height: r.height,
          });
        },
        onSelect: (n) => cb.current.onSelect?.(n),
      });
    } catch (err) {
      cb.current.onError?.(err);
      return;
    }
    sceneRef.current = scene;
    const onMq = () => scene.setReducedMotion(mq.matches);
    mq.addEventListener('change', onMq);
    return () => {
      mq.removeEventListener('change', onMq);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // 同一個 repo 的更新（例如剛 commit）走增量：只讓新的 commit 彈出來，並保留使用者的鏡頭
  const prev = useRef<{ repo: string; nodes: number } | null>(null);
  useEffect(() => {
    const repo = `${layout.repo.owner}/${layout.repo.name}`;
    const incremental = prev.current?.repo === repo && prev.current.nodes > 0;
    sceneRef.current?.setLayout(layout, { incremental });
    prev.current = { repo, nodes: layout.nodes.length };
  }, [layout]);

  useEffect(() => {
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  useImperativeHandle(
    handleRef,
    () => ({
      replay: () => sceneRef.current?.replay(true),
      fit: () => sceneRef.current?.fit(),
      focusHead: () => sceneRef.current?.focusHead(),
      focusSha: (sha) => sceneRef.current?.focusSha(sha),
    }),
    [],
  );

  return <div ref={hostRef} className="agg-canvas" />;
}
