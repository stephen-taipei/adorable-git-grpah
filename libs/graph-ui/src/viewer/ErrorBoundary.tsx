import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { detectLocale, getMessages } from '../i18n';
import { Mascot } from './Mascot';

interface Props {
  children: ReactNode;
  /** 自訂錯誤畫面；預設是卡通風的「哎呀」頁面。 */
  fallback?: (error: Error) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * 繪圖 / layout 在拿到壞資料時可能丟例外；沒有 boundary 的話整個 React 樹會卸載成白畫面。
 * 這裡改顯示友善的錯誤頁，並提供重新載入。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error);

    const t = getMessages(detectLocale());
    return (
      <div className="agg-root" data-theme="day" style={{ minHeight: 320 }}>
        <div className="agg-sky" />
        <div className="agg-center" role="alert">
          <Mascot size={92} mood="sad" color="#ff7a8a" className="agg-wobble" />
          <div className="agg-msg-title">{t.crashTitle}</div>
          <div className="agg-msg-sub">{t.crashSub}</div>
          <div className="agg-row">
            <button type="button" className="agg-cta" onClick={() => location.reload()}>
              {t.reload}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
