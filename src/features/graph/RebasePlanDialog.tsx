import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  interactiveRebase,
  predictRebaseConflicts,
  rebaseCommits,
  rewriteInfo,
} from "../../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
import type {
  PredictedConflict,
  RebaseAction,
  RebasePlanItem,
  RewriteInfo,
} from "../../ipc/types";
import { Avatar } from "../../components/Avatar";
import { toastError, useToasts } from "../../stores/toasts";
import { captureUndoPoint, toastWithUndo } from "../../lib/undoToast";
import "./rebase-plan.css";

type PlanRow = RebasePlanItem & { summary: string; author: string; email: string; isMerge: boolean };

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
  const qc = useQueryClient();

  useEffect(() => {
    Promise.all([rebaseCommits(repoPath, base), rewriteInfo(repoPath, base)])
      .then(([commits, info]) => {
        const rows = commits.map((commit) => ({
          ...commit,
          // A merge cannot be replayed, so it has no verb to choose. It is
          // listed as "drop" because that is what the rebase does to it —
          // flatten it away — and the row says so rather than pretending.
          action: commit.isMerge
            ? ("drop" as const)
            : commit.oid === targetOid && initialAction
              ? initialAction
              : ("pick" as const),
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

  // Conflict prediction (G26). Debounced because it runs on every reorder and
  // is a tree merge per step; and deliberately *not* awaited by Start Rebase,
  // per the plan's own risk note — a forecast must never become a gate.
  const [predicted, setPredicted] = useState<PredictedConflict[] | null>(null);
  const [predicting, setPredicting] = useState(false);
  const planKey = plan.map((row) => `${row.oid}:${row.action}`).join("|");

  useEffect(() => {
    if (!plan.length) {
      setPredicted(null);
      return;
    }
    let live = true;
    setPredicting(true);
    const timer = setTimeout(() => {
      predictRebaseConflicts(
        repoPath,
        base,
        plan.filter((row) => !row.isMerge).map(({ oid, action }) => ({ oid, action })),
      )
        .then((result) => live && setPredicted(result))
        // A prediction that fails is a prediction we do not show. It must not
        // toast: the user is editing a plan, not running an operation.
        .catch(() => live && setPredicted(null))
        .finally(() => live && setPredicting(false));
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `planKey` is the plan's identity: reordering the same commits changes it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, repoPath, base]);

  // The prediction is indexed against the plan *without* merges, which is what
  // was sent; map it back to the oids the rows are keyed on.
  const conflictByOid = useMemo(
    () => new Map((predicted ?? []).map((c) => [c.oid, c] as const)),
    [predicted],
  );

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
      await requireNoPausedOperation(repoPath, "start an interactive rebase");
      // Merge rows are listed so the plan is honest, but they must not reach
      // the todo file: `git rebase -i` without `--rebase-merges` never had
      // them in its own list, and a line naming one is a todo git rejects.
      const todo = plan.filter((row) => !row.isMerge);
      // Read before the rebase so the toast can tell whether the journal
      // recorded *this* rebase (`06-rebase.md` B14).
      const capture = await captureUndoPoint(repoPath);
      const result = await interactiveRebase(
        repoPath,
        base,
        todo.map(({ oid, action, message }) => ({ oid, action, message })),
      );
      // Await before reporting or unmounting, so a mid-plan stop leaves a
      // banner behind rather than a silently paused rebase.
      await refreshRepo(qc, repoPath);
      if (result.success) {
        const replayed = todo.filter((row) => row.action !== "drop").length;
        // Undo on the toast, restoring the exact pre-rebase tip (B14): a
        // rebase is the operation people most want to take back, and the
        // moment they want it is while they are reading that it finished.
        await toastWithUndo(
          qc,
          repoPath,
          `Interactive rebase complete (${replayed} commits replayed).`,
          capture,
        );
      } else if (result.conflicts.length) {
        pushToast("error", `Rebase paused — ${result.conflicts.length} conflicted file(s).`);
      } else {
        pushToast("error", result.output || "Interactive rebase failed.");
        return;
      }
      onClose();
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
                const clash = conflictByOid.get(row.oid);
                const attached = row.action === "squash" || row.action === "fixup";
                return (
                <div
                  key={row.oid}
                  className={`rebase-row action-${row.action}${attached ? " attached" : ""}${
                    row.isMerge ? " merge" : ""
                  }${clash ? " will-conflict" : ""}`}
                  draggable={!row.isMerge}
                  onDragStart={() => setDragging(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null) move(dragging, index);
                    setDragging(null);
                  }}
                >
                  <span className="rebase-handle">{attached ? "↳" : "⠿"}</span>
                  <Avatar email={row.email} name={row.author} size={18} />
                  {row.isMerge ? (
                    <span className="rebase-mergetag" title="An interactive rebase flattens merge commits">
                      merge
                    </span>
                  ) : (
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
                  )}
                  <code>{row.oid.slice(0, 7)}</code>
                  <div className="rebase-message">
                    <span>{row.summary}</span>
                    {row.action === "reword" && !row.isMerge && (
                      <input
                        value={row.message ?? row.summary}
                        onChange={(event) => update(index, { message: event.target.value })}
                        placeholder="New commit message"
                      />
                    )}
                  </div>
                  {clash && (
                    <span
                      className="rebase-clash"
                      title={`Likely to conflict in:\n${clash.files.join("\n")}`}
                    >
                      ⚠ likely conflict
                    </span>
                  )}
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
          <span className="rebase-forecast">
            {predicting
              ? "Checking for conflicts…"
              : predicted === null
                ? ""
                : predicted.length === 0
                  ? "No conflicts predicted — an estimate, not a guarantee."
                  : `${predicted.length} step(s) likely to conflict — an estimate.`}
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
