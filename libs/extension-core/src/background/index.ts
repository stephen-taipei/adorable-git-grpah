import { GitHubError, fetchGitHubGraph } from '@adorable/graph-core';
import type { GraphData } from '@adorable/graph-core';
import type {
  BgError,
  BgRequest,
  BgResponse,
  FetchGraphResponse,
  RateLimitResponse,
  TabCommand,
} from '../shared/messages';
import { SETTINGS_KEY, loadSettings } from '../shared/settings';

/**
 * GitHub への要求にかける時間の上限。Firefox の background は event page で、アイドルが 30 秒続くと停止する。
 * 応答待ちの `sendResponse` はそれを延命しないので、その前に「ネットワークエラー」として明示的に失敗させる
 * （上限なしだと content script 側は "Receiving end does not exist" という分かりにくい失敗になる）。
 */
const FETCH_TIMEOUT_MS = 25_000;

const CACHE_PREFIX = 'cache:';
const CACHE_MAX_ENTRIES = 12;

interface CacheEntry {
  savedAt: number;
  graph: GraphData;
}

const inflight = new Map<string, Promise<FetchGraphResponse>>();

function toError(err: unknown): BgError {
  if (err instanceof GitHubError)
    return { code: err.code, message: err.message, resetAt: err.resetAt };
  return { code: 'unknown', message: err instanceof Error ? err.message : String(err) };
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(CACHE_PREFIX))
    .map(([k, v]) => [k, (v as CacheEntry).savedAt ?? 0] as const)
    .sort((a, b) => b[1] - a[1]);
  const stale = entries.slice(CACHE_MAX_ENTRIES).map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function fetchGraph(
  req: Extract<BgRequest, { type: 'fetch-graph' }>,
): Promise<FetchGraphResponse> {
  const settings = await loadSettings();
  const key =
    `${CACHE_PREFIX}${req.owner}/${req.repo}#${req.branchHint ?? ''}#${settings.maxBranches}x${settings.maxCommitsPerBranch}`.toLowerCase();

  if (!req.force && settings.cacheMinutes > 0) {
    const hit = (await chrome.storage.local.get(key))[key] as CacheEntry | undefined;
    if (hit && Date.now() - hit.savedAt < settings.cacheMinutes * 60_000) {
      return { ok: true, data: { graph: hit.graph, fromCache: true } };
    }
  }

  try {
    const graph = await fetchGitHubGraph(req.owner, req.repo, {
      token: settings.token || undefined,
      apiBase: __AGG_API_BASE__,
      branchHint: req.branchHint,
      maxBranches: settings.maxBranches,
      maxCommitsPerBranch: settings.maxCommitsPerBranch,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (settings.cacheMinutes > 0) {
      await chrome.storage.local.set({
        [key]: { savedAt: Date.now(), graph } satisfies CacheEntry,
      });
      await pruneCache();
    }
    return { ok: true, data: { graph, fromCache: false } };
  } catch (err) {
    return { ok: false, error: toError(err) };
  }
}

async function rateLimit(): Promise<RateLimitResponse> {
  const settings = await loadSettings();
  try {
    const res = await fetch(`${__AGG_API_BASE__}/rate_limit`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
      },
    });
    if (res.status === 401)
      return { ok: false, error: { code: 'unauthorized', message: 'Bad credentials' } };
    if (!res.ok) return { ok: false, error: { code: 'unknown', message: `HTTP ${res.status}` } };
    const body = (await res.json()) as {
      resources?: { core?: { limit: number; remaining: number; reset: number } };
    };
    const core = body.resources?.core;
    if (!core) return { ok: false, error: { code: 'unknown', message: 'Unexpected response' } };
    return {
      ok: true,
      data: { ...core, reset: core.reset * 1000, authenticated: Boolean(settings.token) },
    };
  } catch (err) {
    return { ok: false, error: { code: 'network', message: toError(err).message } };
  }
}

chrome.runtime.onMessage.addListener(
  (raw: unknown, sender, sendResponse: (r: BgResponse) => void) => {
    // 只接受自己這個 extension 的 context（content script / options page）
    if (sender.id !== chrome.runtime.id) return false;
    const req = raw as BgRequest | undefined;
    switch (req?.type) {
      case 'fetch-graph': {
        const key = `${req.owner}/${req.repo}#${req.branchHint ?? ''}#${req.force ? 'f' : ''}`;
        let p = inflight.get(key);
        if (!p) {
          p = fetchGraph(req).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        void p.then(sendResponse);
        return true;
      }
      case 'rate-limit':
        void rateLimit().then(sendResponse);
        return true;
      case 'clear-cache':
        void clearCache().then(() => sendResponse({ ok: true, data: null }));
        return true;
      case 'open-options':
        void chrome.runtime.openOptionsPage();
        sendResponse({ ok: true, data: null });
        return false;
      default:
        return false;
    }
  },
);

// token 或抓取範圍變更 → 舊 cache 可能含私有資料 / 不符新設定，直接清掉。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_KEY in changes) void clearCache();
});

// 點工具列圖示 → 切換目前 GitHub 分頁上的圖。
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' } satisfies TabCommand);
  } catch {
    // 不是 github.com 分頁（或剛安裝尚未重新整理）→ 以 badge 提示；badge 是 tab 專屬，換頁會自動清除。
    await chrome.action.setBadgeBackgroundColor({ color: '#ff7a8a', tabId: tab.id });
    await chrome.action.setBadgeText({ text: '!', tabId: tab.id });
  }
});
