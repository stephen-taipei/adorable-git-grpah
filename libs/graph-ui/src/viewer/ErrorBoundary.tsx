import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { detectLocale, getMessages } from '../i18n';
import { Mascot } from './Mascot';

interface Props {
  children: ReactNode;
  /** 自訂錯誤畫面；預設是卡通風的「哎呀」頁面。 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  /** 這個值一改變就自動清除錯誤、重新嘗試（例如資料更新後）。 */
  resetKey?: unknown;
  /** 預設錯誤頁多一個「關閉」按鈕（例如 extension 的 overlay）。 */
  onClose?: () => void;
  /** 預設錯誤頁多一個「重新載入頁面」按鈕。只適合獨立的 web app；extension 不可以（會連 GitHub 的分頁一起重載）。 */
  reloadable?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * 繪圖 / layout 在拿到壞資料時可能丟例外；沒有 boundary 的話整個 React 樹會卸載成白畫面。
 * 這裡改顯示友善的錯誤頁，並且可以就地重試（不必重載整個頁面）。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.reset();
  }

  private reset = () => this.setState({ error: null });

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const t = getMessages(detectLocale());
    return (
      <div className="agg-root" data-theme="day" tabIndex={-1} style={{ minHeight: 320 }}>
        <div className="agg-sky" />
        <div className="agg-center" role="alert">
          <Mascot size={92} mood="sad" color="#ff7a8a" className="agg-wobble" />
          <div className="agg-msg-title">{t.crashTitle}</div>
          <div className="agg-msg-sub">{t.crashSub}</div>
          <div className="agg-row">
            <button type="button" className="agg-cta" onClick={this.reset}>
              {t.retry}
            </button>
            {this.props.reloadable && (
              <button
                type="button"
                className="agg-cta agg-cta--ghost"
                onClick={() => location.reload()}
              >
                {t.reload}
              </button>
            )}
            {this.props.onClose && (
              <button type="button" className="agg-cta agg-cta--ghost" onClick={this.props.onClose}>
                {t.close}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
