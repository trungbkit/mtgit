/**
 * The app's icon set.
 *
 * These replace the emoji that used to stand in for icons. Emoji were the
 * loudest tell that this is not a native app: they render at a different
 * weight, size and colour on every platform, they ignore `currentColor` so
 * they cannot follow a theme, and several of them (🖥 for "local branches",
 * ≡ for "stashes") were standing in for a meaning they do not carry.
 *
 * One shape per line, stroked in `currentColor` at a single weight, on a 16×16
 * grid — so an icon inherits the colour of whatever it sits in, including the
 * accent fill of a selected row, and gets the light theme for free.
 */

export type IconName =
  | "branch"
  | "cloud"
  | "tag"
  | "worktree"
  | "stash"
  | "stash-save"
  | "stash-pop"
  | "check"
  | "pencil"
  | "pending"
  | "eye"
  | "eye-off"
  | "refresh"
  | "undo"
  | "redo"
  | "pull"
  | "push"
  | "terminal"
  | "gear"
  | "search"
  | "layout"
  | "commit"
  | "plus"
  | "close"
  | "person";

/** Path data only; the shared `<svg>` supplies stroke, size and join style. */
const PATHS: Record<IconName, React.ReactNode> = {
  branch: (
    <>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="5.5" r="1.6" />
      <path d="M4 5.1v5.8" />
      <path d="M12 7.1c0 2.2-1.6 3.6-3.8 3.6H4" />
    </>
  ),
  cloud: <path d="M4.6 12.5a3 3 0 0 1 .2-6 4.2 4.2 0 0 1 7.9 1.2 2.6 2.6 0 0 1-.6 4.8z" />,
  tag: (
    <>
      <path d="M2.5 7.7V3.3a.8.8 0 0 1 .8-.8h4.4a1 1 0 0 1 .7.3l5.1 5.1a1 1 0 0 1 0 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L2.8 8.4a1 1 0 0 1-.3-.7z" />
      <circle cx="5.4" cy="5.4" r="1" />
    </>
  ),
  worktree: (
    <>
      <path d="M2 12.8V4.2a.8.8 0 0 1 .8-.8h3.1l1.3 1.7h6a.8.8 0 0 1 .8.8v6.9a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8z" />
      <path d="M8 7.6v4" />
      <circle cx="8" cy="11.9" r="1.1" />
    </>
  ),
  stash: (
    <>
      <path d="M8 2.3 14.2 5.7 8 9.1 1.8 5.7z" />
      <path d="m2.4 9 5.6 3.1L13.6 9" />
    </>
  ),
  // Stash save and pop share the stack and differ only in arrow direction,
  // which is the whole distinction the two toolbar buttons carry.
  "stash-save": (
    <>
      <path d="M2.2 11.2 8 14.1l5.8-2.9" />
      <path d="M8 1.9v6.4" />
      <path d="m5.4 5.9 2.6 2.6 2.6-2.6" />
    </>
  ),
  "stash-pop": (
    <>
      <path d="M2.2 11.2 8 14.1l5.8-2.9" />
      <path d="M8 8.3V1.9" />
      <path d="m5.4 4.5 2.6-2.6 2.6 2.6" />
    </>
  ),
  check: <path d="m3 8.4 3.6 3.6L13 4.4" />,
  pencil: (
    <>
      <path d="m11.2 2.3 2.5 2.5-8.2 8.2-3.2.7.7-3.2z" />
      <path d="m9.6 3.9 2.5 2.5" />
    </>
  ),
  // Deliberately dashed: it is the "in flight" marker, and the dashes are the
  // same visual language as the WIP row's hollow node.
  pending: <circle cx="8" cy="8" r="5.4" strokeDasharray="2.2 2.2" />,
  eye: (
    <>
      <path d="M1.4 8S4.1 3.8 8 3.8 14.6 8 14.6 8 11.9 12.2 8 12.2 1.4 8 1.4 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M1.4 8S4.1 3.8 8 3.8 14.6 8 14.6 8 11.9 12.2 8 12.2 1.4 8 1.4 8z" />
      <circle cx="8" cy="8" r="1.9" />
      <path d="m2.6 2.6 10.8 10.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.4 8a5.4 5.4 0 1 1-1.8-4" />
      <path d="M13.6 2.2v3.6H10" />
    </>
  ),
  undo: (
    <>
      <path d="M5.8 4.3 2.4 7.6l3.4 3.3" />
      <path d="M2.7 7.6h6.6a3.6 3.6 0 0 1 0 7.2" />
    </>
  ),
  redo: (
    <>
      <path d="m10.2 4.3 3.4 3.3-3.4 3.3" />
      <path d="M13.3 7.6H6.7a3.6 3.6 0 0 0 0 7.2" />
    </>
  ),
  pull: (
    <>
      <path d="M8 2.4v7.8" />
      <path d="m4.6 6.9 3.4 3.4 3.4-3.4" />
      <path d="M2.6 13.4h10.8" />
    </>
  ),
  push: (
    <>
      <path d="M8 13.6V5.8" />
      <path d="M4.6 9.1 8 5.7l3.4 3.4" />
      <path d="M2.6 2.6h10.8" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.4" />
      <path d="m4.6 6.1 2.3 2.3-2.3 2.3" />
      <path d="M8.6 10.7h3.1" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.6" />
      <path d="m10.4 10.4 3.4 3.4" />
    </>
  ),
  layout: (
    <>
      <rect x="1.6" y="3.1" width="12.8" height="9.8" rx="1.2" />
      <path d="M6 3.1v9.8" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M1.6 8h3.8M10.6 8h3.8" />
    </>
  ),
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  close: <path d="m3.6 3.6 8.8 8.8M12.4 3.6l-8.8 8.8" />,
  person: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M3.2 13.2a4.8 4.8 0 0 1 9.6 0" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  /** Pixel size; the stroke stays visually constant because the grid scales. */
  size?: number;
  className?: string;
  /** Fills the shape as well as stroking it — used for a selected lane node. */
  filled?: boolean;
}

export function Icon({ name, size = 14, className, filled }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Icons here are always beside their own label, so they are decoration.
      // A duplicate name read out after the label is noise, not help.
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
