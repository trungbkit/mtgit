// Lane colour palette — 8 saturated hues, cycled by lane index. Shared between
// the canvas (edges/dots) and any DOM that needs to match a lane's colour.
//
// The values live in `theme.css` as `--lane-0` … `--lane-7` so a theme can
// retune them; they are read once and cached, because the canvas asks for a
// colour per edge per frame and `getComputedStyle` is a layout read. `refresh()`
// is what a theme change calls to drop that cache.

const LANE_COUNT = 8;

/** The dark-theme ring, used before the document is available (tests, SSR) and
 *  if a token is ever missing. Keeping a real fallback here means a typo'd
 *  token name shows a colour rather than an invisible edge. */
const FALLBACK = [
  "#e5534b", // red
  "#57ab5a", // green
  "#6cb6ff", // blue
  "#daaa3f", // yellow
  "#b083f0", // purple
  "#ec775c", // orange
  "#39c5cf", // teal
  "#e685b5", // pink
];

let cached: string[] | null = null;

function read(): string[] {
  if (typeof document === "undefined") return FALLBACK;
  const style = getComputedStyle(document.documentElement);
  return Array.from({ length: LANE_COUNT }, (_, i) => {
    const value = style.getPropertyValue(`--lane-${i}`).trim();
    return value || FALLBACK[i];
  });
}

/** The current lane ring. */
export function lanePalette(): string[] {
  if (!cached) cached = read();
  return cached;
}

/** Drop the cached ring; call after the theme changes. */
export function refreshLanePalette(): void {
  cached = null;
  tints = null;
}

export function laneColor(index: number): string {
  const palette = lanePalette();
  return palette[((index % palette.length) + palette.length) % palette.length];
}

/** Alpha for the selected-row band, as a two-digit hex suffix. */
const TINT_ALPHA = "2e";
let tints: Map<number, string> | null = null;

/**
 * The selected row's band, in its own lane's colour.
 *
 * One blue for every row said nothing about which line the row sits on; the
 * tint is what ties the band to the node and the edges drawn beside it.
 *
 * Cached like the ring above and dropped by the same `refresh`, because this is
 * read in `GraphRowView`'s render — once per visible row, on every hover.
 * The tokens are hex, so the alpha is a suffix rather than a `color-mix`: a
 * computed colour here would be a second place the theme is decided.
 */
export function laneTint(index: number): string {
  if (!tints) tints = new Map();
  const cachedTint = tints.get(index);
  if (cachedTint) return cachedTint;

  const base = laneColor(index);
  // Only `#rgb` and `#rrggbb` take the suffix. A token retuned to `oklch(...)`
  // or a named colour falls back to the theme's own selection band rather than
  // producing `oklch(...)2e`, which is not a colour at all.
  const tint = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(base)
    ? `${base}${TINT_ALPHA}`
    : "var(--bg-selected)";
  tints.set(index, tint);
  return tint;
}

/** Kept for callers that want the whole ring; prefer `lanePalette()`. */
export const LANE_PALETTE = FALLBACK;
