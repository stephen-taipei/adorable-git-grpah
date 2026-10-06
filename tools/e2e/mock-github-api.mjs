// e2e 共用：假的 GitHub REST API（只實作 graph-core 的 fetchGitHubGraph 會用到的端點）。
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
const byId = new Map(
  SPECS.map((s) => [s[0], { id: s[0], parents: s[1], msg: s[2], author: s[3], at: T0 + s[4] * H }]),
);
const HEADS = { main: 'm13', 'feat/dark-mode': 'y2', 'release/v0.1': 'r2', 'a-old': 'm1' };

const ancestors = (id) => {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    byId.get(cur).parents.forEach((p) => stack.push(p));
  }
  return [...seen].map((i) => byId.get(i)).sort((a, b) => b.at - a.at);
};

const apiCommit = (c, base) => ({
  sha: sha(c.id),
  html_url: `https://github.com/demo/adorable-git-graph/commit/${sha(c.id)}`,
  parents: c.parents.map((p) => ({ sha: sha(p) })),
  commit: {
    message: c.msg,
    author: { name: c.author, date: new Date(c.at).toISOString() },
    committer: { name: c.author, date: new Date(c.at).toISOString() },
  },
  author: { login: c.author, avatar_url: `${base}/avatar/${c.author}.svg` },
});

export const seen = { auth: [], paths: [] };

export function startMock() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
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
      const m = /^\/repos\/demo\/adorable-git-graph(\/.*)?$/.exec(p);
      if (!m) return json(404, { message: 'Not Found' });
      switch (m[1]) {
        case undefined:
          return json(200, {
            name: 'adorable-git-graph',
            default_branch: 'main',
            html_url: 'https://github.com/demo/adorable-git-graph',
            owner: { login: 'demo' },
          });
        case '/branches':
          return json(
            200,
            Object.entries(HEADS).map(([name, id]) => ({ name, commit: { sha: sha(id) } })),
          );
        case '/pulls':
          return json(200, []);
        case '/tags':
          return json(200, [
            { name: 'v0.1.0', commit: { sha: sha('r2') } },
            { name: 'v0.0.1', commit: { sha: sha('m3') } },
          ]);
        case '/commits': {
          const head = HEADS[url.searchParams.get('sha')];
          if (!head) return json(404, { message: 'No commit found' });
          const per = Number(url.searchParams.get('per_page') ?? 30);
          return json(
            200,
            ancestors(head)
              .slice(0, per)
              .map((c) => apiCommit(c, base)),
          );
        }
        default:
          return json(404, { message: 'Not Found' });
      }
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}
