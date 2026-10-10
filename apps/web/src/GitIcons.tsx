import type { ReactNode } from 'react';

/** git 動作列的圖示：與 viewer 的圖示同一種畫法（24×24、圓頭粗線、currentColor）。 */
const wrap = (children: ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const FetchIcon = () =>
  wrap(
    <>
      <path d="M4 14.5v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5" />
      <path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" />
    </>,
  );

export const PullIcon = () =>
  wrap(
    <>
      <circle cx="12" cy="18.5" r="2.5" />
      <path d="M12 3v10M7.5 8.5 12 13l4.5-4.5" />
    </>,
  );

export const PushIcon = () =>
  wrap(
    <>
      <circle cx="12" cy="5.5" r="2.5" />
      <path d="M12 21V11M7.5 15.5 12 11l4.5 4.5" />
    </>,
  );

export const StashIcon = () =>
  wrap(
    <>
      <path d="M3.5 4.5h17v4h-17z" />
      <path d="M5 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-10M10 12.5h4" />
    </>,
  );

export const TagIcon = () =>
  wrap(
    <>
      <path d="M3.5 12.2V4.6a1 1 0 0 1 1-1h7.6l8.4 8.4a1.5 1.5 0 0 1 0 2.1l-6.3 6.3a1.5 1.5 0 0 1-2.1 0z" />
      <circle cx="8.2" cy="8.2" r="1.3" />
    </>,
  );

export const WorktreeIcon = () =>
  wrap(
    <>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
      <path d="M9.5 17.5v-6M9.5 14.5c3 0 5-.6 5-3" />
    </>,
  );

export const BranchIcon = () =>
  wrap(
    <>
      <circle cx="6.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="18.5" r="2.2" />
      <circle cx="17.5" cy="7.5" r="2.2" />
      <path d="M6.5 7.7v8.6M17.5 9.7c0 4.3-5 4.3-10.2 6.6" />
    </>,
  );

export const SpinnerIcon = () => (
  <svg
    className="web-spin"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M20 12a8 8 0 1 1-8-8" />
  </svg>
);

export const ICONS = {
  fetch: FetchIcon,
  pull: PullIcon,
  push: PushIcon,
  stash: StashIcon,
  tag: TagIcon,
  worktree: WorktreeIcon,
} as const;
