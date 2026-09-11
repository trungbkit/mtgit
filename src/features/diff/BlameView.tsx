import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { blameFile } from "../../ipc/commands";
import { langForPath, tokenizeLine, useHighlighter } from "./highlight";
import { Avatar } from "../../components/Avatar";
import { CommitHover } from "../../components/CommitHover";
import { useSettings } from "../../stores/settings";
import "./blame.css";

/**
 * Blame, with the two things G21 asks of it: an age heatmap in the gutter and
 * a rich hover per line.
 *
 * It is also where a line range is *chosen*. `-L` history (G22) needs a range
 * and blame is the only view where the user is already looking at specific
 * lines, so click and shift-click select here and hand the range up.
 */
export function BlameView({
  repoPath,
  oid,
  file,
  onLineRange,
}: {
  repoPath: string;
  /** Commit to blame at; null blames the working tree. */
  oid: string | null;
  file: string;
  /** Called with a 1-based inclusive range when the user asks for its history. */
  onLineRange?: (start: number, end: number) => void;
}) {
  const hl = useHighlighter();
  const lang = langForPath(file);
  const heatmap = useSettings((s) => s.settings.blameHeatmap);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["blame", repoPath, oid, file],
    queryFn: () => blameFile(repoPath, file, oid ?? undefined),
  });

  if (isLoading) return <div className="diff-note">Loading blame…</div>;
  if (error) return <div className="diff-note">{String(error)}</div>;
  if (!data || data.length === 0) return <div className="diff-note">No blame data.</div>;

  const range =
    anchor === null || focus === null
      ? null
      : ([Math.min(anchor, focus), Math.max(anchor, focus)] as const);

  function selectLine(lineNo: number, extend: boolean) {
    if (extend && anchor !== null) setFocus(lineNo);
    else {
      setAnchor(lineNo);
      setFocus(lineNo);
    }
  }

  return (
    <div className="blame-wrap">
      {range && onLineRange && (
        <div className="blame-selection">
          <span>
            Line{range[0] === range[1] ? "" : "s"} {range[0]}
            {range[0] === range[1] ? "" : `–${range[1]}`} selected
          </span>
          <button onClick={() => onLineRange(range[0], range[1])}>History of these lines</button>
          <button
            className="blame-selection-clear"
            onClick={() => {
              setAnchor(null);
              setFocus(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
      <div className="blame-code">
        {data.map((l, i) => {
          const prev = data[i - 1];
          const firstOfBlock = !prev || prev.oid !== l.oid;
          const selected = range !== null && l.lineNo >= range[0] && l.lineNo <= range[1];
          return (
            <div key={i} className={`blame-line${selected ? " selected" : ""}`}>
              <CommitHover
                repoPath={repoPath}
                oid={l.oid}
                className={`blame-meta${firstOfBlock ? " head" : ""}`}
              >
                {firstOfBlock ? (
                  <>
                    <Avatar email="" name={l.author} size={14} />
                    <span className="blame-author">{l.author}</span>
                    <span className="blame-oid">{l.oid.slice(0, 7)}</span>
                  </>
                ) : null}
              </CommitHover>
              {/* An empty element rather than a border on the number column:
                  the ramp has to be readable at a glance down the whole file,
                  and a 1px rule is not. */}
              <span
                className="blame-heat"
                aria-hidden="true"
                style={heatmap && l.oid ? { background: heatColor(l.age) } : undefined}
                title={heatmap && l.oid ? `Age bucket ${l.age} of 9` : undefined}
              />
              <button
                className="blame-no"
                onClick={(e) => selectLine(l.lineNo, e.shiftKey)}
                title="Click to select, shift-click to extend"
              >
                {l.lineNo}
              </button>
              <span className="blame-content">
                {tokenizeLine(hl, l.content, lang).map((t, j) => (
                  <span key={j} style={t.color ? { color: t.color } : undefined}>
                    {t.content}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Bucket 0–9 to a colour between the two theme tokens.
 *
 * `color-mix` rather than ten tokens: the ramp's endpoints are per-theme
 * (`--heat-cold` / `--heat-hot` in `theme.css`) and the ten steps between
 * them are arithmetic, not design decisions. Alpha stays low — this is a
 * gutter tint behind a line number, not a highlight.
 */
function heatColor(age: number): string {
  const pct = Math.round((Math.min(9, Math.max(0, age)) / 9) * 100);
  return `color-mix(in srgb, var(--heat-hot) ${pct}%, var(--heat-cold))`;
}
