import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, DiffViewMode, FileDiff, Hunk } from "../../ipc/types";

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

/** Where one run of changed lines starts, and what it is made of. */
export interface ChangeRun {
  /** Index into the flattened line list, for positioning on the ruler. */
  offset: number;
  length: number;
  kind: "add" | "del" | "mixed";
}

/**
 * Every run of consecutive changed lines in the file.
 *
 * A "change" is a run, not a line: stepping line by line through a forty-line
 * replacement is not navigation, it is scrolling with extra steps. The same
 * list positions the marks on the overview ruler, so the lines are walked once
 * for both.
 *
 * Exported because `FileViewer` owns the toolbar and needs the count to know
 * whether the stepper has anywhere to go — deriving it there a second way is
 * how the count and the marks drift apart.
 */
export function changeRuns(hunks: { lines: DiffLine[] }[]): ChangeRun[] {
  const runs: ChangeRun[] = [];
  let offset = 0;
  for (const hunk of hunks) {
    let i = 0;
    while (i < hunk.lines.length) {
      if (hunk.lines[i].kind === "context") {
        i++;
        offset++;
        continue;
      }
      const start = offset;
      let adds = 0;
      let dels = 0;
      while (i < hunk.lines.length && hunk.lines[i].kind !== "context") {
        if (hunk.lines[i].kind === "add") adds++;
        else dels++;
        i++;
        offset++;
      }
      runs.push({
        offset: start,
        length: offset - start,
        kind: adds && dels ? "mixed" : adds ? "add" : "del",
      });
    }
  }
  return runs;
}

/** Total lines across every hunk — the ruler's coordinate space. */
export function totalDiffLines(hunks: { lines: DiffLine[] }[]): number {
  return hunks.reduce((n, h) => n + h.lines.length, 0);
}

export function DiffView({
  diff,
  mode,
  staging,
  changeIndex,
  onChangeIndex,
  onHunkAction,
  onLinesAction,
  onDiscardHunk,
}: {
  diff: FileDiff;
  mode: DiffViewMode;
  staging?: "stage" | "unstage" | null;
  /** Which run of changed lines to scroll to; -1 for none. Owned by the
   *  toolbar that steps it, because that is where the buttons are. */
  changeIndex?: number;
  onChangeIndex?: (index: number) => void;
  onHunkAction?: (hunk: Hunk) => void;
  onLinesAction?: (hunk: Hunk, selected: Set<number>) => void;
  onDiscardHunk?: (hunk: Hunk) => void;
}) {
  const hl = useHighlighter();
  const lang = langForPath(diff.path);
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const totalLines = useMemo(() => totalDiffLines(diff.hunks), [diff]);
  const canHighlight = totalLines <= MAX_HIGHLIGHT_LINES ? hl : null;
  const runs = useMemo(() => changeRuns(diff.hunks), [diff]);

  const enriched = useMemo(
    () => diff.hunks.map((h) => ({ header: h.header, lines: enrich(h.lines), original: h })),
    [diff],
  );

  // Scroll by data attribute rather than by a ref per run: the marked element
  // is the run's first line, and there are as many of those as the file has
  // changes. Forty refs for a forty-hunk file is forty more things to keep in
  // step with a re-render.
  useEffect(() => {
    if (changeIndex === undefined || changeIndex < 0) return;
    const target = scrollRef.current?.querySelector(`[data-change="${changeIndex}"]`);
    target?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [changeIndex, mode]);

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
    <div className="diff-pane">
      {mode === "inline" ? (
        <InlineDiff
          scrollRef={scrollRef}
          hunks={enriched}
          hl={canHighlight}
          lang={lang}
          staging={staging}
          selected={selected}
          setSelected={setSelected}
          onHunkAction={onHunkAction}
          onLinesAction={onLinesAction}
          onDiscardHunk={onDiscardHunk}
        />
      ) : (
        <SplitDiff
          scrollRef={scrollRef}
          hunks={enriched}
          hl={canHighlight}
          lang={lang}
          staging={staging}
          onHunkAction={onHunkAction}
          onDiscardHunk={onDiscardHunk}
        />
      )}
      <OverviewRuler
        runs={runs}
        total={totalLines}
        scrollRef={scrollRef}
        mode={mode}
        current={changeIndex ?? -1}
        onPick={(index) => onChangeIndex?.(index)}
      />
    </div>
  );
}

/**
 * The whole file's shape, down the right edge of the diff.
 *
 * A sibling of the scroller rather than a child, for the reason `graph.css`
 * gives about the marker gutter: an absolutely positioned child of a scroll
 * container is placed against its *content* box, so it scrolls away.
 *
 * One mark per run, not per line — a 5000-line diff would otherwise be 5000
 * elements for a strip ten pixels wide.
 */
function OverviewRuler({
  runs,
  total,
  scrollRef,
  mode,
  current,
  onPick,
}: {
  runs: ChangeRun[];
  total: number;
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Not read — a dependency. See the effect below. */
  mode: DiffViewMode;
  current: number;
  onPick: (index: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // The viewport box is written straight to the DOM rather than held in state.
  // The diff is not virtualized, so a `setState` per scroll frame re-renders
  // every line in the file — which is the one thing a 2000-line diff cannot
  // afford to do while you are scrolling it.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const box = viewportRef.current;
    if (!scroller || !box) return;
    const paint = () => {
      const height = scroller.scrollHeight || 1;
      box.style.top = `${(scroller.scrollTop / height) * 100}%`;
      box.style.height = `${Math.max((scroller.clientHeight / height) * 100, 2)}%`;
    };
    paint();
    scroller.addEventListener("scroll", paint, { passive: true });
    return () => scroller.removeEventListener("scroll", paint);
    // `mode` is in here because `InlineDiff` and `SplitDiff` are different
    // components: switching between them unmounts one scroller and mounts
    // another, so `scrollRef.current` is a new node while the ref object this
    // effect closes over is the same one. Without it the listener stays on the
    // detached element and the viewport box freezes where it was.
  }, [scrollRef, runs, mode]);

  if (runs.length === 0) return null;
  return (
    <div className="diff-ruler" aria-hidden="true">
      <div ref={viewportRef} className="diff-ruler-viewport" />
      {runs.map((run, i) => (
        <button
          key={run.offset}
          type="button"
          tabIndex={-1}
          className={`diff-ruler-mark ${run.kind}${i === current ? " current" : ""}`}
          style={{
            top: `${(run.offset / Math.max(total, 1)) * 100}%`,
            height: `${Math.max((run.length / Math.max(total, 1)) * 100, 0.6)}%`,
          }}
          onClick={() => onPick(i)}
        />
      ))}
    </div>
  );
}

interface EHunk {
  header: string;
  lines: RLine[];
  original: Hunk;
}

/**
 * `(hunk, line) -> run index`, or undefined for a line that starts no run.
 *
 * Only the *first* line of a run is marked. Marking every changed line would
 * make `scrollIntoView` land on whichever one the browser found first, which
 * for a `querySelector` is the same line either way — but it would also put a
 * `data-change` attribute on several thousand elements to say one thing.
 */
function useRunIndex(hunks: EHunk[]): (hunk: number, line: number | undefined) => number | undefined {
  return useMemo(() => {
    const starts = new Map<string, number>();
    let run = 0;
    hunks.forEach((h, hi) => {
      let i = 0;
      while (i < h.lines.length) {
        if (h.lines[i].kind === "context") {
          i++;
          continue;
        }
        starts.set(`${hi}:${i}`, run++);
        while (i < h.lines.length && h.lines[i].kind !== "context") i++;
      }
    });
    return (hunk, line) => (line === undefined ? undefined : starts.get(`${hunk}:${line}`));
  }, [hunks]);
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

function InlineDiff({
  scrollRef,
  hunks,
  hl,
  lang,
  staging,
  selected,
  setSelected,
  onHunkAction,
  onLinesAction,
  onDiscardHunk,
}: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  hunks: EHunk[];
  hl: Highlighter | null;
  lang: string | null;
  staging?: "stage" | "unstage" | null;
  selected: Record<number, Set<number>>;
  setSelected: React.Dispatch<React.SetStateAction<Record<number, Set<number>>>>;
  onHunkAction?: (hunk: Hunk) => void;
  onLinesAction?: (hunk: Hunk, selected: Set<number>) => void;
  onDiscardHunk?: (hunk: Hunk) => void;
}) {
  const runAt = useRunIndex(hunks);
  return (
    <div className="diff-code" ref={scrollRef}>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <HunkHeader
            hunk={h.original}
            staging={staging}
            selected={selected[hi]}
            onHunkAction={onHunkAction}
            onLinesAction={onLinesAction}
            onDiscardHunk={onDiscardHunk}
          />
          {h.lines.map((l, li) => (
            <div
              key={li}
              data-change={runAt(hi, li)}
              className={`dline ${l.kind}${selected[hi]?.has(li) ? " line-selected" : ""}`}
              onClick={() => {
                if (!staging || l.kind === "context") return;
                setSelected((current) => {
                  const next = { ...current, [hi]: new Set(current[hi] ?? []) };
                  if (next[hi].has(li)) next[hi].delete(li);
                  else next[hi].add(li);
                  return next;
                });
              }}
            >
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

function SplitDiff({
  scrollRef,
  hunks,
  hl,
  lang,
  staging,
  onHunkAction,
  onDiscardHunk,
}: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  hunks: EHunk[];
  hl: Highlighter | null;
  lang: string | null;
  staging?: "stage" | "unstage" | null;
  onHunkAction?: (hunk: Hunk) => void;
  onDiscardHunk?: (hunk: Hunk) => void;
}) {
  const runAt = useRunIndex(hunks);
  return (
    <div className="diff-code split" ref={scrollRef}>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <HunkHeader
            hunk={h.original}
            staging={staging}
            onHunkAction={onHunkAction}
            onDiscardHunk={onDiscardHunk}
          />
          {pairLines(h.lines).map((pair, pi) => (
            <div
              key={pi}
              // A split row is a *pair*, so the run is looked up from whichever
              // side carries the change — the left side is null on a pure add.
              data-change={runAt(hi, pair.lineIndex)}
              className="split-row"
            >
              <Side line={pair.left} side="left" hl={hl} lang={lang} />
              <Side line={pair.right} side="right" hl={hl} lang={lang} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function HunkHeader({
  hunk,
  staging,
  selected,
  onHunkAction,
  onLinesAction,
  onDiscardHunk,
}: {
  hunk: Hunk;
  staging?: "stage" | "unstage" | null;
  selected?: Set<number>;
  onHunkAction?: (hunk: Hunk) => void;
  onLinesAction?: (hunk: Hunk, selected: Set<number>) => void;
  onDiscardHunk?: (hunk: Hunk) => void;
}) {
  return (
    <div className="hunk-header">
      <span>{hunk.header}</span>
      {staging && (
        <span className="hunk-actions">
          {!!selected?.size && (
            <button onClick={() => onLinesAction?.(hunk, selected)}>
              {staging === "stage" ? "Stage" : "Unstage"} selected lines
            </button>
          )}
          {onDiscardHunk && <button onClick={() => onDiscardHunk(hunk)}>Discard hunk</button>}
          <button onClick={() => onHunkAction?.(hunk)}>
            {staging === "stage" ? "Stage hunk" : "Unstage hunk"}
          </button>
        </span>
      )}
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
  /**
   * Index into the hunk's own line list of the line this row starts at, so a
   * split row can be matched back to a change run. Only the row that opens a
   * run carries one; the rest are undefined and mark nothing.
   */
  lineIndex?: number;
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
      const start = i;
      const dels: RLine[] = [];
      const adds: RLine[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        pairs.push({ left: dels[k] ?? null, right: adds[k] ?? null, lineIndex: k === 0 ? start : undefined });
      }
    }
  }
  return pairs;
}
