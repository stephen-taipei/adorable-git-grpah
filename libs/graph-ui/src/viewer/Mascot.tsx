import type { CSSProperties } from 'react';

export type MascotMood = 'happy' | 'sad' | 'sleepy';

const INK = '#2b2140';

/** 小球吉祥物（loading / error / logo 共用）。 */
export function Mascot({
  mood = 'happy',
  color = '#4fdc9a',
  size = 96,
  className,
  style,
}: {
  mood?: MascotMood;
  color?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="40" fill={color} stroke={INK} strokeWidth="6" />
      <ellipse
        cx="36"
        cy="30"
        rx="11"
        ry="7"
        fill="#fff"
        opacity="0.7"
        transform="rotate(-30 36 30)"
      />
      {mood === 'sleepy' ? (
        <g stroke={INK} strokeWidth="5" strokeLinecap="round" fill="none">
          <path d="M28 46 q7 6 14 0" />
          <path d="M58 46 q7 6 14 0" />
        </g>
      ) : (
        <g>
          <circle cx="36" cy="46" r="9" fill="#fff" stroke={INK} strokeWidth="3.5" />
          <circle cx="64" cy="46" r="9" fill="#fff" stroke={INK} strokeWidth="3.5" />
          <circle cx="37" cy="48" r="4.2" fill={INK} />
          <circle cx="63" cy="48" r="4.2" fill={INK} />
        </g>
      )}
      <ellipse cx="25" cy="62" rx="7" ry="4.5" fill="#ff6b94" opacity="0.5" />
      <ellipse cx="75" cy="62" rx="7" ry="4.5" fill="#ff6b94" opacity="0.5" />
      {mood === 'sad' ? (
        <path
          d="M38 74 q12 -12 24 0"
          fill="none"
          stroke={INK}
          strokeWidth="5"
          strokeLinecap="round"
        />
      ) : mood === 'sleepy' ? (
        <ellipse cx="50" cy="68" rx="6" ry="7" fill={INK} />
      ) : (
        <path
          d="M37 64 q13 14 26 0"
          fill="none"
          stroke={INK}
          strokeWidth="5"
          strokeLinecap="round"
        />
      )}
      {mood === 'sad' && (
        <path
          d="M72 58 q6 8 0 14 q-6 -6 0 -14z"
          fill="#8fdcff"
          stroke={INK}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
