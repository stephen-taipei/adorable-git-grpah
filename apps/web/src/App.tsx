import { useCallback, useEffect, useRef, useState } from 'react';
import { GitGraphViewer } from '@adorable/graph-ui';
import type { DetailSize } from '@adorable/graph-ui';
import { SourceBar, isThemeSetting } from './SourceBar';
import { TokenDialog } from './TokenDialog';
import { localSource, searchFromSource, sourceFromSearch } from './source';
import type { Source } from './source';
import { readStored, useStored, writeStored } from './storage';
import { locale, t } from './i18n';
import { clearGitHubCache, useGraphSource } from './useGraphSource';
import { useGitControl } from './useGitControl';
import { DetailGitActions, GitBar } from './GitBar';
import { GitDialogs } from './GitDialogs';
import { DEFAULT_REPO } from './protocol';

const TOKEN_KEY = 'agg.github-token';
const isDetailSize = (v: string): v is DetailSize => v === 'normal' || v === 'wide';

function useSource(): [Source, (s: Source) => void] {
  const [source, setSource] = useState<Source>(() => sourceFromSearch(location.search));
  useEffect(() => {
    const onPop = () => setSource(sourceFromSearch(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Source) => {
    const url = `${location.pathname}${searchFromSource(next)}`;
    // 同一個網址不要再疊一筆歷史（否則上一頁要按好幾次才會動）
    if (url !== `${location.pathname}${location.search}`) history.pushState({}, '', url);
    setSource(next);
  }, []);
  return [source, navigate];
}

export function App() {
  const [source, navigate] = useSource();
  // 最近一次看的本機 repo（從 GitHub 切回本機時回到它）
  const lastLocal = useRef<Source>({ kind: 'local' });
  // 靜態建置只有預設 repo：網址裡的 ?local= 不用帶回去
  if (source.kind === 'local') lastLocal.current = import.meta.env.DEV ? source : { kind: 'local' };
  const [theme, setTheme] = useStored('agg.theme', 'auto', isThemeSetting);
  const [token, setToken] = useState(() => readStored(TOKEN_KEY) ?? '');
  const [tokenOpen, setTokenOpen] = useState(false);
  // 詳情面板的大小（面板右上角的按鈕）：記在這個瀏覽器，下次打開還是同一個大小
  const [detailSize, setDetailSize] = useStored<DetailSize>(
    'agg.detail-size',
    'normal',
    isDetailSize,
  );
  const { state, refresh, repoName, graph, loadMore, history } = useGraphSource(source, token);
  // git 動作只有 dev server（pnpm start）的本機來源有；server 不回應狀態（區網的畫面等）時整個不顯示
  const git = useGitControl(
    import.meta.env.DEV && source.kind === 'local' ? (source.id ?? DEFAULT_REPO) : null,
    source.kind === 'local' ? graph : null,
  );
  const gitReady = git.status !== null;

  const title = repoName
    ? repoName.owner === 'local'
      ? repoName.name
      : `${repoName.owner}/${repoName.name}`
    : source.kind === 'github'
      ? `${source.owner}/${source.repo}`
      : t.localTitle;

  useEffect(() => {
    document.title = `${title} · Adorable Git Graph`;
    document.documentElement.lang = locale;
  }, [title]);

  return (
    <div className="web-root">
      <GitGraphViewer
        title={title}
        state={state}
        theme={theme === 'auto' ? 'auto' : theme}
        locale={locale}
        sourceKey={
          source.kind === 'github'
            ? `github:${source.owner}/${source.repo}`
            : `local:${source.id ?? DEFAULT_REPO}`
        }
        onRefresh={refresh}
        onOpenSettings={() => setTokenOpen(true)}
        onLoadMore={loadMore}
        history={history}
        detailSize={detailSize}
        onDetailSizeChange={setDetailSize}
        renderDetailExtra={
          gitReady ? (node) => <DetailGitActions node={node} git={git} /> : undefined
        }
        headerExtra={
          <SourceBar
            source={source}
            lastLocal={lastLocal.current}
            onNavigate={navigate}
            theme={theme}
            onThemeChange={setTheme}
            extra={gitReady ? <GitBar git={git} /> : null}
          />
        }
      />
      <GitDialogs git={git} graph={graph} onOpenRepo={(id) => navigate(localSource(id))} />
      {tokenOpen && (
        <TokenDialog
          token={token}
          onClose={() => setTokenOpen(false)}
          onSave={(next) => {
            if (next !== token) clearGitHubCache();
            writeStored(TOKEN_KEY, next || null);
            setToken(next);
            setTokenOpen(false);
          }}
        />
      )}
    </div>
  );
}
