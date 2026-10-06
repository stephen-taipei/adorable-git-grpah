import { parseRepoPath } from '../shared/repo';
import type { RepoRef } from '../shared/repo';

/**
 * github.com 是 SPA（Turbo），換頁不會重新載入 content script。
 * 以 Navigation API + turbo 事件 + 輕量輪詢追蹤目前所在 repo。
 */
let current: RepoRef | null = parseRepoPath(location.pathname);
const listeners = new Set<() => void>();

function refresh() {
  const next = parseRepoPath(location.pathname);
  const same =
    next?.owner === current?.owner &&
    next?.repo === current?.repo &&
    next?.branchHint === current?.branchHint;
  if (same) return;
  current = next;
  listeners.forEach((l) => l());
}

let started = false;
function start() {
  if (started) return;
  started = true;
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', refresh);
  document.addEventListener('turbo:load', refresh);
  window.addEventListener('popstate', refresh);
  setInterval(refresh, 1500);
}

export const repoStore = {
  subscribe(listener: () => void) {
    start();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => current,
};
