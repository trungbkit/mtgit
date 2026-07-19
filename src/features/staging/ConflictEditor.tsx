import { useEffect, useMemo, useState } from "react";
import { getConflictFile, resolveConflictContent, resolveConflictSide } from "../../ipc/commands";
import { useConflict } from "../../stores/conflict";
import { toastError, useToasts } from "../../stores/toasts";
import "./conflict-editor.css";

export function ConflictEditor({ repoPath, file }: { repoPath: string; file: string }) {
  const [ours, setOurs] = useState("");
  const [theirs, setTheirs] = useState("");
  const [output, setOutput] = useState("");
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(true);
  const pushToast = useToasts((s) => s.push);
  const hunks = useMemo(() => parseConflictMarkers(output), [output]);

  useEffect(() => {
    setLoading(true);
    getConflictFile(repoPath, file)
      .then((data) => {
        setOurs(data.ours);
        setTheirs(data.theirs);
        setOutput(data.output);
        setBinary(data.binary);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [repoPath, file]);

  const markResolved = () => {
    const active = useConflict.getState().active;
    if (active?.repoPath === repoPath) {
      useConflict.getState().set({ ...active, files: active.files.filter((path) => path !== file) });
    }
  };

  async function save() {
    try {
      await resolveConflictContent(repoPath, file, output);
      markResolved();
      pushToast("success", `${file} resolved and staged.`);
    } catch (error) {
      toastError(error);
    }
  }

  async function take(side: "ours" | "theirs") {
    try {
      await resolveConflictSide(repoPath, file, side);
      markResolved();
      pushToast("success", `${file} resolved using ${side}.`);
    } catch (error) {
      toastError(error);
    }
  }

  if (loading) return <div className="detail-empty">Loading conflict…</div>;

  if (binary) {
    return (
      <div className="conflict-editor binary">
        <div className="ce-head">
          <strong>{file}</strong>
          <span>Binary or non-text conflict</span>
        </div>
        <div className="ce-binary-actions">
          <button onClick={() => take("ours")}>Keep ours</button>
          <button onClick={() => take("theirs")}>Keep theirs</button>
        </div>
      </div>
    );
  }

  return (
    <div className="conflict-editor">
      <div className="ce-head">
        <strong>{file}</strong>
        <span>Choose either side, combine them, or edit the output directly.</span>
      </div>
      <div className="ce-sides">
        <section>
          <header>
            <span>Ours</span>
            <button onClick={() => setOutput(ours)}>Take all ours</button>
          </header>
          <textarea value={ours} readOnly spellCheck={false} />
        </section>
        <section>
          <header>
            <span>Theirs</span>
            <button onClick={() => setOutput(theirs)}>Take all theirs</button>
          </header>
          <textarea value={theirs} readOnly spellCheck={false} />
        </section>
      </div>
      <section className="ce-output">
        <header>
          <span>Output</span>
          <div>
            <button onClick={() => setOutput(`${ours}${ours.endsWith("\n") ? "" : "\n"}${theirs}`)}>
              Take both
            </button>
            <button className="primary" onClick={save}>
              Save &amp; mark resolved
            </button>
          </div>
        </header>
        {hunks.length > 0 && (
          <div className="ce-hunks">
            {hunks.map((hunk, index) => (
              <div key={`${hunk.start}-${index}`}>
                <span>Conflict {index + 1}</span>
                <label><input type="checkbox" onChange={() => setOutput(replaceHunk(output, hunk, hunk.ours))} /> Take ours</label>
                <label><input type="checkbox" onChange={() => setOutput(replaceHunk(output, hunk, hunk.theirs))} /> Take theirs</label>
                <label><input type="checkbox" onChange={() => setOutput(replaceHunk(output, hunk, `${hunk.ours}${hunk.ours.endsWith("\n") ? "" : "\n"}${hunk.theirs}`))} /> Take both</label>
              </div>
            ))}
          </div>
        )}
        <textarea value={output} onChange={(event) => setOutput(event.target.value)} spellCheck={false} />
      </section>
    </div>
  );
}

interface ConflictHunk {
  start: number;
  end: number;
  ours: string;
  theirs: string;
}

function parseConflictMarkers(text: string): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  const pattern = /^<<<<<<<[^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    hunks.push({ start: match.index, end: pattern.lastIndex, ours: match[1], theirs: match[2] });
  }
  return hunks;
}

function replaceHunk(text: string, hunk: ConflictHunk, replacement: string): string {
  return text.slice(0, hunk.start) + replacement + text.slice(hunk.end);
}
