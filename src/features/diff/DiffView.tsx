import { useMemo } from "react";
import type { DiffLine, FileDiff } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { langForPath, tokenizeLine, useHighlighter } from "./highlight";
import type { Highlighter } from "shiki";
import "./diff.css";

const MAX_HIGHLIGHT_LINES = 2000;

export function DiffView({ diff }: { diff: FileDiff }) {
  const mode = useSession((s) => s.diffMode);
  const setMode = useSession((s) => s.setDiffMode);
  const hl = useHighlighter();
  const lang = langForPath(diff.path);

  const totalLines = useMemo(
    () => diff.hunks.reduce((n, h) => n + h.lines.length, 0),
    [diff],
  );
  const canHighlight = totalLines <= MAX_HIGHLIGHT_LINES ? hl : null;

  if (diff.binary) {
    return <div className="diff-note">Binary file — no textual diff.</div>;
  }
  if (diff.isLarge) {
    return <div className="diff-note">File too large to display inline.</div>;
  }
  if (diff.hunks.length === 0) {
    return <div className="diff-note">No changes to display (mode/rename only).</div>;
  }

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="diff-path">{diff.path}</span>
        <span className="diff-stat add">+{diff.additions}</span>
        <span className="diff-stat del">−{diff.deletions}</span>
        <div className="diff-mode-toggle">
          <button className={mode === "inline" ? "on" : ""} onClick={() => setMode("inline")}>
            Inline
          </button>
          <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}>
            Split
          </button>
        </div>
      </div>
      {mode === "inline" ? (
        <InlineDiff diff={diff} hl={canHighlight} lang={lang} />
      ) : (
        <SplitDiff diff={diff} hl={canHighlight} lang={lang} />
      )}
    </div>
  );
}

function Code({ text, hl, lang }: { text: string; hl: Highlighter | null; lang: string | null }) {
  const toks = tokenizeLine(hl, text, lang);
  return (
    <>
      {toks.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </>
  );
}

function InlineDiff({ diff, hl, lang }: { diff: FileDiff; hl: Highlighter | null; lang: string | null }) {
  return (
    <div className="diff-code">
      {diff.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="hunk-header">{h.header}</div>
          {h.lines.map((l, li) => (
            <div key={li} className={`dline ${l.kind}`}>
              <span className="gutter">{l.oldNo ?? ""}</span>
              <span className="gutter">{l.newNo ?? ""}</span>
              <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span className="content">
                <Code text={l.text} hl={hl} lang={lang} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Split view: pair del/add lines side by side within each hunk. */
function SplitDiff({ diff, hl, lang }: { diff: FileDiff; hl: Highlighter | null; lang: string | null }) {
  return (
    <div className="diff-code split">
      {diff.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="hunk-header">{h.header}</div>
          {pairLines(h.lines).map((pair, pi) => (
            <div key={pi} className="split-row">
              <Side line={pair.left} side="left" hl={hl} lang={lang} />
              <Side line={pair.right} side="right" hl={hl} lang={lang} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Side({
  line,
  side,
  hl,
  lang,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  hl: Highlighter | null;
  lang: string | null;
}) {
  if (!line) return <div className="dline empty" />;
  const no = side === "left" ? line.oldNo : line.newNo;
  return (
    <div className={`dline ${line.kind}`}>
      <span className="gutter">{no ?? ""}</span>
      <span className="content">
        <Code text={line.text} hl={hl} lang={lang} />
      </span>
    </div>
  );
}

interface Pair {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Turn a flat hunk line list into left/right pairs for split view. */
function pairLines(lines: DiffLine[]): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "context") {
      pairs.push({ left: l, right: l });
      i++;
    } else {
      // Gather a run of dels then adds and zip them.
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        pairs.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      }
    }
  }
  return pairs;
}
