import { Mascot } from '@adorable/graph-ui';

export function Fab({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="agg-fab" onClick={onClick} title={label} aria-label={label}>
      <Mascot size={40} />
      <span className="agg-fab-label">Git Graph</span>
    </button>
  );
}
