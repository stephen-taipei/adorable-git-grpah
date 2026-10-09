import { describe, expect, it } from 'vitest';
import {
  LAYOUT,
  MAX_DEVICE_PX,
  anchoredScrollTop,
  computeMetrics,
  fixedColumnsWidth,
  listWidthFor,
  planWindow,
  sizeClassFor,
  stableMetrics,
  visibleRows,
} from './geometry.ts';

describe('sizeClassFor', () => {
  it.each([
    [320, 'narrow'],
    [639, 'narrow'],
    [640, 'medium'],
    [979, 'medium'],
    [980, 'wide'],
    [1500, 'wide'],
  ])('%ipx → %s', (w, size) => expect(sizeClassFor(w)).toBe(size));
});

describe('computeMetrics', () => {
  it('uses taller two-line rows on narrow screens', () => {
    expect(computeMetrics(390, 3).rowH).toBeGreaterThan(computeMetrics(1280, 3).rowH);
  });

  it('squeezes the lane pitch (not the subject column) when there are many lanes', () => {
    for (const width of [360, 390, 768, 1024, 1440]) {
      const few = computeMetrics(width, 2);
      const many = computeMetrics(width, 12);
      expect(many.lanePitch).toBeLessThanOrEqual(few.lanePitch);
      expect(many.graphW).toBeGreaterThanOrEqual(many.radius * 2);
    }
  });

  it('always leaves room for the subject, at every width, lane count and detail state', () => {
    for (const width of [
      320, 360, 390, 414, 600, 639, 640, 700, 768, 820, 979, 980, 1024, 1100, 1280, 1440, 1920,
    ]) {
      for (const lanes of [1, 2, 4, 8, 12]) {
        for (const detailOpen of [false, true]) {
          const m = computeMetrics(width, lanes, detailOpen);
          const fixed =
            m.size === 'narrow' ? LAYOUT.colGap + LAYOUT.rowPadRight : fixedColumnsWidth(m.cols);
          const subject = listWidthFor(width, detailOpen) - m.graphW - fixed;
          // 12 條 lane 在手機上會被 MIN_PITCH 撐到超出預算；其他情況說明欄至少要有 120px
          const tooManyLanes = m.size === 'narrow' && lanes >= 8;
          if (!tooManyLanes) {
            expect(
              subject,
              `${width}px, ${lanes} lanes, detail ${detailOpen}`,
            ).toBeGreaterThanOrEqual(120);
          }
        }
      }
    }
  });

  it('drops secondary columns as the list gets narrower (the detail panel eats width on wide screens)', () => {
    const open = computeMetrics(1024, 8, true);
    const closed = computeMetrics(1024, 8, false);
    expect(['compact', 'min']).toContain(open.cols);
    expect(open.cols).not.toBe('full');
    expect(closed.cols).toBe('full');
    expect(computeMetrics(1440, 3, false).cols).toBe('full');
    expect(computeMetrics(390, 3).cols).toBe('min');
  });

  it('only a docked detail (wide) shrinks the list', () => {
    expect(listWidthFor(1200, true)).toBe(listWidthFor(1200, false) - LAYOUT.detailW - LAYOUT.gap);
    expect(listWidthFor(800, true)).toBe(listWidthFor(800, false));
    expect(listWidthFor(390, true)).toBe(listWidthFor(390, false));
  });

  it('leaves headroom above the first row for the crown and beside lane 0 for the selection ring', () => {
    const m = computeMetrics(1200, 3);
    expect(m.topPad).toBeGreaterThanOrEqual(8);
    // 最大的 node（merge × HEAD = 1.32r）加上 1.4 倍的選取環
    expect(m.padLeft).toBeGreaterThanOrEqual(m.radius * 1.32 * 1.4);
  });

  it('handles zero and one lane', () => {
    expect(computeMetrics(1000, 0).graphW).toBe(computeMetrics(1000, 1).graphW);
    const one = computeMetrics(1000, 1);
    expect(one.padLeft).toBeGreaterThan(one.radius);
  });

  it('is finite for absurd inputs', () => {
    const m = computeMetrics(360, 40);
    expect(m.lanePitch).toBeGreaterThanOrEqual(8);
    expect(Number.isFinite(m.graphW)).toBe(true);
    expect(Number.isFinite(computeMetrics(0, 3).graphW)).toBe(true);
  });
});

describe('stableMetrics', () => {
  it('returns the previous object while every value is unchanged (1px resizes must not rebuild the scene)', () => {
    const a = computeMetrics(1440, 3);
    for (const w of [1441, 1442, 1500, 1920]) {
      expect(stableMetrics(a, computeMetrics(w, 3))).toBe(a);
    }
  });
  it('returns the new object as soon as something changes', () => {
    const a = computeMetrics(1440, 3);
    const b = computeMetrics(900, 3);
    expect(stableMetrics(a, b)).toBe(b);
    expect(stableMetrics(null, a)).toBe(a);
  });
});

describe('visibleRows', () => {
  it('clamps to the existing rows', () => {
    expect(visibleRows(0, 440, 44, 100)).toEqual({ first: 0, last: 9 });
    expect(visibleRows(4400, 440, 44, 100)).toEqual({ first: 99, last: 99 });
    expect(visibleRows(100, 440, 44, 3)).toEqual({ first: 2, last: 2 });
    expect(visibleRows(0, 440, 44, 0)).toEqual({ first: 0, last: -1 });
  });
  it('includes a partially visible last row', () => {
    expect(visibleRows(22, 440, 44, 100)).toEqual({ first: 0, last: 10 });
  });
  it('accounts for the headroom above the first row', () => {
    expect(visibleRows(10, 440, 44, 100, 10)).toEqual({ first: 0, last: 9 });
    expect(visibleRows(54, 440, 44, 100, 10)).toEqual({ first: 1, last: 10 });
    expect(visibleRows(0, 440, 44, 100, 10).first).toBe(0);
  });
});

describe('planWindow', () => {
  const base = { viewH: 600, trackH: 10_000, devicePixelRatio: 2 };

  it('starts with the viewport centred in an overscanned window', () => {
    const w = planWindow({ ...base, scrollTop: 2000, prev: null });
    expect(w.top).toBeLessThanOrEqual(2000 - 160);
    expect(w.top + w.height).toBeGreaterThanOrEqual(2000 + 600 + 160);
    expect(w.height * w.dpr).toBeLessThanOrEqual(MAX_DEVICE_PX);
  });

  it('clamps to the top and bottom of the track', () => {
    const top = planWindow({ ...base, scrollTop: 0, prev: null });
    expect(top.top).toBe(0);
    const bottom = planWindow({ ...base, scrollTop: 9400, prev: null });
    expect(bottom.top + bottom.height).toBe(10_000);
  });

  it('keeps the same window while the viewport is well inside it (no re-render on every scroll tick)', () => {
    const w = planWindow({ ...base, scrollTop: 2000, prev: null });
    for (const dy of [-20, 0, 15, 60]) {
      expect(planWindow({ ...base, scrollTop: 2000 + dy, prev: w })).toBe(w);
    }
  });

  it('re-centres before the overscan runs out, in either direction', () => {
    const w = planWindow({ ...base, scrollTop: 2000, prev: null });
    const down = planWindow({ ...base, scrollTop: w.top + w.height - 600 - 20, prev: w });
    expect(down).not.toBe(w);
    expect(down.top).toBeGreaterThan(w.top);
    const up = planWindow({ ...base, scrollTop: w.top + 20, prev: w });
    expect(up.top).toBeLessThan(w.top);
    // 重新定位後，可視範圍一定在新視窗內
    for (const [s, v] of [
      [w.top + w.height - 620, down],
      [w.top + 20, up],
    ] as const) {
      expect(s).toBeGreaterThanOrEqual(v.top);
      expect(s + 600).toBeLessThanOrEqual(v.top + v.height);
    }
  });

  it('does not thrash at the very top or bottom, where the window cannot move any further', () => {
    const w = planWindow({ ...base, scrollTop: 0, prev: null });
    expect(planWindow({ ...base, scrollTop: 10, prev: w })).toBe(w);
    const b = planWindow({ ...base, scrollTop: 9400, prev: null });
    expect(planWindow({ ...base, scrollTop: 9390, prev: b })).toBe(b);
  });

  it('lowers the pixel ratio instead of exceeding the renderbuffer limit on huge viewports', () => {
    const w = planWindow({
      scrollTop: 0,
      viewH: 3000,
      trackH: 50_000,
      devicePixelRatio: 3,
      prev: null,
    });
    expect(w.height * w.dpr).toBeLessThanOrEqual(MAX_DEVICE_PX);
    expect(w.dpr).toBeGreaterThanOrEqual(1);
  });

  it('shrinks to the track when the track is shorter than the viewport', () => {
    const w = planWindow({
      scrollTop: 0,
      viewH: 900,
      trackH: 300,
      devicePixelRatio: 1,
      prev: null,
    });
    expect(w).toMatchObject({ top: 0, height: 300 });
  });

  it('re-plans when the viewport is resized (window height changes)', () => {
    const a = planWindow({ ...base, scrollTop: 1000, prev: null });
    const b = planWindow({ ...base, viewH: 900, scrollTop: 1000, prev: a });
    expect(b).not.toBe(a);
    expect(b.height).toBeGreaterThan(a.height);
  });
});

describe('anchoredScrollTop', () => {
  const rows: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 };
  const rowOf = (sha: string) => rows[sha];

  it('leaves a reader at the top alone, so new commits appear in front of them', () => {
    expect(
      anchoredScrollTop({ scrollTop: 0, rowH: 44, anchorSha: 'd', anchorOffset: 0, rowOf }),
    ).toBe(0);
  });

  it('keeps the commit at the top of the viewport where it was (new rows inserted above)', () => {
    // 之前視窗上緣在 b（第 1 列）往下 10px 的地方；上面插入 2 列後 b 在第 3 列
    const next = anchoredScrollTop({
      scrollTop: 44 + 10,
      rowH: 44,
      anchorSha: 'd',
      anchorOffset: 10,
      rowOf,
    });
    expect(next).toBe(3 * 44 + 10);
  });

  it('scales the position with the row height when the layout switches between breakpoints', () => {
    const next = anchoredScrollTop({
      scrollTop: 44 * 2 + 22,
      rowH: 62,
      anchorSha: 'c',
      anchorOffset: (22 / 44) * 62,
      rowOf,
    });
    expect(next).toBeCloseTo(2 * 62 + 31);
  });

  it('does nothing when the anchor disappeared or there is none', () => {
    expect(
      anchoredScrollTop({ scrollTop: 500, rowH: 44, anchorSha: 'zzz', anchorOffset: 0, rowOf }),
    ).toBe(500);
    expect(
      anchoredScrollTop({ scrollTop: 500, rowH: 44, anchorSha: undefined, anchorOffset: 0, rowOf }),
    ).toBe(500);
  });

  it('keeps the same commit in place when there is headroom above the first row', () => {
    const next = anchoredScrollTop({
      scrollTop: 10 + 44 + 10,
      rowH: 44,
      topPad: 10,
      anchorSha: 'd',
      anchorOffset: 10,
      rowOf,
    });
    expect(next).toBe(10 + 3 * 44 + 10);
    // 最上面（含留白）不動
    expect(
      anchoredScrollTop({
        scrollTop: 10 + 20,
        rowH: 44,
        topPad: 10,
        anchorSha: 'd',
        anchorOffset: 0,
        rowOf,
      }),
    ).toBe(30);
  });

  it('never returns a negative scroll position', () => {
    expect(
      anchoredScrollTop({ scrollTop: 500, rowH: 44, anchorSha: 'a', anchorOffset: -300, rowOf }),
    ).toBe(0);
  });
});
