import { useMemo } from "react";
import type { DiffLine, FileDiff } from "../../ipc/types";
import type { DiffMode } from "../../stores/session";
import { langForPath, tokenizeLine, useHighlighter } from "./highlight";
import { wordDiff, type WordTok } from "./wordDiff";
import type { Highlighter } from "shiki";
import "./diff.css";

const MAX_HIGHLIGHT_LINES = 2000;

type RLine = DiffLine & { words?: WordTok[] };

/** Attach intra-line word diffs to del/add lines that pair up within a run. */
function enrich(lines: DiffLine[]): RLine[] {
  const out: RLine[] = lines.map((l) => ({ ...l }));
  let i = 0;
  while (i < out.length) {
    if (out[i].kind === "del") {
      let d = i;
      while (d < out.length && out[d].kind === "del") d++;
      let a = d;
      while (a < out.length && out[a].kind === "add") a++;
      const nPairs = Math.min(d - i, a - d);
      for (let k = 0; k < nPairs; k++) {
        const del = out[i + k];
        const add = out[d + k];
        const wd = wordDiff(del.text, add.text);
        del.words = wd.left;
        add.words = wd.right;
      }
      i = a;
    } else {
      i++;
    }
  }
  return out;
}

export function DiffView({ diff, mode }: { diff: FileDiff; mode: DiffMode }) {
  const hl = useHighlighter();
  const lang = langForPath(diff.path);

  const totalLines = useMemo(() => diff.hunks.reduce((n, h) => n + h.lines.length, 0), [diff]);
  const canHighlight = totalLines <= MAX_HIGHLIGHT_LINES ? hl : null;

  const enriched = useMemo(
    () => diff.hunks.map((h) => ({ header: h.header, lines: enrich(h.lines) })),
    [diff],
  );

  if (diff.binary) {
    return <div className="diff-note">Binary file — no textual diff.</div>;
  }
  if (diff.isLarge) {
    return <div className="diff-note">File too large to display inline.</div>;
  }
  if (diff.hunks.length === 0) {
    return <div className="diff-note">No changes to display (mode/rename only).</div>;
  }

  return mode === "inline" ? (
    <InlineDiff hunks={enriched} hl={canHighlight} lang={lang} />
  ) : (
    <SplitDiff hunks={enriched} hl={canHighlight} lang={lang} />
  );
}

interface EHunk {
  header: string;
  lines: RLine[];
}

function LineContent({ line, hl, lang }: { line: RLine; hl: Highlighter | null; lang: string | null }) {
  if (line.words) {
    const cls = line.kind === "del" ? "word-del" : "word-add";
    return (
      <>
        {line.words.map((w, i) =>
          w.changed ? (
            <span key={i} className={cls}>
              {w.text}
            </span>
          ) : (
            <span key={i}>{w.text}</span>
          ),
        )}
      </>
    );
  }
  const toks = tokenizeLine(hl, line.text, lang);
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

function InlineDiff({ hunks, hl, lang }: { hunks: EHunk[]; hl: Highlighter | null; lang: string | null }) {
  return (
    <div className="diff-code">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="hunk-header">{h.header}</div>
          {h.lines.map((l, li) => (
            <div key={li} className={`dline ${l.kind}`}>
              <span className="gutter">{l.oldNo ?? ""}</span>
              <span className="gutter">{l.newNo ?? ""}</span>
              <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span className="content">
                <LineContent line={l} hl={hl} lang={lang} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SplitDiff({ hunks, hl, lang }: { hunks: EHunk[]; hl: Highlighter | null; lang: string | null }) {
  return (
    <div className="diff-code split">
      {hunks.map((h, hi) => (
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
  line: RLine | null;
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
        <LineContent line={line} hl={hl} lang={lang} />
      </span>
    </div>
  );
}

interface Pair {
  left: RLine | null;
  right: RLine | null;
}

function pairLines(lines: RLine[]): Pair[] {
  const pairs: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "context") {
      pairs.push({ left: l, right: l });
      i++;
    } else {
      const dels: RLine[] = [];
      const adds: RLine[] = [];
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
