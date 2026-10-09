import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 元素內容區的寬 / 高（ResizeObserver）。第一次 render 之前就會量到，避免先用錯的尺寸畫一張。 */
export function useElementSize<T extends HTMLElement>(
  ref: RefObject<T | null>,
): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) =>
        prev.width === r.width && prev.height === r.height
          ? prev
          : { width: r.width, height: r.height },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const usePrefersDark = () => useMediaQuery('(prefers-color-scheme: dark)');
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

export type CopyState = 'idle' | 'ok' | 'fail';

/** 複製到剪貼簿，並在一小段時間內回報成功 / 失敗（讓按鈕顯示 ✓）。 */
export function useCopy(
  copy: (text: string) => Promise<boolean>,
): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = useCallback(
    (text: string) => {
      void copy(text).then((ok) => {
        setState(ok ? 'ok' : 'fail');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), 1300);
      });
    },
    [copy],
  );
  return [state, run];
}
