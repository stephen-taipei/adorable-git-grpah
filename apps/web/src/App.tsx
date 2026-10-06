import { useCallback, useEffect, useState } from 'react';
import { GitGraphViewer } from '@adorable/graph-ui';
import type { GraphNode } from '@adorable/graph-core';
import { SourceBar, isThemeSetting } from './SourceBar';
import { TokenDialog } from './TokenDialog';
import { searchFromSource, sourceFromSearch } from './source';
import type { Source } from './source';
import { readStored, useStored, writeStored } from './storage';
import { locale, t } from './i18n';
import { clearGitHubCache, useGraphSource } from './useGraphSource';

const TOKEN_KEY = 'agg.github-token';

function useSource(): [Source, (s: Source) => void] {
  const [source, setSource] = useState<Source>(() => sourceFromSearch(location.search));
  useEffect(() => {
    const onPop = () => setSource(sourceFromSearch(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Source) => {
    history.pushState({}, '', `${location.pathname}${searchFromSource(next)}`);
    setSource(next);
  }, []);
  return [source, navigate];
}

export function App() {
  const [source, navigate] = useSource();
  const [theme, setTheme] = useStored('agg.theme', 'auto', isThemeSetting);
  const [token, setToken] = useState(() => readStored(TOKEN_KEY) ?? '');
  const [tokenOpen, setTokenOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  const select = useCallback((node: GraphNode) => {
    if (node.url) {
      window.open(node.url, '_blank', 'noopener,noreferrer');
      return;
    }
    // 沒有 GitHub remote 的本機 repo：複製完整 sha
    void navigator.clipboard?.writeText(node.sha).then(
      () => setToast(t.copied(node.shortSha)),
      () => undefined,
    );
  }, []);

  return (
    <div className="web-root">
      <GitGraphViewer
        title={title}
        state={state}
        theme={theme === 'auto' ? 'auto' : theme}
        locale={locale}
        onRefresh={refresh}
        onOpenSettings={() => setTokenOpen(true)}
        onSelectNode={select}
        headerExtra={
          <SourceBar source={source} onNavigate={navigate} theme={theme} onThemeChange={setTheme} />
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
      {toast && (
        <div className="web-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
