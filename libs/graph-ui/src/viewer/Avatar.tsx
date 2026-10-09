import { useState } from 'react';

export function Avatar({ url, name, size = 20 }: { url?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        className="agg-avatar"
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="agg-avatar agg-avatar--fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      {(Array.from((name || '').trim())[0] ?? '?').toLocaleUpperCase()}
    </span>
  );
}
