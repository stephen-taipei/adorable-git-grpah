import type { CommitInput, GraphData, RefInput } from './types.ts';

/**
 * 本機 `git` 輸出 → GraphData 的純函式（不碰 IO，方便測試；實際執行 git 的是使用端）。
 *
 *   git for-each-ref --sort=-committerdate --format=<REF_FORMAT> refs/heads refs/remotes refs/tags
 *   git log --date-order --format=<LOG_FORMAT> -n <N> <selected refs…>
 */

/**
 * git は commit メッセージ / ident に NUL を含めることを許さないので、`git log -z` の NUL を
 * レコードとフィールドの区切りに使う（0x1e/0x1f などは本文に入り得るので区切りにできない）。
 */
const NUL = '\0';
const FIELDS = 5;

/**
 * 必ず `git log -z --format=GIT_LOG_FORMAT` で使うこと。
 * メッセージは `%s`（1 行目）のみ：本文には Signed-off-by / Co-authored-by の email が入りがちで、
 * 画面にも出さないので、バンドルや dev endpoint に載せない。email 自体も取得しない。
 */
export const GIT_LOG_FORMAT = '%H%x00%P%x00%an%x00%cI%x00%s';
/** refname / objectname / peeled objectname（annotated tag 才有）以 TAB 分隔。 */
export const GIT_REF_FORMAT = '%(refname)%09%(objectname)%09%(*objectname)';

export interface ParsedRef {
  kind: 'branch' | 'tag';
  /** 完整 ref：refs/heads/x、refs/remotes/origin/x、refs/tags/x */
  fullName: string;
  /** 顯示名稱：x、origin/x、x */
  name: string;
  remote?: string;
  sha: string;
}

export interface GitHubRemote {
  owner: string;
  repo: string;
}

export function parseForEachRef(text: string): ParsedRef[] {
  const out: ParsedRef[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [fullName = '', objectName = '', peeled = ''] = line.split('\t');
    const sha = (peeled || objectName).trim();
    if (!fullName || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    if (fullName.startsWith('refs/heads/')) {
      out.push({ kind: 'branch', fullName, name: fullName.slice('refs/heads/'.length), sha });
    } else if (fullName.startsWith('refs/remotes/')) {
      const rest = fullName.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const remote = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (name === 'HEAD') continue; // origin/HEAD 只是別名
      out.push({ kind: 'branch', fullName, name: `${remote}/${name}`, remote, sha });
    } else if (fullName.startsWith('refs/tags/')) {
      out.push({ kind: 'tag', fullName, name: fullName.slice('refs/tags/'.length), sha });
    }
  }
  return out;
}

/** 只認 github.com；一律丟掉帳密 / token，只回傳 owner 與 repo。 */
export function parseGitHubRemote(url: string | undefined): GitHubRemote | null {
  if (!url) return null;
  const u = url.trim();
  const m =
    /^(?:git@|ssh:\/\/git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^(?:https?|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export interface SelectRefsOptions {
  /** 明確指定 default branch（優先於一切推測）。 */
  defaultBranch?: string;
  /** `git symbolic-ref --short refs/remotes/origin/HEAD` 的輸出，例如 `origin/main`。 */
  originHead?: string;
  /** 目前 checkout 的 branch（`git branch --show-current`）。 */
  currentBranch?: string;
  /** 最多納入幾條 branch（含 default）。預設 8。 */
  maxBranches?: number;
}

export interface SelectedRefs {
  /** 用來跑 `git log` 的 ref（完整名稱）。 */
  logRefs: string[];
  /** 之後轉成 GraphData.refs 的資料（已套用顯示名稱與 isDefault）。 */
  refs: RefInput[];
  defaultBranch?: string;
}

/**
 * 從所有 ref 中挑出要畫的：default → 目前 branch → 其餘（沿用輸入順序，建議以 committerdate 排序）。
 * 本機與 remote 同名且指向同一 commit 時只留本機；只存在於 remote 的 default 會以去掉 remote 前綴的名稱顯示。
 */
const bare = (r: ParsedRef): string => (r.remote ? r.name.slice(r.remote.length + 1) : r.name);

export function selectRefs(all: readonly ParsedRef[], opts: SelectRefsOptions = {}): SelectedRefs {
  const branches = all.filter((r) => r.kind === 'branch');
  const local = new Map(branches.filter((b) => !b.remote).map((b) => [b.name, b]));

  const candidates = branches.filter((b) => {
    if (!b.remote) return true;
    const twin = local.get(b.name.slice(b.remote.length + 1));
    return !twin || twin.sha !== b.sha;
  });

  const find = (name: string | undefined): ParsedRef | undefined => {
    if (!name) return undefined;
    const bare = name.replace(/^refs\/(heads|remotes)\//, '');
    return (
      candidates.find((b) => b.name === bare) ??
      // `main` 沒有本機 branch 時，退而求其次用 origin/main
      candidates.find((b) => b.remote && b.name.slice(b.remote.length + 1) === bare) ??
      branches.find((b) => b.name === bare)
    );
  };

  const originHeadName = opts.originHead
    ?.replace(/^refs\/remotes\/[^/]+\//, '')
    .replace(/^[^/]+\//, '');
  const def =
    find(opts.defaultBranch) ??
    find(originHeadName) ??
    find('main') ??
    find('master') ??
    find(opts.currentBranch) ??
    candidates[0];

  // `origin/main` を default に指定されても、同じ commit を指す本機 `main` があればそちらを使う（同名が 2 本並ばないように）
  const twinOf = (r: ParsedRef | undefined): ParsedRef | undefined => {
    if (!r?.remote) return r;
    const twin = local.get(r.name.slice(r.remote.length + 1));
    return twin && twin.sha === r.sha ? twin : r;
  };
  const picked: ParsedRef[] = [];
  const add = (r: ParsedRef | undefined) => {
    const ref = twinOf(r);
    if (ref && !picked.includes(ref)) picked.push(ref);
  };
  add(def);
  add(find(opts.currentBranch));
  for (const b of candidates) add(b);
  const limited = picked.slice(0, Math.max(1, opts.maxBranches ?? 8));

  const defRef = twinOf(def);
  const refs: RefInput[] = limited.map((b) => {
    const isDefault = b === defRef;
    // 只靠 remote 才有的 default 以去掉前綴的名稱顯示；但若有另一個（指向不同 commit 的）同名 branch 也被選中，保留前綴以免兩個都叫 main
    const stripped =
      isDefault &&
      b.remote &&
      !limited.some((o) => o !== b && o.kind === 'branch' && bare(o) === bare(b) && !o.remote);
    return {
      name: stripped ? bare(b) : b.name,
      sha: b.sha,
      kind: 'branch' as const,
      isDefault,
    };
  });
  return {
    logRefs: limited.map((b) => b.fullName),
    refs,
    defaultBranch: def
      ? def.remote
        ? def.name.slice(def.remote.length + 1)
        : def.name
      : undefined,
  };
}

export function parseGitLog(
  text: string,
  commitUrl?: (sha: string) => string | undefined,
): CommitInput[] {
  const out: CommitInput[] = [];
  const parts = text.split(NUL);
  // NUL を含み得ないフィールドを FIELDS 個ずつ。先頭が sha でなければ 1 つ読み飛ばして同期を取り直す。
  for (let i = 0; i + FIELDS <= parts.length;) {
    const sha = (parts[i] ?? '').replace(/^\n+/, '');
    if (!/^[0-9a-f]{40,64}$/.test(sha)) {
      i++;
      continue;
    }
    const [, parents = '', author = '', date = '', message = ''] = parts.slice(i, i + FIELDS);
    out.push({
      sha,
      parents: parents.split(' ').filter(Boolean),
      authorName: author,
      date,
      message: message.replace(/\s+$/, ''),
      url: commitUrl?.(sha),
    });
    i += FIELDS;
  }
  return out;
}

export interface BuildGitGraphInput {
  logText: string;
  /** `selectRefs()` 的結果 */
  selected: SelectedRefs;
  allRefs: readonly ParsedRef[];
  remoteUrl?: string;
  /** remote 不是 GitHub 時顯示用的名稱（通常是資料夾名）。 */
  fallbackName: string;
}

export function buildGitGraphData(input: BuildGitGraphInput): GraphData {
  const remote = parseGitHubRemote(input.remoteUrl);
  const base = remote ? `https://github.com/${remote.owner}/${remote.repo}` : undefined;
  // 呼叫端可能把多段 `git log` 輸出串在一起（重疊的部分以 sha 去重）
  const commits = [
    ...new Map(
      parseGitLog(input.logText, base ? (sha) => `${base}/commit/${sha}` : undefined).map((c) => [
        c.sha,
        c,
      ]),
    ).values(),
  ];
  const known = new Set(commits.map((c) => c.sha));

  const refs: RefInput[] = input.selected.refs.filter((r) => known.has(r.sha));
  for (const t of input.allRefs) {
    if (t.kind === 'tag' && known.has(t.sha)) refs.push({ name: t.name, sha: t.sha, kind: 'tag' });
  }

  const truncated = commits.some((c) => c.parents.some((p) => !known.has(p)));
  return {
    repo: {
      owner: remote?.owner ?? 'local',
      name: remote?.repo ?? input.fallbackName,
      defaultBranch: input.selected.defaultBranch ?? 'main',
      url: base,
    },
    commits,
    refs,
    truncated,
    fetchedAt: Date.now(),
  };
}
