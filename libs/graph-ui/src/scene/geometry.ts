/**
 * 垂直 git log 版面的幾何計算（純函式，不碰 DOM / three，方便單元測試）。
 *
 * 座標系：捲動內容（track）的 CSS px，原點在 track 的左上角。
 * 第 `row` 列佔 [topPad + row * rowH, topPad + (row + 1) * rowH)，node 畫在列的垂直中央；
 * 最上面的 `topPad` 是留給第一個 node 頭上的皇冠，不然會被捲動容器裁掉。
 */

export type SizeClass = 'wide' | 'medium' | 'narrow';

/**
 * 詳情面板的大小（使用者用面板右上角的按鈕切換）。
 *   normal  寬螢幕並排時固定 `LAYOUT.detailW`
 *   wide    寬螢幕並排時約為整個 viewer 的一半（見 `detailWidthFor`）；中等寬度的浮動抽屜也跟著變寬（CSS）
 * 窄螢幕（底部面板）本來就是全寬，不分大小。
 */
export type DetailSize = 'normal' | 'wide';

export const NARROW_MAX = 640;
export const MEDIUM_MAX = 980;

export function sizeClassFor(rootWidth: number): SizeClass {
  if (rootWidth < NARROW_MAX) return 'narrow';
  if (rootWidth < MEDIUM_MAX) return 'medium';
  return 'wide';
}

/**
 * 欄位組合（說明欄之外的欄位）：
 *   full    作者 + 日期 + sha     compact  作者頭像 + 日期（相對）+ sha     min  只留 sha
 * 由「列表實際可用寬度」決定，而不是視窗寬度：詳情面板開著、lane 很多時列表會變窄。
 * 窄螢幕（兩行式的列）一律 'min'，作者 / 日期 / sha 排在第二行。
 */
export type ColsClass = 'full' | 'compact' | 'min';

export interface LogMetrics {
  size: SizeClass;
  cols: ColsClass;
  /** 一列的高度（px）。窄螢幕是兩行式的列，比較高。 */
  rowH: number;
  /** 第一列上方的留白（px） */
  topPad: number;
  /** 相鄰 lane 的水平間距（px） */
  lanePitch: number;
  /** lane 0 中心的 x（px） */
  padLeft: number;
  /** 線圖欄的寬度（px） */
  graphW: number;
  /** node 半徑（px） */
  radius: number;
}

/** 這些數字同時是 CSS 的 custom property（GitGraphViewer 設在 .agg-root 上），版面與計算不會各算各的。 */
export const LAYOUT = {
  bodyPad: { wide: 14, medium: 14, narrow: 8 } as Record<SizeClass, number>,
  cardBorder: { wide: 3, medium: 3, narrow: 2 } as Record<SizeClass, number>,
  /** 寬螢幕時詳情面板（normal）的寬度；與列表之間的間距 */
  detailW: 380,
  /** 寬螢幕時詳情面板（wide）的寬度：viewer 寬度 × frac，夾在 [min, max] */
  detailWide: { min: 380, frac: 0.5, max: 720 },
  gap: 12,
  /** 各欄位組合的欄寬（px）與欄距 / 右側 padding */
  col: {
    full: { author: 150, date: 160, sha: 96 },
    compact: { author: 30, date: 118, sha: 92 },
    min: { author: 0, date: 0, sha: 92 },
  } as Record<ColsClass, { author: number; date: number; sha: number }>,
  colGap: 10,
  rowPadRight: 12,
};

/** 說明欄以外所有固定寬度的總和（含欄距與右側 padding；不含線圖欄） */
export function fixedColumnsWidth(cols: ColsClass): number {
  const c = LAYOUT.col[cols];
  const n = cols === 'min' ? 2 : 4; // 欄距數：graph|subject(|author|date)|sha
  return c.author + c.date + c.sha + n * LAYOUT.colGap + LAYOUT.rowPadRight;
}

const ROW_H: Record<SizeClass, number> = { wide: 44, medium: 44, narrow: 62 };
const TOP_PAD = 10;
const RADIUS: Record<SizeClass, number> = { wide: 14, medium: 14, narrow: 15 };
/** 線圖欄的寬度上限，以及不管 lane 多寡都要留給說明欄的最小寬度 */
const MAX_GRAPH_W: Record<SizeClass, number> = { wide: 340, medium: 240, narrow: 150 };
const MAX_PITCH: Record<SizeClass, number> = { wide: 28, medium: 26, narrow: 18 };
const MIN_PITCH = 8;
const SUBJECT_MIN = { full: 220, compact: 180, min: 150 } as const;

const sameMetrics = (a: LogMetrics, b: LogMetrics) =>
  a.size === b.size &&
  a.cols === b.cols &&
  a.rowH === b.rowH &&
  a.topPad === b.topPad &&
  a.lanePitch === b.lanePitch &&
  a.padLeft === b.padLeft &&
  a.graphW === b.graphW &&
  a.radius === b.radius;

/** 數值相同就回傳舊物件：視窗每變 1px 寬都重算一次，但只有真的變了才該讓下游（場景重建）動起來。 */
export function stableMetrics(prev: LogMetrics | null, next: LogMetrics): LogMetrics {
  return prev && sameMetrics(prev, next) ? prev : next;
}

/** 寬螢幕（並排）時詳情面板的寬度（px，整數）。同時是 CSS 的 `--agg-detail-w`。 */
export function detailWidthFor(rootWidth: number, detailSize: DetailSize = 'normal'): number {
  if (detailSize !== 'wide') return LAYOUT.detailW;
  const { min, frac, max } = LAYOUT.detailWide;
  return Math.round(Math.min(max, Math.max(min, rootWidth * frac)));
}

/** 列表（卡片內容區）的可用寬度。`detailOpen` 且為寬螢幕時詳情面板靠右並排，其餘尺寸是浮在上面的抽屜 / 底部面板。 */
export function listWidthFor(
  rootWidth: number,
  detailOpen: boolean,
  detailSize: DetailSize = 'normal',
): number {
  const size = sizeClassFor(rootWidth);
  const docked = detailOpen && size === 'wide';
  return (
    rootWidth -
    2 * LAYOUT.bodyPad[size] -
    2 * LAYOUT.cardBorder[size] -
    (docked ? detailWidthFor(rootWidth, detailSize) + LAYOUT.gap : 0)
  );
}

/**
 * 依容器寬度、lane 數、詳情是否並排（與並排時的面板大小），決定列高、欄位組合、lane 間距與線圖欄寬。
 * 先看「列表真正剩多少寬度」選欄位組合（作者 / 日期放不下就收起來），再把線圖欄限制在不擠壞說明欄的範圍內；
 * lane 太多時壓縮間距，而不是讓線圖欄無限變寬。
 */
export function computeMetrics(
  rootWidth: number,
  laneCount: number,
  detailOpen = false,
  detailSize: DetailSize = 'normal',
): LogMetrics {
  const size = sizeClassFor(rootWidth);
  const radius = RADIUS[size];
  // 留給最大的 node（merge 1.2 × HEAD 1.1）的選取環（1.4×）與 hover 彈跳，不然會被 canvas 邊緣裁掉
  const padSide = Math.ceil(radius * 1.9) + 1;
  const lanes = Math.max(1, Math.floor(laneCount));
  const maxPitch = MAX_PITCH[size];
  const listW = listWidthFor(rootWidth, detailOpen, detailSize);

  const capW = Math.max(
    2 * padSide,
    Math.min(MAX_GRAPH_W[size], listW * (size === 'narrow' ? 0.34 : 0.45)),
  );
  const idealW = Math.min(capW, 2 * padSide + (lanes - 1) * maxPitch);

  let cols: ColsClass = 'min';
  if (size !== 'narrow') {
    if (listW - idealW - fixedColumnsWidth('full') >= SUBJECT_MIN.full) cols = 'full';
    else if (listW - idealW - fixedColumnsWidth('compact') >= SUBJECT_MIN.compact) cols = 'compact';
  }

  const fixed = size === 'narrow' ? LAYOUT.colGap + LAYOUT.rowPadRight : fixedColumnsWidth(cols);
  const avail = listW - fixed - SUBJECT_MIN[cols];
  const maxW = Math.max(2 * padSide, Math.min(capW, avail));
  const lanePitch =
    lanes <= 1
      ? maxPitch
      : Math.min(maxPitch, Math.max(MIN_PITCH, (maxW - 2 * padSide) / (lanes - 1)));
  return {
    size,
    cols,
    rowH: ROW_H[size],
    topPad: TOP_PAD,
    lanePitch,
    padLeft: padSide,
    graphW: Math.ceil(2 * padSide + (lanes - 1) * lanePitch),
    radius,
  };
}

export interface CanvasWindow {
  /** 視窗上緣在 track 內的位置（px） */
  top: number;
  /** 視窗高度（CSS px） */
  height: number;
  /** 實際使用的 devicePixelRatio（為了不超過 GPU 的 renderbuffer 上限，必要時會降低） */
  dpr: number;
}

export interface PlanWindowInput {
  scrollTop: number;
  viewH: number;
  /** track 總高度（px） */
  trackH: number;
  prev: CanvasWindow | null;
  devicePixelRatio: number;
  /** canvas 單邊的最大 device px（保守取 4096，行動 GPU 常見上限） */
  maxDevicePx?: number;
}

export const MAX_DEVICE_PX = 4096;
const MIN_OVERSCAN = 160;

/**
 * WebGL canvas 只畫「可視範圍 + 上下各一段緩衝」的視窗，而不是整條 track（400 列 × 44px 會超過貼圖上限）。
 * 視窗跟著 track 一起捲動（canvas 在捲動內容裡，和 DOM 列由合成器同步移動，不會有一個 frame 的錯位），
 * 只有捲到緩衝快用完時才重新定位並重畫。回傳 `prev` 本身代表「不用動」。
 */
export function planWindow(input: PlanWindowInput): CanvasWindow {
  const { scrollTop, viewH, trackH, prev } = input;
  const maxPx = input.maxDevicePx ?? MAX_DEVICE_PX;
  const dprWanted = Math.max(1, Math.min(input.devicePixelRatio || 1, 2));
  // 先保證「可視範圍 + 最小緩衝」塞得進 renderbuffer，塞不下就降 dpr
  const dpr = Math.max(1, Math.min(dprWanted, maxPx / Math.max(1, viewH + 2 * MIN_OVERSCAN)));
  const maxCssH = Math.floor(maxPx / dpr);
  const over = Math.max(MIN_OVERSCAN, Math.round(viewH * 0.5));
  const height = Math.max(1, Math.min(viewH + 2 * over, maxCssH, Math.ceil(trackH)));

  const margin = Math.min(120, Math.round((height - viewH) / 4));
  const maxTop = Math.max(0, Math.ceil(trackH) - height);
  const sameShape = prev && prev.height === height && prev.dpr === dpr;
  if (sameShape) {
    const needTop = prev.top > 0 && scrollTop < prev.top + margin;
    const needBottom =
      prev.top + prev.height < Math.ceil(trackH) &&
      scrollTop + viewH > prev.top + prev.height - margin;
    if (!needTop && !needBottom && prev.top <= maxTop) return prev;
  }
  const top = Math.min(maxTop, Math.max(0, Math.round(scrollTop - (height - viewH) / 2)));
  return { top, height, dpr };
}

/** 可視範圍內的第一列 / 最後一列索引（含），會夾在 [0, rowCount - 1]。 */
export function visibleRows(
  scrollTop: number,
  viewH: number,
  rowH: number,
  rowCount: number,
  topPad = 0,
): { first: number; last: number } {
  if (rowCount <= 0) return { first: 0, last: -1 };
  const top = scrollTop - topPad;
  const first = Math.min(rowCount - 1, Math.max(0, Math.floor(top / rowH)));
  const last = Math.min(rowCount - 1, Math.max(first, Math.ceil((top + viewH) / rowH) - 1));
  return { first, last };
}

/**
 * 資料更新（例如剛 commit 了一筆、新列插在最上面）或列高改變時，要把捲動位置調整到
 * 「使用者正在看的那個 commit」還在原來的位置。
 * - 使用者在最上面（scrollTop 很小）→ 不動，讓新的 commit 直接出現在眼前。
 * - 否則找出更新前視窗最上方的 commit（`anchorSha`）在新列中的位置，並保持視窗上緣落在該列內同樣的深度
 *   （`anchorOffset` = 更新前 `scrollTop - topPad - row * rowH`）。
 * `rowOf` 回傳 sha 在新 layout 的列索引（找不到回傳 undefined → 不調整）。
 */
export function anchoredScrollTop(opts: {
  scrollTop: number;
  rowH: number;
  /** 第一列上方的留白（px），預設 0 */
  topPad?: number;
  anchorSha: string | undefined;
  anchorOffset: number;
  rowOf: (sha: string) => number | undefined;
}): number {
  const { scrollTop, rowH, topPad = 0, anchorSha, anchorOffset, rowOf } = opts;
  if (scrollTop <= topPad + rowH * 0.5 || !anchorSha) return scrollTop;
  const row = rowOf(anchorSha);
  if (row === undefined) return scrollTop;
  return Math.max(0, topPad + row * rowH + anchorOffset);
}
