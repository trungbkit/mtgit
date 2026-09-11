import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conflictSet,
  getConflictFile,
  resolveConflictContent,
  resolveConflictSide,
} from "../../ipc/commands";
import type { ConflictSet } from "../../ipc/types";
import { refreshRepo } from "../../ipc/repoState";
import { toastError, useToasts } from "../../stores/toasts";
import { laneColor } from "../graph/palette";
import "./conflict-editor.css";

/**
 * The unified conflict panel (G25), replacing the per-file editor.
 *
 * What makes it "unified" is not that it draws every file at once — it draws
 * one — but that **navigation crosses file boundaries**. Resolving a merge is
 * a walk through every conflicted region in the repository, and the old
 * editor made the user go back to the file list at each boundary, which is
 * where people lose their place and miss a region. `n` / `p` step through the
 * whole set, and the counter says where in it you are.
 *
 * The panes are named by **ref**, not "Ours" and "Theirs" (STATUS C4). Those
 * two words swap meaning between a merge and a rebase, so they are worse than
 * unhelpful; `conflict_set` resolves them to branch names and hands back each
 * side's lane colour so the panel can match the graph.
 */
export function ConflictPanel({
  repoPath,
  file,
  onSelectFile,
}: {
  repoPath: string;
  /** The file the staging list has selected; the panel follows it. */
  file: string;
  onSelectFile: (path: string) => void;
}) {
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
  const { data: set } = useQuery({
    queryKey: ["conflictSet", repoPath],
    queryFn: () => conflictSet(repoPath),
  });

  const [output, setOutput] = useState("");
  const [sides, setSides] = useState<{ ours: string; theirs: string; binary: boolean } | null>(null);
  const [regionCursor, setRegionCursor] = useState(0);

  useEffect(() => {
    let live = true;
    setSides(null);
    getConflictFile(repoPath, file)
      .then((data) => {
        if (!live) return;
        setSides({ ours: data.ours, theirs: data.theirs, binary: data.binary });
        setOutput(data.output);
        setRegionCursor(0);
      })
      .catch(toastError);
    return () => {
      live = false;
    };
  }, [repoPath, file]);

  // The regions the *panel* navigates come from the text on screen, not from
  // `conflict_set`: the user edits the textarea, and a cursor keyed to a
  // stale server-side list would point at a region that no longer exists.
  const regions = useMemo(() => parseRegions(output), [output]);
  const entries = set?.files ?? [];
  const fileIndex = entries.findIndex((entry) => entry.path === file);

  // Position across every file, using the server's counts for the other files
  // and the live count for this one.
  const before = entries.slice(0, Math.max(0, fileIndex)).reduce((n, e) => n + e.regions.length, 0);
  const totalRegions =
    entries.reduce((n, e) => n + e.regions.length, 0) -
    (fileIndex >= 0 ? entries[fileIndex].regions.length : 0) +
    regions.length;

  const step = useCallback(
    (delta: number) => {
      const next = regionCursor + delta;
      if (next >= 0 && next < regions.length) {
        setRegionCursor(next);
        return;
      }
      // Crossing a file boundary: land on the far end of the neighbour so
      // `p` from the first region of file 3 reaches the *last* of file 2.
      const nextFile = fileIndex + (delta > 0 ? 1 : -1);
      if (nextFile < 0 || nextFile >= entries.length) return;
      onSelectFile(entries[nextFile].path);
      setRegionCursor(delta > 0 ? 0 : Math.max(0, entries[nextFile].regions.length - 1));
    },
    [regionCursor, regions.length, fileIndex, entries, onSelectFile],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Plain letters, so they must not fire while the user is typing into
      // the output textarea — which is most of what this panel is for.
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "n") {
        event.preventDefault();
        step(1);
      } else if (event.key === "p") {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  // Re-read the index rather than dropping the file from the store's list: a
  // resolution that only partially staged, or one the user undid in the
  // terminal, would leave the optimistic version claiming the file was clean.
  const markResolved = () => refreshRepo(qc, repoPath);

  async function save() {
    try {
      await resolveConflictContent(repoPath, file, output);
      await markResolved();
      pushToast("success", `${file} resolved and staged.`);
    } catch (error) {
      toastError(error);
    }
  }

  async function take(side: "ours" | "theirs") {
    try {
      await resolveConflictSide(repoPath, file, side);
      await markResolved();
      pushToast("success", `${file} resolved using ${labelFor(set, side)}.`);
    } catch (error) {
      toastError(error);
    }
  }

  if (!sides) return <div className="detail-empty">Loading conflict…</div>;

  const oursLabel = set?.oursLabel ?? "ours";
  const theirsLabel = set?.theirsLabel ?? "theirs";
  const oursTint = set?.oursColor != null ? laneColor(set.oursColor) : "var(--border-strong)";
  const theirsTint = set?.theirsColor != null ? laneColor(set.theirsColor) : "var(--border-strong)";
  const current = regions[regionCursor];

  return (
    <div className={`conflict-editor${sides.binary ? " binary" : ""}`}>
      <div className="ce-head">
        <strong>{file}</strong>
        <span className="ce-counter">
          {totalRegions > 0 && (
            <>
              conflict {Math.min(before + regionCursor + 1, totalRegions)} of {totalRegions}
              {entries.length > 1 && (
                <>
                  {" · "}file {fileIndex + 1} of {entries.length}
                </>
              )}
            </>
          )}
        </span>
        <span className="ce-nav">
          <button onClick={() => step(-1)} title="Previous conflict (p)">
            ‹ prev
          </button>
          <button onClick={() => step(1)} title="Next conflict (n)">
            next ›
          </button>
        </span>
      </div>

      {sides.binary ? (
        <div className="ce-binary-actions">
          <span>Binary or non-text conflict — pick a whole side.</span>
          <button onClick={() => take("ours")}>Keep {oursLabel}</button>
          <button onClick={() => take("theirs")}>Keep {theirsLabel}</button>
        </div>
      ) : (
        <>
          <div className="ce-sides">
            <section style={{ borderTopColor: oursTint }}>
              <header>
                <span className="ce-side-label">
                  <i className="ce-swatch" style={{ background: oursTint }} />
                  {oursLabel}
                  <em>ours</em>
                </span>
                <button onClick={() => setOutput(sides.ours)}>Take all</button>
              </header>
              <textarea value={sides.ours} readOnly spellCheck={false} />
            </section>
            <section style={{ borderTopColor: theirsTint }}>
              <header>
                <span className="ce-side-label">
                  <i className="ce-swatch" style={{ background: theirsTint }} />
                  {theirsLabel}
                  <em>theirs</em>
                </span>
                <button onClick={() => setOutput(sides.theirs)}>Take all</button>
              </header>
              <textarea value={sides.theirs} readOnly spellCheck={false} />
            </section>
          </div>
          <section className="ce-output">
            <header>
              <span>Output</span>
              <div>
                {current && (
                  <>
                    <button onClick={() => setOutput(replaceRegion(output, current, current.ours))}>
                      This one: {oursLabel}
                    </button>
                    <button onClick={() => setOutput(replaceRegion(output, current, current.theirs))}>
                      This one: {theirsLabel}
                    </button>
                    <button
                      onClick={() =>
                        setOutput(replaceRegion(output, current, joinSides(current.ours, current.theirs)))
                      }
                    >
                      This one: both
                    </button>
                  </>
                )}
                <button className="primary" onClick={save}>
                  Save &amp; mark resolved
                </button>
              </div>
            </header>
            {regions.length === 0 && (
              <div className="ce-clean">No conflict markers left in this file.</div>
            )}
            <textarea
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              spellCheck={false}
            />
          </section>
        </>
      )}
    </div>
  );
}

function labelFor(set: ConflictSet | null | undefined, side: "ours" | "theirs"): string {
  if (!set) return side;
  return side === "ours" ? set.oursLabel : set.theirsLabel;
}

interface Region {
  start: number;
  end: number;
  ours: string;
  theirs: string;
}

/**
 * Locate the marker blocks in the *live* text.
 *
 * Deliberately duplicated from `core::advanced::parse_conflict_regions` rather
 * than fetched: the server's copy describes the file on disk, and this one has
 * to describe the textarea the user is editing. They agree on the grammar,
 * which is git's, and `an_empty_side_still_produces_a_region` pins it there.
 */
function parseRegions(text: string): Region[] {
  const out: Region[] = [];
  const pattern = /^<<<<<<<[^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    out.push({ start: match.index, end: pattern.lastIndex, ours: match[1], theirs: match[2] });
  }
  return out;
}

function replaceRegion(text: string, region: Region, replacement: string): string {
  return text.slice(0, region.start) + replacement + text.slice(region.end);
}

function joinSides(ours: string, theirs: string): string {
  return `${ours}${ours.endsWith("\n") || ours === "" ? "" : "\n"}${theirs}`;
}
