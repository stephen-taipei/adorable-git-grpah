import type { CommitInput, GraphData, RefInput } from './types';

/** 決定性假 sha（FNV-1a ×5 → 40 hex），僅供 demo / 測試。 */
function fakeSha(id: string): string {
  let out = '';
  for (let round = 0; round < 5; round++) {
    let h = 0x811c9dc5 ^ (round * 0x9e3779b1);
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

interface Spec {
  id: string;
  parents: string[];
  msg: string;
  author: string;
  /** 相對第 0 天的小時數 */
  hour: number;
}

const SPECS: Spec[] = [
  { id: 'm1', parents: [], msg: 'chore: initial commit', author: 'amy', hour: 0 },
  { id: 'm2', parents: ['m1'], msg: 'chore: scaffold nx workspace', author: 'amy', hour: 10 },
  { id: 'm3', parents: ['m2'], msg: 'feat: git graph lane layout', author: 'amy', hour: 20 },
  { id: 'f1', parents: ['m3'], msg: 'feat: toon shaded commit balls', author: 'ben', hour: 28 },
  { id: 'f2', parents: ['f1'], msg: 'feat: animated flow ribbons', author: 'ben', hour: 34 },
  { id: 'm4', parents: ['m3'], msg: 'docs: write readme', author: 'amy', hour: 36 },
  { id: 'f3', parents: ['f2'], msg: 'fix: outline z-fighting', author: 'ben', hour: 44 },
  { id: 'm5', parents: ['m4'], msg: 'feat: github api client', author: 'amy', hour: 50 },
  { id: 'x1', parents: ['m5'], msg: 'fix: handle rate limit 403', author: 'cat', hour: 56 },
  {
    id: 'm6',
    parents: ['m5', 'f3'],
    msg: "Merge branch 'feat/three-scene'",
    author: 'amy',
    hour: 62,
  },
  { id: 'x2', parents: ['x1'], msg: 'test: rate limit cases', author: 'cat', hour: 66 },
  {
    id: 'm7',
    parents: ['m6', 'x2'],
    msg: 'Merge pull request #3 from fix/rate-limit',
    author: 'amy',
    hour: 72,
  },
  { id: 'm8', parents: ['m7'], msg: 'feat: chrome extension shell', author: 'amy', hour: 80 },
  { id: 'y1', parents: ['m8'], msg: 'feat: night theme', author: 'cat', hour: 86 },
  { id: 'm9', parents: ['m8'], msg: 'chore: add icons', author: 'amy', hour: 90 },
  { id: 'y2', parents: ['y1'], msg: 'feat: twinkling stars', author: 'cat', hour: 96 },
  { id: 'm10', parents: ['m9'], msg: 'feat: replay animation', author: 'amy', hour: 100 },
  { id: 'r1', parents: ['m10'], msg: 'chore: bump version 0.1.0', author: 'ben', hour: 104 },
  { id: 'r2', parents: ['r1'], msg: 'fix: manifest permissions', author: 'ben', hour: 108 },
  { id: 'm11', parents: ['m10'], msg: 'feat: branch legend', author: 'amy', hour: 110 },
  { id: 'm12', parents: ['m11'], msg: 'Revert "feat: branch legend"', author: 'amy', hour: 114 },
  { id: 'm13', parents: ['m12'], msg: 'docs: usage gif', author: 'amy', hour: 120 },
];

export function createDemoData(): GraphData {
  const owner = 'demo';
  const name = 'adorable-git-graph';
  const t0 = Date.UTC(2026, 0, 1);
  const commits: CommitInput[] = SPECS.map((s) => ({
    sha: fakeSha(s.id),
    parents: s.parents.map(fakeSha),
    message: s.msg,
    authorName: s.author,
    authorLogin: s.author,
    date: new Date(t0 + s.hour * 3600_000).toISOString(),
    url: `https://github.com/${owner}/${name}/commit/${fakeSha(s.id)}`,
  }));
  const refs: RefInput[] = [
    { name: 'main', sha: fakeSha('m13'), kind: 'branch', isDefault: true },
    { name: 'feat/dark-mode', sha: fakeSha('y2'), kind: 'branch' },
    { name: 'release/v0.1', sha: fakeSha('r2'), kind: 'branch' },
    { name: 'v0.1.0', sha: fakeSha('r2'), kind: 'tag' },
    { name: 'v0.0.1', sha: fakeSha('m3'), kind: 'tag' },
  ];
  return {
    repo: { owner, name, defaultBranch: 'main', url: `https://github.com/${owner}/${name}` },
    commits,
    refs,
    truncated: false,
    fetchedAt: t0,
  };
}
