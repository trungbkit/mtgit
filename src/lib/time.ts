/** Human-friendly relative time, e.g. "1 hour ago", "10 hours ago". */
export function timeAgo(unixSeconds: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = secs;
  let unit = "second";
  for (const [step, name] of units) {
    if (value < step) {
      unit = name;
      break;
    }
    value = Math.floor(value / step);
    unit = name;
  }
  if (unit === "second" && value < 45) return "just now";
  const rounded = Math.max(1, Math.round(value));
  return `${rounded} ${unit}${rounded === 1 ? "" : "s"} ago`;
}

/** Absolute local timestamp, e.g. "07/13/2026 @ 4:33 PM". */
export function formatTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} @ ${time}`;
}
