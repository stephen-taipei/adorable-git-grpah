import { useCallback, useEffect, useRef, useState } from 'react';
import { GitGraphViewer } from '@adorable/graph-ui';
import { SourceBar, isThemeSetting } from './SourceBar';
import { TokenDialog } from './TokenDialog';
import { searchFromSource, sourceFromSearch } from './source';
import type { Source } from './source';
import { readStored, useStored, writeStored } from './storage';
import { locale, t } from './i18n';
import { clearGitHubCache, useGraphSource } from './useGraphSource';
import { DEFAULT_REPO } from './protocol';

const TOKEN_KEY = 'agg.github-token';

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
  if (source.kind === 'local') lastLocal.current = source;
  const [theme, setTheme] = useStored('agg.theme', 'auto', isThemeSetting);
  const [token, setToken] = useState(() => readStored(TOKEN_KEY) ?? '');
  const [tokenOpen, setTokenOpen] = useState(false);
  const { state, refresh, repoName } = useGraphSource(source, token);

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
        headerExtra={
          <SourceBar
            source={source}
            lastLocal={lastLocal.current}
            onNavigate={navigate}
            theme={theme}
            onThemeChange={setTheme}
          />
        }
      />
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
