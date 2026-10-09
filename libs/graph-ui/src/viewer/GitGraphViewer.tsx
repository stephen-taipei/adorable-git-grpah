import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import {
  aheadCount,
  branchesContaining,
  buildReachability,
  computeStats,
  matchesQuery,
} from '@adorable/graph-core';
import type { GraphLayout, GraphNode } from '@adorable/graph-core';
import { detectLocale, formatDuration, formatRelative, getMessages } from '../i18n';
import type { Locale } from '../i18n';
import {
  LAYOUT,
  anchoredScrollTop,
  computeMetrics,
  stableMetrics,
  visibleRows,
} from '../scene/geometry';
import type { LogMetrics } from '../scene/geometry';
import { CommitDetail } from './CommitDetail';
import { ColumnHeader, CommitRow, rowDomId } from './CommitList';
import { GitGraphCanvas } from './GitGraphCanvas';
import type { GitGraphCanvasHandle } from './GitGraphCanvas';
import { Mascot } from './Mascot';
import { Toolbar } from './Toolbar';
import { useElementSize, usePrefersDark, usePrefersReducedMotion } from './hooks';
import { GearIcon, PlayIcon, RefreshIcon, CloseIcon, TopIcon } from './icons';

export type ViewerState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string; message?: string; resetAt?: number }
  /** `refreshing`：已有圖、正在背景重新抓取（保留捲動位置與選取，只讓重新整理按鈕轉圈）。 */
  | {
      kind: 'ready';
      layout: GraphLayout;
      refreshing?: boolean;
      /** 背景重新抓取失敗：保留原本的圖，另外顯示一行錯誤。 */
      refreshError?: { code: string; message?: string };
    };

export interface GitGraphViewerProps {
  /** 例如 `owner/repo` */
  title: string;
  state: ViewerState;
  theme?: 'day' | 'night' | 'auto';
  locale?: Locale;
  onRefresh?: () => void;
  onClose?: () => void;
  onOpenSettings?: () => void;
  /** 「在 GitHub 開啟」。預設：有 url 就開新分頁。 */
  onOpenCommit?: (node: GraphNode) => void;
  /** 顯示在標題列正下方的額外控制項（例如資料來源切換）。 */
  headerExtra?: ReactNode;
  /** 資料來源的識別（例如 `local` / `github`）。同名 repo 換來源時不會被當成「剛 commit 了一筆」的增量更新。 */
  sourceKey?: string;
}

function IconButton({
  label,
  onClick,
  children,
  tone,
  busy,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tone?: 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`agg-btn${tone ? ` agg-btn--${tone}` : ''}${busy ? ' agg-btn--busy' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      {children}
    </button>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function intersect(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null) {
  if (!a) return b;
  if (!b) return a;
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

export function GitGraphViewer({
  title,
  state,
  theme = 'auto',
  locale,
  onRefresh,
  onClose,
  onOpenSettings,
  onOpenCommit,
  headerExtra,
  sourceKey,
}: GitGraphViewerProps) {
  const loc = locale ?? detectLocale();
  const t = getMessages(loc);
  const prefersDark = usePrefersDark();
  const reducedMotion = usePrefersReducedMotion();
  const sceneTheme = theme === 'auto' ? (prefersDark ? 'night' : 'day') : theme;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<GitGraphCanvasHandle>(null);
  const { width: rootWidth } = useElementSize(rootRef);

  const [webglFailed, setWebglFailed] = useState(false);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(-1);
  const [focusBranch, setFocusBranch] = useState<string | null>(null);
  const [scrollbarW, setScrollbarW] = useState(0);

  const layout = state.kind === 'ready' ? state.layout : null;
  const hasRows = Boolean(layout && layout.nodes.length > 0);

  // ── 由 layout 衍生的資料（統計、可到達性、搜尋） ──────────────────────────
  const derived = useMemo(() => {
    if (!layout) return null;
    const bySha = new Map(layout.nodes.map((n) => [n.sha, n]));
    const reach = buildReachability(layout);
    const defaultName = layout.branches.find((b) => b.isDefault)?.name;
    const ahead = new Map<string, number>();
    const commitsOn = new Map<string, number>();
    for (const b of layout.branches) {
      commitsOn.set(b.name, reach.get(b.name)?.size ?? 0);
      if (defaultName && b.name !== defaultName)
        ahead.set(b.name, aheadCount(reach, b.name, defaultName));
    }
    return { bySha, reach, stats: computeStats(layout), defaultName, ahead, commitsOn };
  }, [layout]);
  const selectedNode = selectedSha && derived ? derived.bySha.get(selectedSha) : undefined;

  // 版面尺寸：依「列表實際可用寬度」計算（詳情並排時列表變窄）；數值沒變就沿用舊物件，
  // 否則拖動視窗每 1px 都會讓場景整個重建。
  const metricsPrev = useRef<LogMetrics | null>(null);
  const metrics = stableMetrics(
    metricsPrev.current,
    computeMetrics(rootWidth || 1200, layout?.laneCount ?? 1, Boolean(selectedNode)),
  );
  metricsPrev.current = metrics;

  const now = useMemo(() => Date.now(), [layout]);

  const branchSet = useMemo(
    () => (focusBranch && derived ? (derived.reach.get(focusBranch) ?? null) : null),
    [focusBranch, derived],
  );
  // 搜尋結果只算「沒被 branch 聚焦淡化掉」的列：計數、上一筆 / 下一筆、淡化三者一致
  const matchShas = useMemo(
    () =>
      layout && query.trim()
        ? layout.nodes
            .filter((n) => matchesQuery(n, query) && (!branchSet || branchSet.has(n.sha)))
            .map((n) => n.sha)
        : null,
    [layout, query, branchSet],
  );
  const matchSet = useMemo(() => (matchShas ? new Set(matchShas) : null), [matchShas]);
  const active = useMemo(() => intersect(matchSet, branchSet), [matchSet, branchSet]);
  const sceneFocus = useMemo(() => ({ active, edges: branchSet !== null }), [active, branchSet]);

  // layout 換掉之後，已經不存在的選取 / 聚焦要放掉
  useEffect(() => {
    if (!derived) return;
    if (selectedSha && !derived.bySha.has(selectedSha)) setSelectedSha(null);
    if (focusBranch && !derived.reach.has(focusBranch)) setFocusBranch(null);
  }, [derived, selectedSha, focusBranch]);

  // ── 捲動：保持使用者的位置、跳到某一列 ───────────────────────────────────
  const anchor = useRef<{ sha?: string; frac: number }>({ frac: 0 });
  const lastRepo = useRef<string | null>(null);
  const lastScroller = useRef<HTMLElement | null>(null);
  // 來源 / repo 的識別：中間就算只經過 loading 或錯誤畫面（沒有列表）也要記得「換過了」，
  // 回來時才會從頭看，而不是恢復成上一次看這個 repo 的位置
  const identity = `${sourceKey ?? ''}|${title}`;
  const lastIdentity = useRef(identity);
  useLayoutEffect(() => {
    if (lastIdentity.current === identity) return;
    lastIdentity.current = identity;
    lastRepo.current = null;
  }, [identity]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const metricsRef = useRef(metrics);

  const rememberAnchor = useCallback(() => {
    const sc = scrollerRef.current;
    const L = layoutRef.current;
    if (!sc || !L || L.nodes.length === 0) return;
    const { rowH, topPad } = metricsRef.current;
    const row = clamp(Math.floor((sc.scrollTop - topPad) / rowH), 0, L.nodes.length - 1);
    anchor.current = {
      sha: L.nodes[row]!.sha,
      frac: (sc.scrollTop - topPad - row * rowH) / rowH,
    };
  }, []);

  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    if (!sc || !layout) return;
    const repo = `${sourceKey ?? ''}|${layout.repo.owner}/${layout.repo.name}`;
    const { rowH, topPad } = metrics;
    // 列表被重新掛載（例如換 token 時中間經過 loading 畫面）：新的捲動容器從 0 開始，要回到使用者原本看的那一列
    const remounted = lastScroller.current !== sc;
    lastScroller.current = sc;
    if (lastRepo.current !== repo) {
      // 換了 repo / 來源：從頭看
      lastRepo.current = repo;
      sc.scrollTop = 0;
      anchor.current = { frac: 0 };
      setSelectedSha(null);
      setFocusBranch(null);
      setQuery('');
      setCursor(-1);
    } else {
      const rowOf = new Map(layout.nodes.map((n) => [n.sha, n.row]));
      const anchorRow = anchor.current.sha ? rowOf.get(anchor.current.sha) : undefined;
      const next =
        remounted && anchorRow !== undefined
          ? Math.max(0, topPad + (anchorRow + anchor.current.frac) * rowH)
          : anchoredScrollTop({
              scrollTop: sc.scrollTop,
              rowH,
              topPad,
              anchorSha: anchor.current.sha,
              anchorOffset: anchor.current.frac * rowH,
              rowOf: (sha) => rowOf.get(sha),
            });
      if (Math.abs(next - sc.scrollTop) > 0.5) sc.scrollTop = next;
    }
    metricsRef.current = metrics;
    rememberAnchor();
  }, [layout, metrics, sourceKey, rememberAnchor]);

  // 內容區與捲軸寬度（欄位標題要和列對齊）
  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const w = sc.offsetWidth - sc.clientWidth;
    setScrollbarW((prev) => (prev === w ? prev : w));
  });

  const scrollToRow = useCallback(
    (row: number, how: 'nearest' | 'center') => {
      const sc = scrollerRef.current;
      if (!sc) return;
      const { rowH, topPad } = metrics;
      const y = topPad + row * rowH;
      const h = sc.clientHeight;
      let top = sc.scrollTop;
      if (h < rowH * 2.5)
        top = y; // 矮到放不下幾列：直接讓那一列貼齊上緣
      else if (how === 'center') top = y + rowH / 2 - h / 2;
      else if (y < sc.scrollTop + rowH * 0.25) top = y - rowH * 0.75;
      else if (y + rowH > sc.scrollTop + h - rowH * 0.25) top = y + rowH * 1.75 - h;
      else return;
      sc.scrollTo({
        top: clamp(top, 0, Math.max(0, sc.scrollHeight - h)),
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    },
    [metrics, reducedMotion],
  );

  const select = useCallback(
    (sha: string | null, how: 'nearest' | 'center' | null = null) => {
      setSelectedSha(sha);
      const row = sha ? derived?.bySha.get(sha)?.row : undefined;
      if (row !== undefined && how) scrollToRow(row, how);
    },
    [derived, scrollToRow],
  );

  // 手機的底部面板在 flex 流程裡（列表的可視高度會縮小）：面板「剛打開」時，等版面更新完再把那一列捲到看得見的地方。
  // 面板已經開著時（上一個 / 下一個、搜尋跳轉）由 select() 自己決定對齊方式，這裡不要再蓋掉。
  const sheetWasOpen = useRef(false);
  useLayoutEffect(() => {
    const open = metrics.size === 'narrow' && Boolean(selectedNode);
    if (open && !sheetWasOpen.current && selectedNode) scrollToRow(selectedNode.row, 'nearest');
    sheetWasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在選取 / 尺寸等級改變時跑
  }, [selectedNode?.sha, metrics.size]);

  // 鍵盤焦點：開啟時、詳情關閉（按鈕被移除）、焦點落在被 disable 或被隱藏的按鈕時，把焦點收回 viewer，
  // 否則快捷鍵失效，而且在 extension 裡按鍵會落到 GitHub 的頁面快捷鍵。
  // 焦點在 viewer 外面的正常元素上（例如 web app 的 token 對話框）時不搶。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scope = root.getRootNode() as Document | ShadowRoot;
    const active = scope.activeElement as (HTMLElement & { disabled?: boolean }) | null;
    const lost =
      !active ||
      active === document.body ||
      (root.contains(active) &&
        active !== root &&
        (Boolean(active.disabled) || active.getClientRects().length === 0));
    if (lost) root.focus({ preventScroll: true });
  }, [selectedNode?.sha]);

  const onRowSelect = useCallback(
    (sha: string) => setSelectedSha((cur) => (cur === sha ? null : sha)),
    [],
  );

  const moveSelection = useCallback(
    (delta: number | 'first' | 'last') => {
      const L = layoutRef.current;
      const sc = scrollerRef.current;
      if (!L || L.nodes.length === 0 || !sc) return;
      const n = L.nodes.length;
      const cur = selectedSha ? (derived?.bySha.get(selectedSha)?.row ?? -1) : -1;
      let row: number;
      if (delta === 'first') row = 0;
      else if (delta === 'last') row = n - 1;
      else if (cur < 0)
        row = visibleRows(sc.scrollTop, sc.clientHeight, metrics.rowH, n, metrics.topPad).first;
      else row = clamp(cur + delta, 0, n - 1);
      select(L.nodes[row]!.sha, 'nearest');
    },
    [selectedSha, derived, metrics, select],
  );

  // ── 搜尋 / branch 聚焦 ─────────────────────────────────────────────────
  const onQuery = useCallback((q: string) => {
    setQuery(q);
    setCursor(-1);
  }, []);

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (!matchShas || matchShas.length === 0) return;
      const next = (cursor + dir + matchShas.length) % matchShas.length;
      // 第一次按「上一筆」從最後一筆開始
      const idx = cursor === -1 && dir === -1 ? matchShas.length - 1 : next;
      setCursor(idx);
      select(matchShas[idx]!, 'center');
    },
    [matchShas, cursor, select],
  );

  const onFocusBranch = useCallback(
    (name: string | null) => {
      setFocusBranch(name);
      if (!name || !layout) return;
      const tip = layout.branches.find((b) => b.name === name)?.sha;
      const row = tip ? derived?.bySha.get(tip)?.row : undefined;
      if (row !== undefined) scrollToRow(row, 'center');
    },
    [layout, derived, scrollToRow],
  );

  const openCommit = useCallback(
    (node: GraphNode) => {
      if (onOpenCommit) onOpenCommit(node);
      else if (node.url) window.open(node.url, '_blank', 'noopener,noreferrer');
    },
    [onOpenCommit],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // 輸入法選字中（Enter 是確認候選字、Esc 是取消組字）不是快捷鍵
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const typing = (e.target as HTMLElement).closest?.('input, textarea, select');
    if (e.key === 'Escape') {
      // 一次只收掉一層：詳情 → 搜尋 → branch 聚焦；都沒有才交給外層（例如關閉 overlay）
      // 只收「看得到」的層：錯誤 / 載入畫面上，看不見的舊選取或搜尋不該吃掉關閉 overlay 的 Esc
      if (selectedNode) setSelectedSha(null);
      else if (hasRows && query) setQuery('');
      else if (hasRows && focusBranch) setFocusBranch(null);
      else return;
      e.stopPropagation();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        moveSelection(1);
        break;
      case 'ArrowUp':
      case 'k':
        moveSelection(-1);
        break;
      case 'Home':
        moveSelection('first');
        break;
      case 'End':
        moveSelection('last');
        break;
      case '/':
        searchRef.current?.focus();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ── 小球的 hover：用事件委派，不經過 React state（滑過幾百列不會重繪） ───────
  const onTrackOver = (e: PointerEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest?.('.agg-commit') as HTMLElement | null;
    canvasRef.current?.setHover(row?.dataset['sha'] ?? null);
  };
  const onTrackLeave = () => canvasRef.current?.setHover(null);

  const stats = derived?.stats;
  const filtered = active ? active.size : null;

  const statChips = layout && stats && (
    <div className="agg-stats">
      {filtered !== null && (
        <span className="agg-chip agg-chip--filter" role="status">
          {t.filtering(filtered, stats.commits)}
        </span>
      )}
      <span className="agg-chip agg-chip--commits">{t.commits(stats.commits)}</span>
      <span className="agg-chip agg-chip--branches">{t.branches(stats.branches)}</span>
      {stats.tags > 0 && <span className="agg-chip">{t.tags(stats.tags)}</span>}
      {stats.authors.length > 0 && (
        <span
          className="agg-chip"
          title={stats.authors
            .slice(0, 8)
            .map((a) => `${a.login ?? a.name} · ${a.commits}`)
            .join('\n')}
        >
          {t.authors(stats.authors.length)}
        </span>
      )}
      {stats.merges > 0 && <span className="agg-chip">{t.merges(stats.merges)}</span>}
      {stats.lastDate && (
        <span className="agg-chip agg-chip--soft">
          {t.lastCommit(formatRelative(stats.lastDate, loc, now))}
        </span>
      )}
    </div>
  );

  return (
    <div
      className="agg-root"
      ref={rootRef}
      data-theme={sceneTheme}
      data-size={metrics.size}
      data-cols={metrics.cols}
      data-detail={selectedNode ? '' : undefined}
      tabIndex={-1}
      style={
        {
          '--agg-row-h': `${metrics.rowH}px`,
          '--agg-top-pad': `${metrics.topPad}px`,
          // WebGL 不能用時整個線圖欄只留一條窄縫，把空間還給說明欄
          '--agg-graph-w': `${webglFailed ? 12 : metrics.graphW}px`,
          '--agg-sbw': `${scrollbarW}px`,
          '--agg-body-pad': `${LAYOUT.bodyPad[metrics.size]}px`,
          '--agg-detail-w': `${LAYOUT.detailW}px`,
          '--agg-col-author': `${LAYOUT.col[metrics.cols].author}px`,
          '--agg-col-date': `${LAYOUT.col[metrics.cols].date}px`,
          '--agg-col-sha': `${LAYOUT.col[metrics.cols].sha}px`,
        } as CSSProperties
      }
      onKeyDown={onKeyDown}
    >
      <div className="agg-sky" />

      <header className="agg-top">
        <div className="agg-pill agg-title">
          <Mascot size={26} />
          <span className="agg-title-text">{title}</span>
        </div>
        <div className="agg-pill agg-actions">
          {hasRows && (
            <>
              <IconButton label={t.replay} onClick={() => canvasRef.current?.replay()}>
                <PlayIcon />
              </IconButton>
              <IconButton
                label={t.latest}
                onClick={() =>
                  scrollerRef.current?.scrollTo({
                    top: 0,
                    behavior: reducedMotion ? 'auto' : 'smooth',
                  })
                }
              >
                <TopIcon />
              </IconButton>
            </>
          )}
          {onRefresh && (
            <IconButton
              label={t.refresh}
              onClick={onRefresh}
              busy={state.kind === 'ready' && state.refreshing}
            >
              <RefreshIcon />
            </IconButton>
          )}
          {onOpenSettings && (
            <IconButton label={t.settings} onClick={onOpenSettings}>
              <GearIcon />
            </IconButton>
          )}
          {onClose && (
            <IconButton label={t.close} onClick={onClose} tone="danger">
              <CloseIcon />
            </IconButton>
          )}
        </div>
      </header>

      {headerExtra && <div className="agg-subbar">{headerExtra}</div>}

      {layout && derived && hasRows && (
        <Toolbar
          t={t}
          branches={layout.branches}
          ahead={derived.ahead}
          commitsOn={derived.commitsOn}
          defaultName={derived.defaultName}
          query={query}
          onQuery={onQuery}
          matchTotal={matchShas?.length ?? 0}
          matchCursor={cursor}
          onStep={stepMatch}
          focusBranch={focusBranch}
          onFocusBranch={onFocusBranch}
          searchRef={searchRef}
          stats={statChips}
        />
      )}

      <div className="agg-body">
        {layout && derived && hasRows && (
          <div className="agg-main">
            {webglFailed && (
              <div className="agg-banner" role="status">
                {t.webglFail}
              </div>
            )}
            {state.kind === 'ready' && state.refreshError && (
              <div className="agg-banner agg-banner--error" role="alert">
                {t.refreshFailed}{' '}
                {t.errors[state.refreshError.code] ??
                  state.refreshError.message ??
                  t.errors['unknown']}
              </div>
            )}
            <div className="agg-colhead-wrap">
              <ColumnHeader t={t} />
            </div>
            <div
              className="agg-scroll"
              ref={scrollerRef}
              role="listbox"
              aria-label={t.listLabel}
              aria-activedescendant={selectedSha ? rowDomId(selectedSha) : undefined}
              tabIndex={0}
              onScroll={rememberAnchor}
            >
              <div
                className="agg-log"
                ref={trackRef}
                onPointerOver={onTrackOver}
                onPointerLeave={onTrackLeave}
              >
                {layout.nodes.map((n) => (
                  <CommitRow
                    key={n.sha}
                    node={n}
                    t={t}
                    locale={loc}
                    size={metrics.size}
                    selected={n.sha === selectedSha}
                    dim={active !== null && !active.has(n.sha)}
                    currentBranch={layout.repo.currentBranch}
                    now={now}
                    onSelect={onRowSelect}
                  />
                ))}
                <div className="agg-footer">
                  {layout.truncated ? `… ${t.truncated}` : t.startOfHistory}
                </div>
                {!webglFailed && (
                  <GitGraphCanvas
                    layout={layout}
                    metrics={metrics}
                    theme={sceneTheme}
                    scrollerRef={scrollerRef}
                    trackRef={trackRef}
                    selectedSha={selectedNode ? selectedNode.sha : null}
                    focus={sceneFocus}
                    handleRef={canvasRef}
                    sourceKey={sourceKey}
                    onError={() => setWebglFailed(true)}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {layout && derived && selectedNode && (
          <CommitDetail
            node={selectedNode}
            layout={layout}
            bySha={derived.bySha}
            containing={branchesContaining(layout, derived.reach, selectedNode.sha)}
            t={t}
            locale={loc}
            now={now}
            onClose={() => setSelectedSha(null)}
            onGoto={(sha) => select(sha, 'nearest')}
            onOpenCommit={openCommit}
            onSearch={onQuery}
          />
        )}

        {state.kind === 'loading' && (
          <div className="agg-center" role="status">
            <Mascot size={92} className="agg-bounce" />
            <div className="agg-shadow" />
            <div className="agg-msg-title">{t.loading}</div>
            <div className="agg-msg-sub">{t.loadingSub}</div>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="agg-center" role="alert">
            <Mascot size={92} mood="sad" color="#ff7a8a" className="agg-wobble" />
            <div className="agg-msg-title">{t.errorTitle}</div>
            <div className="agg-msg-sub">
              {t.errors[state.code] ?? state.message ?? t.errors['unknown']}
              {state.code === 'rate_limited' && state.resetAt ? (
                <>
                  <br />
                  {t.rateLimitReset(formatDuration(Math.max(0, state.resetAt - Date.now()), loc))}
                  {onOpenSettings ? ` · ${t.addToken}` : ''}
                </>
              ) : null}
            </div>
            <div className="agg-row">
              {onRefresh && (
                <button type="button" className="agg-cta" onClick={onRefresh}>
                  {t.retry}
                </button>
              )}
              {onOpenSettings &&
                (state.code === 'rate_limited' ||
                  state.code === 'not_found' ||
                  state.code === 'unauthorized') && (
                  <button type="button" className="agg-cta agg-cta--ghost" onClick={onOpenSettings}>
                    {t.settings}
                  </button>
                )}
            </div>
          </div>
        )}

        {layout && layout.nodes.length === 0 && (
          <div className="agg-center">
            <Mascot size={92} mood="sleepy" color="#b58cff" className="agg-bounce" />
            <div className="agg-msg-title">{t.emptyTitle}</div>
            <div className="agg-msg-sub">{t.emptySub}</div>
          </div>
        )}
      </div>
    </div>
  );
}
