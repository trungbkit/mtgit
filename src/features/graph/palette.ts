// Lane color palette — ~8 saturated hues, cycled by lane index. Shared between
// the canvas (edges/dots) and any DOM that needs to match a lane's color.
export const LANE_PALETTE = [
  "#e5534b", // red
  "#57ab5a", // green
  "#6cb6ff", // blue
  "#daaa3f", // yellow
  "#b083f0", // purple
  "#ec775c", // orange
  "#39c5cf", // teal
  "#e685b5", // pink
];

export function laneColor(index: number): string {
  return LANE_PALETTE[((index % LANE_PALETTE.length) + LANE_PALETTE.length) % LANE_PALETTE.length];
}
