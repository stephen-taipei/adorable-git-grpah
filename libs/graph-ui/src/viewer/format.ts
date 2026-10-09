import type { Locale } from '../i18n';

/** 「9 Oct 2026, 02:00」這種絕對時間（使用者的語系與時區）。 */
export function formatAbsolute(iso: string, locale: Locale): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(ms);
}

export interface ParsedSubject {
  /** conventional commit 的類型（feat / fix / …），沒有就是 undefined */
  type?: string;
  scope?: string;
  breaking?: boolean;
  /** 去掉 `type(scope)!:` 前綴的其餘文字 */
  rest: string;
}

const CONVENTIONAL =
  /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(?:\(([^)]*)\))?(!)?:\s+/i;

/** 把 `feat(core)!: add x` 拆成 type / scope / rest，列表上讓類型變成小標籤。 */
export function parseSubject(subject: string): ParsedSubject {
  const m = CONVENTIONAL.exec(subject);
  if (!m) return { rest: subject };
  return {
    type: m[1]!.toLowerCase(),
    scope: m[2] || undefined,
    breaking: Boolean(m[3]),
    rest: subject.slice(m[0].length),
  };
}

/**
 * 複製文字：先用 Clipboard API；被拒絕（例如 content script 沒有使用者手勢、或頁面的 permissions policy 擋掉）時
 * 退回暫時的 textarea + execCommand。兩者都失敗回傳 false。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 改用 fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
