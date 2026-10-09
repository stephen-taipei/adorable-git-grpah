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
export const TopIcon = () =>
  wrap(
    <>
      <path d="M5 4h14" />
      <path d="M12 20V9M7 13l5-5 5 5" />
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

export const SearchIcon = () =>
  wrap(
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>,
  );
export const CopyIcon = () =>
  wrap(
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
      <path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" />
    </>,
  );
export const CheckIcon = () => wrap(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const ExternalIcon = () =>
  wrap(
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>,
  );
export const ChevronUpIcon = () => wrap(<path d="M6 15l6-6 6 6" />);
export const ChevronDownIcon = () => wrap(<path d="M6 9l6 6 6-6" />);
export const CloudIcon = () =>
  wrap(<path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.8 4.6 4.6 0 0 1 17 18z" />);
export const TagIcon = () =>
  wrap(
    <>
      <path d="M4 12.2V5a1 1 0 0 1 1-1h7.2a1 1 0 0 1 .7.3l7.2 7.2a1 1 0 0 1 0 1.4l-6.7 6.7a1 1 0 0 1-1.4 0L4.3 12.9a1 1 0 0 1-.3-.7z" />
      <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" />
    </>,
  );
export const MergeIcon = () =>
  wrap(
    <>
      <circle cx="6" cy="5.5" r="2.2" />
      <circle cx="6" cy="18.5" r="2.2" />
      <circle cx="18" cy="14" r="2.2" />
      <path d="M6 7.7v8.6M18 11.8C18 8 12 9.5 7.8 6.4" />
    </>,
  );
