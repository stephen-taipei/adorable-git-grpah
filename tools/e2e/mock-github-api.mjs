// e2e 共用：假的 GitHub REST API（只實作 graph-core 的 fetchGitHubGraph / fetchGitHubCommitsFrom 會用到的端點）。
// repo：demo/adorable-git-graph（SPECS，22 筆）與 demo/long-history（LONG，infinite scroll 用的長歷史）。
// `/commits?sha=` 可以是 branch 名稱，也可以是 40 位 hex 的 commit sha（infinite scroll 從 missing parent 往回抓）。
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// ───────────────────────── mock GitHub API ─────────────────────────

export const sha = (id) => createHash('sha1').update(id).digest('hex');
const H = 3600_000;
const T0 = Date.UTC(2026, 0, 1);
export const SPECS = [
  ['m1', [], 'chore: initial commit', 'amy', 0],
  ['m2', ['m1'], 'chore: scaffold nx workspace', 'amy', 10],
  ['m3', ['m2'], 'feat: git graph lane layout', 'amy', 20],
  ['f1', ['m3'], 'feat: toon shaded commit balls', 'ben', 28],
  ['f2', ['f1'], 'feat: animated flow ribbons', 'ben', 34],
  ['m4', ['m3'], 'docs: write readme', 'amy', 36],
  ['f3', ['f2'], 'fix: outline z-fighting', 'ben', 44],
  ['m5', ['m4'], 'feat: github api client', 'amy', 50],
  ['x1', ['m5'], 'fix: handle rate limit 403', 'cat', 56],
  ['m6', ['m5', 'f3'], "Merge branch 'feat/three-scene'", 'amy', 62],
  ['x2', ['x1'], 'test: rate limit cases', 'cat', 66],
  ['m7', ['m6', 'x2'], 'Merge pull request #3 from fix/rate-limit', 'amy', 72],
  ['m8', ['m7'], 'feat: chrome extension shell', 'amy', 80],
  ['y1', ['m8'], 'feat: night theme', 'cat', 86],
  ['m9', ['m8'], 'chore: add icons', 'amy', 90],
  ['y2', ['y1'], 'feat: twinkling stars', 'cat', 96],
  ['m10', ['m9'], 'feat: replay animation', 'amy', 100],
  ['r1', ['m10'], 'chore: bump version 0.1.0', 'ben', 104],
  ['r2', ['r1'], 'fix: manifest permissions', 'ben', 108],
  ['m11', ['m10'], 'feat: branch legend', 'amy', 110],
  ['m12', ['m11'], 'Revert "feat: branch legend"', 'amy', 114],
  ['m13', ['m12'], 'docs: usage gif', 'amy', 120],
];
const HEADS = { main: 'm13', 'feat/dark-mode': 'y2', 'release/v0.1': 'r2', 'a-old': 'm1' };
const TAGS = { 'v0.1.0': 'r2', 'v0.0.1': 'm3' };

/**
 * infinite scroll 用的長歷史 demo/long-history（共 LONG.total 筆）：
 *   main 一條直線 L1 ← L2 ← … ← L150（每 2 小時一筆，L150 最新）；
 *   已合併的舊 topic：T1 ← T2 ← T3 從 L60 分出、在 L70 合併（L70 = merge [L69, T3]，T 的時間夾在 L61–L66 之間）；
 *   沒合併的 feat/long-side：S1 ← S2 從 L146 分出。
 *   tag：v2.0 在 L148（第一批就有）、v1.0 在 L40（要往回載入幾批之後才出現）。
 * 每條 branch 只抓一頁（per_page）時，第一批只有最新的一段，其餘靠 `/commits?sha=<missing parent>` 往回抓。
 */
const LONG_N = 150;
const LONG_PREFIX = ['feat', 'fix', 'docs', 'chore', 'refactor', 'test'];
const LONG_AUTHORS = ['amy', 'ben', 'cat'];
const longSpecs = [];
for (let i = 1; i <= LONG_N; i++) {
  const parents = i === 1 ? [] : i === 70 ? ['L69', 'T3'] : [`L${i - 1}`];
  const msg =
    i === 1
      ? 'chore: start the long history'
      : i === 70
        ? "Merge branch 'topic/old-parser'"
        : `${LONG_PREFIX[i % LONG_PREFIX.length]}: long history step ${i}`;
  longSpecs.push([`L${i}`, parents, msg, LONG_AUTHORS[i % 3], i * 2]);
}
longSpecs.push(
  ['T1', ['L60'], 'feat: old parser draft', 'ben', 123],
  ['T2', ['T1'], 'fix: old parser edge case', 'ben', 127],
  ['T3', ['T2'], 'test: old parser cases', 'ben', 131],
  ['S1', ['L146'], 'feat: long side branch', 'cat', 293],
  ['S2', ['S1'], 'fix: long side branch polish', 'cat', 297],
);
export const LONG = {
  owner: 'demo',
  name: 'long-history',
  /** 與 SPECS 同格式：[id, parents, message, author, hours] */
  specs: longSpecs,
  heads: { main: `L${LONG_N}`, 'feat/long-side': 'S2' },
  tags: { 'v2.0': 'L148', 'v1.0': 'L40' },
  total: longSpecs.length,
};

function makeRepo(name, specs, heads, tags) {
  const byId = new Map(
    specs.map((s) => [
      s[0],
      { id: s[0], parents: s[1], msg: s[2], author: s[3], at: T0 + s[4] * H },
    ]),
  );
  const bySha = new Map([...byId.keys()].map((id) => [sha(id), id]));
  return { name, byId, bySha, heads, tags };
}
const REPOS = new Map(
  [
    makeRepo('adorable-git-graph', SPECS, HEADS, TAGS),
    makeRepo(LONG.name, LONG.specs, LONG.heads, LONG.tags),
  ].map((r) => [r.name, r]),
);

/** id 的所有祖先（含自己），由新到舊（與 GitHub 的 /commits 一樣是時間倒序）。 */
const ancestors = (repo, id) => {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    repo.byId.get(cur).parents.forEach((p) => stack.push(p));
  }
  return [...seen].map((i) => repo.byId.get(i)).sort((a, b) => b.at - a.at);
};

const apiCommit = (repo, c, base) => ({
  sha: sha(c.id),
  html_url: `https://github.com/demo/${repo.name}/commit/${sha(c.id)}`,
  parents: c.parents.map((p) => ({ sha: sha(p) })),
  commit: {
    message: c.msg,
    author: { name: c.author, date: new Date(c.at).toISOString() },
    committer: { name: c.author, date: new Date(c.at).toISOString() },
  },
  author: { login: c.author, avatar_url: `${base}/avatar/${c.author}.svg` },
});

export const seen = { auth: [], paths: [] };
/**
 * 每個 API 回應前多等幾毫秒（預設 0）。快到 React 把「開始重新整理」和「完成」合併成同一次 render 時，
 * 轉圈根本不會出現；要驗證轉圈的步驟把這個調高，結束後記得歸零。
 */
export const latency = { ms: 0 };
/**
 * 故障注入：接下來 `more` 個「從 commit sha 往回抓」（`/commits?sha=<40 位 hex>`）的請求回 502（驗證「載入失敗 → 再試一次」）。
 * 只影響 infinite scroll 的請求；branch 名稱的請求（第一批）不受影響。
 */
export const faults = { more: 0 };
/**
 * 暫停「從 commit sha 往回抓」的請求：`gate.hold = true` 之後到達的這類請求先排隊（`gate.queue.length` 看得到幾個），
 * 直到 `releaseHeld()`（會先把 hold 關掉，之後的請求照常回應）。用來在「這一批一定還沒回來」的狀態下量畫面，不靠時間差。
 * 排隊中的請求還沒記進 seen.paths（放行、真的處理時才記）。
 */
export const gate = { hold: false, queue: [] };
export function releaseHeld() {
  gate.hold = false;
  for (const run of gate.queue.splice(0)) run();
}
const MORE_RE = /\/commits\?(?:.*&)?sha=[0-9a-f]{40}(?:&|$)/;

export function startMock() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      if (gate.hold && MORE_RE.test(req.url)) {
        gate.queue.push(() => handle(req, res));
        return;
      }
      if (latency.ms > 0 && !req.url.startsWith('/avatar/')) {
        setTimeout(() => handle(req, res), latency.ms);
        return;
      }
      handle(req, res);
    });
    function handle(req, res) {
      const url = new URL(req.url, 'http://x');
      const base = `http://127.0.0.1:${server.address().port}`;
      seen.paths.push(url.pathname + url.search);
      if (req.headers.authorization) seen.auth.push(req.headers.authorization);
      // 與 api.github.com 一致的 CORS：網頁（非 extension）呼叫時需要，且必須 expose rate limit 標頭
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, accept, x-github-api-version',
        'access-control-expose-headers':
          'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'access-control-max-age': '600' });
        return res.end();
      }
      const json = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cors, ...headers });
        res.end(JSON.stringify(body));
      };
      const p = url.pathname;
      if (p.startsWith('/avatar/')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
        return res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="14" fill="#ffa45e"/></svg>',
        );
      }
      if (p === '/rate_limit') {
        return json(200, {
          resources: {
            core: { limit: 60, remaining: 42, reset: Math.floor(Date.now() / 1000) + 600 },
          },
        });
      }
      if (p.startsWith('/repos/ghost/')) return json(404, { message: 'Not Found' });
      if (p.startsWith('/repos/limited/')) {
        return json(
          403,
          { message: 'rate limit' },
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1500),
          },
        );
      }
      const m = /^\/repos\/demo\/([^/]+)(\/.*)?$/.exec(p);
      const repo = m && REPOS.get(m[1]);
      if (!repo) return json(404, { message: 'Not Found' });
      switch (m[2]) {
        case undefined:
          return json(200, {
            name: repo.name,
            default_branch: 'main',
            html_url: `https://github.com/demo/${repo.name}`,
            owner: { login: 'demo' },
          });
        case '/branches':
          return json(
            200,
            Object.entries(repo.heads).map(([name, id]) => ({ name, commit: { sha: sha(id) } })),
          );
        case '/pulls':
          return json(200, []);
        case '/tags':
          return json(
            200,
            Object.entries(repo.tags).map(([name, id]) => ({ name, commit: { sha: sha(id) } })),
          );
        case '/commits': {
          const ref = url.searchParams.get('sha') ?? '';
          const isSha = /^[0-9a-f]{40}$/.test(ref);
          if (isSha && faults.more > 0) {
            faults.more--;
            return json(502, { message: 'Bad Gateway (injected)' });
          }
          const head = isSha
            ? repo.bySha.get(ref)
            : Object.hasOwn(repo.heads, ref)
              ? repo.heads[ref]
              : undefined;
          if (!head) return json(404, { message: `No commit found for SHA: ${ref}` });
          const per = Math.min(Number(url.searchParams.get('per_page') ?? 30) || 30, 100);
          return json(
            200,
            ancestors(repo, head)
              .slice(0, per)
              .map((c) => apiCommit(repo, c, base)),
          );
        }
        default:
          return json(404, { message: 'Not Found' });
      }
    }
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}
