import { createRoot } from 'react-dom/client';
import { viewerCss } from '@adorable/graph-ui';
import { App } from './App';
import overlayCss from './styles.css?inline';

const HOST_ID = 'adorable-git-graph-host';

function mount() {
  if (document.getElementById(HOST_ID)) return;

  // 掛在 <html> 底下：GitHub(Turbo) 換頁時會整個替換 <body>。
  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const css = `${overlayCss}\n${viewerCss}`;
  try {
    // constructable stylesheet 不受頁面 CSP style-src 影響
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
  const app = document.createElement('div');
  shadow.append(app);

  // 避免 GitHub 的全域快捷鍵（g / t / s …）在 overlay 內被觸發
  for (const type of ['keydown', 'keyup', 'keypress'] as const) {
    host.addEventListener(type, (e) => {
      if ((e as KeyboardEvent).key !== 'Escape') e.stopPropagation();
    });
  }

  document.documentElement.append(host);
  createRoot(app).render(<App />);
}

mount();
