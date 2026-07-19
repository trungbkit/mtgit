import { useEffect, useMemo, useState } from "react";
import { interactiveRebase, rebaseCommits, rewriteInfo } from "../../ipc/commands";
import type { RebaseAction, RebasePlanItem, RewriteInfo } from "../../ipc/types";
import { toastError, useToasts } from "../../stores/toasts";
import { useConflict } from "../../stores/conflict";
import "./rebase-plan.css";

type PlanRow = RebasePlanItem & { summary: string };

export function RebasePlanDialog({
  repoPath,
  base,
  initialAction,
  targetOid,
  initialMove,
  onClose,
}: {
  repoPath: string;
  base: string;
  initialAction?: RebaseAction;
  targetOid?: string;
  initialMove?: "up" | "down";
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [warning, setWarning] = useState<RewriteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<number | null>(null);
  const pushToast = useToasts((state) => state.push);

  useEffect(() => {
    Promise.all([rebaseCommits(repoPath, base), rewriteInfo(repoPath, base)])
      .then(([commits, info]) => {
        const rows = commits.map((commit) => ({
          ...commit,
          action: commit.oid === targetOid && initialAction ? initialAction : ("pick" as const),
        }));
        if (targetOid && initialMove) {
          const index = rows.findIndex((row) => row.oid === targetOid);
          const target = initialMove === "up" ? index + 1 : index - 1;
          if (index >= 0 && target >= 0 && target < rows.length) {
            const [moved] = rows.splice(index, 1);
            rows.splice(target, 0, moved);
          }
        }
        setPlan(rows);
        setWarning(info);
      })
      .catch(toastError)
      .finally(() => setLoading(false));
  }, [base, initialAction, initialMove, repoPath, targetOid]);

  const invalid = plan.length === 0 || ["squash", "fixup"].includes(plan[0]?.action);
  const counts = useMemo(
    () =>
      plan.reduce(
        (all, row) => ({ ...all, [row.action]: (all[row.action] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
    [plan],
  );

  function update(index: number, patch: Partial<PlanRow>) {
    setPlan((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function move(from: number, to: number) {
    if (from === to) return;
    setPlan((current) => {
      const next = [...current];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  }

  async function start() {
    try {
      const result = await interactiveRebase(
        repoPath,
        base,
        plan.map(({ oid, action, message }) => ({ oid, action, message })),
      );
      if (result.success) {
        pushToast("success", `Interactive rebase complete (${plan.length - (counts.drop ?? 0)} commits replayed).`);
        onClose();
      } else if (result.conflicts.length) {
        useConflict.getState().set({
          repoPath,
          kind: "rebase",
          files: result.conflicts,
          current: 1,
          total: plan.length,
          canSkip: true,
        });
        pushToast("error", `Rebase paused — ${result.conflicts.length} conflicted file(s).`);
        onClose();
      } else {
        pushToast("error", result.output || "Interactive rebase failed.");
      }
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <div className="rebase-overlay" onMouseDown={onClose}>
      <div className="rebase-sheet" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>Interactive rebase</h2>
            <p>Rebase {plan.length} children of {base.slice(0, 7)}. Newest commits are shown first.</p>
          </div>
          <button onClick={onClose}>✕</button>
        </header>

        {!!warning?.pushed && (
          <div className="rebase-warning">
            {warning.pushed} affected commit{warning.pushed === 1 ? " is" : "s are"} already pushed. Completing
            this plan will require force push with lease.
          </div>
        )}
        {!!warning?.merges && (
          <div className="rebase-note">{warning.merges} merge commit(s) will be flattened by this rebase.</div>
        )}

        <div className="rebase-list">
          {loading ? (
            <div className="detail-empty">Loading commits…</div>
          ) : (
            [...plan].reverse().map((row, reverseIndex) => {
              const index = plan.length - reverseIndex - 1;
              return (
                <div
                  key={row.oid}
                  className={`rebase-row action-${row.action}`}
                  draggable
                  onDragStart={() => setDragging(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) move(dragging, index);
                    setDragging(null);
                  }}
                >
                  <span className="rebase-handle">⠿</span>
                  <select
                    value={row.action}
                    onChange={(event) => update(index, { action: event.target.value as RebaseAction })}
                  >
                    <option value="pick">Pick</option>
                    <option value="reword">Reword</option>
                    <option value="squash" disabled={index === 0}>Squash</option>
                    <option value="fixup" disabled={index === 0}>Fixup</option>
                    <option value="drop">Drop</option>
                  </select>
                  <code>{row.oid.slice(0, 7)}</code>
                  <div className="rebase-message">
                    <span>{row.summary}</span>
                    {row.action === "reword" && (
                      <input
                        value={row.message ?? row.summary}
                        onChange={(event) => update(index, { message: event.target.value })}
                        placeholder="New commit message"
                      />
                    )}
                  </div>
                  <div className="rebase-move">
                    <button disabled={index === plan.length - 1} onClick={() => move(index, index + 1)}>↑</button>
                    <button disabled={index === 0} onClick={() => move(index, index - 1)}>↓</button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <footer>
          <span>
            {counts.pick ?? 0} picks · {counts.reword ?? 0} rewords · {counts.squash ?? 0} squashes ·{" "}
            {counts.fixup ?? 0} fixups · {counts.drop ?? 0} drops
          </span>
          {invalid && <em>The oldest commit cannot be squash/fixup.</em>}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={invalid || loading} onClick={start}>
            Start Rebase
          </button>
        </footer>
      </div>
    </div>
  );
}
