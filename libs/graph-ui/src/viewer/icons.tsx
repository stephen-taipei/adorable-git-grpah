import type { ReactNode } from 'react';

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const wrap = (children: ReactNode) => <svg {...base}>{children}</svg>;

export const PlayIcon = () => wrap(<path d="M7 4.5v15l12-7.5z" fill="currentColor" />);
export const FitIcon = () =>
  wrap(
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>,
  );
export const RefreshIcon = () =>
  wrap(
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v5h-5" />
    </>,
  );
export const GearIcon = () =>
  wrap(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
    </>,
  );
export const CloseIcon = () => wrap(<path d="M6 6l12 12M18 6L6 18" />);
