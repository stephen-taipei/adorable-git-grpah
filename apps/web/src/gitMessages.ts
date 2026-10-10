import type { GitAction, RepoStatus } from './protocol';
import { resultKind } from './git';
import type { ActionOutcome, Tone } from './git';
import { t } from './i18n';

/** 動作結果要顯示的訊息（動作列下方、或對話框裡的狀態列）。 */
export interface Notice {
  /** 每則訊息都是新的 id：同樣的文字再出現一次時，螢幕報讀器也會再唸一次 */
  id: number;
  tone: Tone;
  text: string;
  /** 整理過的 git 輸出（可展開） */
  output?: string;
  /** 進度（「正在 push…」）：結果回來後就換掉。`data-progress` 也輸出在 DOM 上（給 e2e / 樣式） */
  progress?: boolean;
}

let nextId = 1;

export const progressNotice = (action: GitAction): Notice => ({
  id: nextId++,
  tone: 'info',
  text: t.git.running[action.type] ?? '…',
  progress: true,
});

/**
 * `before`：執行前的狀態（push 的 upstream、worktree 的位置要用執行前的：執行後可能已經變了 / 不見了）。
 */
export function resultNotice(
  action: GitAction,
  result: ActionOutcome,
  before: RepoStatus | null,
): Notice {
  const kind = resultKind(action, result);
  const output = result.output.trim() || undefined;
  if (kind.tone === 'error') {
    const base =
      t.git.errorsFor[action.type]?.[kind.key] ?? t.git.errors[kind.key] ?? t.git.errors['failed']!;
    // 'invalid' 的原因在 output 裡（server 的說明，英文）：直接接在後面
    const text = kind.key === 'invalid' && output ? `${base}: ${output}` : base;
    return {
      id: nextId++,
      tone: 'error',
      text,
      output: kind.key === 'invalid' ? undefined : output,
    };
  }
  if (kind.tone === 'info') {
    return {
      id: nextId++,
      tone: 'info',
      text: t.git.nothing[action.type] ?? t.git.errors['nothing']!,
      output,
    };
  }
  return { id: nextId++, tone: 'ok', text: doneText(action, result, before), output };
}

function doneText(action: GitAction, result: ActionOutcome, before: RepoStatus | null): string {
  const d = t.git.done;
  switch (action.type) {
    case 'fetch':
      return d.fetch;
    case 'pull':
      return d.pull;
    case 'push': {
      const branch = before?.branch ?? 'HEAD';
      if (action.setUpstream)
        return d.pushSetUpstream(branch, `${action.setUpstream.remote}/${branch}`);
      return d.push(branch, before?.upstream ?? '');
    }
    case 'stash-save':
      return d.stashSave;
    case 'stash-apply':
      return d.stashApply(action.index);
    case 'stash-pop':
      return d.stashPop(action.index);
    case 'stash-drop':
      return d.stashDrop(action.index);
    case 'tag-create':
      return action.push ? d.tagCreatePushed(action.name) : d.tagCreate(action.name);
    case 'tag-delete':
      return d.tagDelete(action.name);
    case 'tag-push':
      return d.tagPush(action.name);
    case 'worktree-add':
      return d.worktreeAdd(result.repo?.label ?? action.path);
    case 'worktree-remove':
      return d.worktreeRemove(
        before?.worktrees.find((w) => w.id === action.id)?.label ?? action.id,
      );
  }
}
