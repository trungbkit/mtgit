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
}

export function laneColor(index: number): string {
  const palette = lanePalette();
  return palette[((index % palette.length) + palette.length) % palette.length];
}

/** Kept for callers that want the whole ring; prefer `lanePalette()`. */
export const LANE_PALETTE = FALLBACK;
