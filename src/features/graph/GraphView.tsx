import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  createBranch,
  createPatch,
  createTag,
  createWorktree,
  getGraph,
  getRemoteUrl,
  getStatus,
  mergeAdvanced,
  rebaseStandard,
  rewriteInfo,
  resetTo,
  revertCommit,
} from "../../ipc/commands";
import type { GraphRow } from "../../ipc/types";
import type { RebaseAction } from "../../ipc/types";
import { useSession, WORKING } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { useConflict, type ConflictKind, conflictLabel } from "../../stores/conflict";
import { confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { Avatar } from "../../components/Avatar";
import { copyText } from "../../lib/clipboard";
import { smartCheckout } from "../../lib/checkout";
import { timeAgo, formatTimestamp } from "../../lib/time";
import { laneColor } from "./palette";
import { CherryPickPopover } from "./CherryPickPopover";
import { RebasePlanDialog } from "./RebasePlanDialog";
import { CompareDialog } from "./CompareDialog";
import "./graph.css";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 18;
const DOT_RADIUS = 4.5;
const GUTTER_PAD = 12;
const BRANCH_COL_WIDTH = 200;
const AVATAR_SIZE = 18;
const EMPTY_HIDDEN_REFS: string[] = [];

function useGraphData(path: string | undefined) {
  return useQuery({
    queryKey: ["graph", path],
    enabled: !!path,
    queryFn: () => getGraph(path!, 0, 1_000_000),
  });
}

/** Build a web URL for a commit from a remote's git URL. */
function commitWebUrl(remote: string, sha: string): string | null {
  let url = remote.trim();
  // scp-style: git@host:owner/repo(.git)
  const scp = url.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^ssh:\/\//, "https://").replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^https?:\/\//.test(url)) return null;
  const sep = /gitlab/i.test(url) ? "/-/commit/" : "/commit/";
  return `${url}${sep}${sha}`;
}

export function GraphView() {
  const repo = useSession((s) => s.repo);
  const selectedOid = useSession((s) => s.selectedOid);
  const selectOid = useSession((s) => s.selectOid);
  const graphOpts = useSession((s) => s.graphOpts);
  const setGraphOpts = useSession((s) => s.setGraphOpts);
  const hiddenRefs = useSession((s) =>
    repo ? s.hiddenRefs[repo.path] ?? EMPTY_HIDDEN_REFS : EMPTY_HIDDEN_REFS,
  );
  const checkoutTarget = useSession((s) => s.checkoutTarget);

  const { data, isLoading, error } = useGraphData(repo?.path);
  const rows = data?.rows ?? [];

  const { data: status } = useQuery({
    queryKey: ["status", repo?.path],
    enabled: !!repo?.path,
    queryFn: () => getStatus(repo!.path),
  });
  const { data: originUrl } = useQuery({
    queryKey: ["remoteUrl", repo?.path],
    enabled: !!repo?.path,
    queryFn: () => getRemoteUrl(repo!.path, "origin"),
  });

  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
  const setConflict = useConflict((s) => s.set);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [gearOpen, setGearOpen] = useState(false);
  const [selectedOids, setSelectedOids] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [pick, setPick] = useState<{ oids: string[]; parents: string[] } | null>(null);
  const [rebasePlan, setRebasePlan] = useState<{
    base: string;
    targetOid?: string;
    action?: RebaseAction;
    move?: "up" | "down";
  } | null>(null);
  const [comparison, setComparison] = useState<{ oldOid: string; newOid: string } | null>(null);

  useEffect(() => {
    setSelectedOids(new Set());
    setSelectionAnchor(null);
    setPick(null);
    setRebasePlan(null);
    setComparison(null);
  }, [repo?.path]);

  const rowContextMenu = useCallback(
    (e: React.MouseEvent, row: GraphRow) => {
      e.preventDefault();
      if (!repo) return;
      const path = repo.path;
      const head = repo.head.branch ?? "HEAD";
      const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === path });
      const run = async (fn: () => Promise<unknown>, ok?: string) => {
        try {
          await fn();
          if (ok) pushToast("success", ok);
          refresh();
        } catch (err) {
          toastError(err);
        }
      };
      const reportConflicts = (kind: ConflictKind, c: { conflicts: string[] }, okMsg: string) => {
        if (c.conflicts.length > 0) {
          setConflict({ repoPath: path, kind, files: c.conflicts });
          pushToast("error", `${conflictLabel(kind)} paused — ${c.conflicts.length} conflicted file(s).`);
        } else if (okMsg) {
          pushToast("success", okMsg);
        }
      };

      const localBadge = row.refs.find((r) => r.kind === "localBranch");
      const short = row.oid.slice(0, 7);
      const chosenRows =
        selectedOids.has(row.oid) && selectedOids.size > 1
          ? rows.filter((candidate) => selectedOids.has(candidate.oid))
          : [row];
      const chosenOldestFirst = [...chosenRows].reverse().map((candidate) => candidate.oid);
      const parentRow = rows.find((candidate) => candidate.oid === row.parents[0]);

      const standardRebase = async () => {
        try {
          const info = await rewriteInfo(path, row.oid);
          if (info.pushed || info.merges) {
            const notes = [
              info.pushed
                ? `${info.pushed} affected commit(s) are already pushed; force push with lease will be required.`
                : "",
              info.merges ? `${info.merges} merge commit(s) will be flattened.` : "",
            ]
              .filter(Boolean)
              .join("\n");
            if (
              !(await confirmDialog({
                title: `Rebase ${head} onto ${short}`,
                message: notes,
                confirmLabel: "Rebase",
                danger: info.pushed > 0,
              }))
            ) {
              return;
            }
          }
          await run(() =>
            rebaseStandard(path, row.oid).then((result) =>
              result.success
                ? pushToast("success", `Rebased ${info.commits} commit(s)`)
                : reportConflicts("rebase", result, ""),
            ),
          );
        } catch (error) {
          toastError(error);
        }
      };

      const createWorktreeFlow = async () => {
        const name = await promptDialog({
          title: "Create worktree",
          label: "Worktree / branch name",
          confirmLabel: "Choose location…",
          validate: validateRefName,
        });
        if (!name) return;
        const parent = await openDialog({ directory: true, title: "Choose worktree location" });
        if (typeof parent !== "string") return;
        const wtPath = `${parent}/${name}`;
        run(() => createWorktree(path, name, wtPath, row.oid), `Worktree ${name} created`);
      };
      const createPatchFlow = async () => {
        const out = await saveDialog({ defaultPath: `${short}.patch`, title: "Save patch" });
        if (typeof out !== "string") return;
        run(() => createPatch(path, row.oid, out), "Patch created");
      };

      const items: MenuItem[] = [];
      if (localBadge) {
        items.push({
          label: `Checkout ${localBadge.name}`,
          onClick: () => run(() => smartCheckout(path, localBadge.name), `Checked out ${localBadge.name}`),
        });
      }
      items.push(
        { label: "Checkout this commit", onClick: () => run(() => smartCheckout(path, row.oid), "Checked out commit") },
        { label: "Create worktree from this commit", onClick: createWorktreeFlow },
        { separator: true },
        {
          label: "Create branch here",
          onClick: async () => {
            const name = await promptDialog({
              title: "Create branch",
              label: "Branch name",
              placeholder: "feature/x",
              confirmLabel: "Create",
              validate: validateRefName,
            });
            if (name) run(() => createBranch(path, name, row.oid, false), `Created ${name}`);
          },
        },
        {
          label: chosenOldestFirst.length > 1 ? `Cherry-pick ${chosenOldestFirst.length} commits` : "Cherry-pick commit",
          onClick: () =>
            setPick({
              oids: chosenOldestFirst,
              parents: chosenOldestFirst.length === 1 ? row.parents : [],
            }),
        },
        {
          label: `Rebase ${head} onto this commit`,
          onClick: standardRebase,
        },
        {
          label: `Interactive rebase ${head} onto this commit`,
          onClick: () => setRebasePlan({ base: row.oid }),
        },
        {
          label: `Reset ${head} to this commit`,
          submenu: [
            { label: "Soft (keep index & working tree)", onClick: () => run(() => resetTo(path, row.oid, "soft"), "Reset (soft)") },
            { label: "Mixed (keep working tree)", onClick: () => run(() => resetTo(path, row.oid, "mixed"), "Reset (mixed)") },
            {
              label: "Hard (discard changes)",
              danger: true,
              onClick: async () => {
                if (
                  await confirmDialog({
                    title: "Hard reset",
                    message: "This discards all uncommitted changes in the working tree. Continue?",
                    confirmLabel: "Hard reset",
                    danger: true,
                  })
                ) {
                  run(() => resetTo(path, row.oid, "hard"), "Reset (hard)");
                }
              },
            },
          ],
        },
        {
          label: "Revert commit",
          onClick: () => run(() => revertCommit(path, row.oid).then((r) => reportConflicts("revert", r, "Reverted"))),
        },
        {
          label: "Edit commit message",
          disabled: row.parents.length === 0,
          onClick: () =>
            row.parents[0] && setRebasePlan({ base: row.parents[0], targetOid: row.oid, action: "reword" }),
        },
        {
          label: "Drop commit",
          danger: true,
          disabled: row.parents.length === 0,
          onClick: async () => {
            if (
              row.parents[0] &&
              (await confirmDialog({
                title: "Drop commit",
                message: `Drop ${short} and rewrite all of its children?`,
                confirmLabel: "Review rebase plan",
                danger: true,
              }))
            ) {
              setRebasePlan({ base: row.parents[0], targetOid: row.oid, action: "drop" });
            }
          },
        },
        {
          label: "Squash into parent",
          disabled: !parentRow?.parents[0],
          onClick: () =>
            parentRow?.parents[0] &&
            setRebasePlan({ base: parentRow.parents[0], targetOid: row.oid, action: "squash" }),
        },
        {
          label: "Move commit up",
          disabled: row.parents.length === 0,
          onClick: () =>
            row.parents[0] && setRebasePlan({ base: row.parents[0], targetOid: row.oid, move: "up" }),
        },
        {
          label: "Move commit down",
          disabled: !parentRow?.parents[0],
          onClick: () =>
            parentRow?.parents[0] &&
            setRebasePlan({ base: parentRow.parents[0], targetOid: row.oid, move: "down" }),
        },
        { separator: true },
        { label: "Copy commit sha", onClick: () => copyText(row.oid) },
        {
          label: "Compare two commits",
          disabled: chosenRows.length !== 2,
          onClick: () =>
            chosenRows.length === 2 &&
            setComparison({ oldOid: chosenRows[1].oid, newOid: chosenRows[0].oid }),
        },
        { label: "Compare against working directory", onClick: () => selectOid(WORKING) },
      );
      if (originUrl) {
        const web = commitWebUrl(originUrl, row.oid);
        if (web) {
          items.push({ label: "Copy link to this commit on remote: origin", onClick: () => copyText(web) });
        }
      }
      items.push(
        { label: "Create patch from commit", onClick: createPatchFlow },
        { separator: true },
        {
          label: "Create tag here",
          onClick: async () => {
            const name = await promptDialog({
              title: "Create tag",
              label: "Tag name",
              confirmLabel: "Create",
              validate: validateRefName,
            });
            if (name) run(() => createTag(path, name, row.oid), `Tagged ${name}`);
          },
        },
        {
          label: "Create annotated tag here",
          onClick: async () => {
            const name = await promptDialog({
              title: "Create annotated tag",
              label: "Tag name",
              confirmLabel: "Next",
              validate: validateRefName,
            });
            if (!name) return;
            const msg =
              (await promptDialog({ title: `Tag ${name}`, label: "Tag message", confirmLabel: "Create" })) ?? "";
            run(() => createTag(path, name, row.oid, msg), `Tagged ${name}`);
          },
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [repo, qc, pushToast, originUrl, setConflict, rows, selectedOids, selectOid],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  const maxLane = rows.reduce((m, r) => {
    let local = r.lane;
    for (const e of r.edges) local = Math.max(local, e.fromLane, e.toLane);
    return Math.max(m, local);
  }, 0);
  const gutterWidth = (maxLane + 1) * LANE_WIDTH + GUTTER_PAD;

  const laneX = useCallback((lane: number) => GUTTER_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const parent = parentRef.current;
    if (!canvas || !parent) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = gutterWidth;
    const ch = parent.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";

    const scrollTop = parent.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 1);
    const last = Math.min(rows.length - 1, Math.ceil((scrollTop + ch) / ROW_HEIGHT) + 1);

    for (let i = first; i <= last; i++) {
      const row = rows[i];
      const yTop = i * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
      const yBot = yTop + ROW_HEIGHT;
      for (const e of row.edges) {
        const x1 = laneX(e.fromLane);
        const x2 = laneX(e.toLane);
        ctx.strokeStyle = laneColor(e.color);
        ctx.beginPath();
        ctx.moveTo(x1, yTop);
        if (x1 === x2) {
          ctx.lineTo(x2, yBot);
        } else {
          const midY = (yTop + yBot) / 2;
          ctx.bezierCurveTo(x1, midY, x2, midY, x2, yBot);
        }
        ctx.stroke();
      }
    }

    for (let i = first; i <= last; i++) {
      const row = rows[i];
      const y = i * ROW_HEIGHT - scrollTop + ROW_HEIGHT / 2;
      const x = laneX(row.lane);
      const selected = row.oid === selectedOid;
      ctx.beginPath();
      ctx.arc(x, y, selected ? DOT_RADIUS + 1.5 : DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = laneColor(row.color);
      ctx.fill();
      if (selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.lineWidth = 1.8;
      }
    }
  }, [rows, gutterWidth, laneX, selectedOid]);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    };
    parent.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => draw());
    ro.observe(parent);
    return () => {
      parent.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [draw]);

  useLayoutEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      if (rows.length === 0) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      ev.preventDefault();
      const idx = rows.findIndex((r) => r.oid === selectedOid);
      const next =
        ev.key === "ArrowDown"
          ? Math.min(rows.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
      selectOid(rows[next].oid);
      virtualizer.scrollToIndex(next, { align: "auto" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selectedOid, selectOid, virtualizer]);

  useEffect(() => {
    if (!data?.head) return;
    const index = rows.findIndex((row) => row.oid === data.head);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [data?.head]);

  if (!repo) {
    return <div className="graph-empty">Open a repository to view its history.</div>;
  }
  if (isLoading) {
    return <div className="graph-empty">Loading history…</div>;
  }
  if (error) {
    return <div className="graph-empty error">{String(error)}</div>;
  }
  if (rows.length === 0 && !status?.isDirty) {
    return <div className="graph-empty">No commits yet.</div>;
  }

  const dirtyCount = new Set([
    ...(status?.staged ?? []).map((entry) => entry.path),
    ...(status?.unstaged ?? []).map((entry) => entry.path),
    ...(status?.conflicted ?? []).map((entry) => entry.path),
  ]).size;

  const selectRow = (event: React.MouseEvent, row: GraphRow) => {
    if ((event.metaKey || event.ctrlKey)) {
      setSelectedOids((current) => {
        const next = new Set(current);
        if (next.has(row.oid)) next.delete(row.oid);
        else next.add(row.oid);
        return next;
      });
    } else if (event.shiftKey && selectionAnchor) {
      const from = rows.findIndex((candidate) => candidate.oid === selectionAnchor);
      const to = rows.findIndex((candidate) => candidate.oid === row.oid);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedOids(new Set(rows.slice(start, end + 1).map((candidate) => candidate.oid)));
      }
    } else {
      setSelectedOids(new Set([row.oid]));
    }
    setSelectionAnchor(row.oid);
    selectOid(row.oid);
  };

  const dropOnRef = (event: React.DragEvent, target: string, isHead: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (!repo) return;
    const commitOid = event.dataTransfer.getData("application/x-mtgit-commit");
    if (commitOid) {
      if (!isHead) {
        pushToast("info", "Check out the target branch before cherry-picking onto it.");
        return;
      }
      const commit = rows.find((candidate) => candidate.oid === commitOid);
      setPick({ oids: [commitOid], parents: commit?.parents ?? [] });
      return;
    }
    const source = event.dataTransfer.getData("application/x-mtgit-ref");
    if (!source || source === target) return;
    const runDrop = async (action: "merge" | "rebase" | "ff") => {
      try {
        if (repo.head.branch !== target) await smartCheckout(repo.path, target);
        if (action === "rebase") {
          const result = await rebaseStandard(repo.path, source);
          if (!result.success) {
            setConflict({ repoPath: repo.path, kind: "rebase", files: result.conflicts, canSkip: true });
          } else {
            pushToast("success", `Rebased ${target} onto ${source}.`);
          }
        } else {
          const result = await mergeAdvanced(repo.path, source, action === "ff" ? "ffOnly" : "noFf");
          if (result.kind === "conflicts") {
            setConflict({ repoPath: repo.path, kind: "merge", files: result.conflicts });
          } else {
            pushToast("success", action === "ff" ? `Fast-forwarded ${target} to ${source}.` : `Merged ${source} into ${target}.`);
          }
        }
        qc.invalidateQueries({ predicate: (query) => query.queryKey[1] === repo.path });
      } catch (error) {
        toastError(error);
      }
    };
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: `Merge ${source} into ${target}`, onClick: () => runDrop("merge") },
        { label: `Rebase ${target} onto ${source}`, onClick: () => runDrop("rebase") },
        { label: `Fast-forward ${target} to ${source}`, onClick: () => runDrop("ff") },
      ],
    });
  };

  return (
    <div className="graph-container">
      <div className="graph-header">
        <div className="gh-refs" style={{ width: BRANCH_COL_WIDTH }}>
          BRANCH / TAG
        </div>
        <div className="gh-graph" style={{ width: gutterWidth }}>
          GRAPH
        </div>
        <div className="gh-message">COMMIT MESSAGE</div>
        <button className="gh-gear" title="Graph options" onClick={() => setGearOpen((v) => !v)}>
          ⚙
        </button>
        {gearOpen && (
          <div className="gh-gear-pop" onMouseLeave={() => setGearOpen(false)}>
            <label>
              <input
                type="checkbox"
                checked={graphOpts.relativeDates}
                onChange={(e) => setGraphOpts({ relativeDates: e.target.checked })}
              />
              Relative dates
            </label>
            <label>
              <input
                type="checkbox"
                checked={graphOpts.showAuthor}
                onChange={(e) => setGraphOpts({ showAuthor: e.target.checked })}
              />
              Show author
            </label>
          </div>
        )}
      </div>

      {status?.isDirty && (
        <div
          className={`wip-row${selectedOid === WORKING ? " selected" : ""}`}
          onClick={() => selectOid(WORKING)}
        >
          <span className="wip-dot" />
          <span className="wip-label">// WIP</span>
          <span className="wip-count">✎ {dirtyCount} changed file{dirtyCount === 1 ? "" : "s"}</span>
        </div>
      )}
      <div className="graph-scroll" ref={parentRef}>
        <div className="graph-inner" style={{ height: virtualizer.getTotalSize() }}>
          <canvas className="graph-canvas" ref={canvasRef} style={{ marginLeft: BRANCH_COL_WIDTH }} />
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <GraphRowView
                key={row.oid}
                row={row}
                top={vi.start}
                gutter={gutterWidth}
                nodeLeft={BRANCH_COL_WIDTH + laneX(row.lane)}
                selected={row.oid === selectedOid || selectedOids.has(row.oid)}
                opts={graphOpts}
                onSelect={(event) => selectRow(event, row)}
                onContextMenu={(e) => rowContextMenu(e, row)}
                onCheckoutRef={(name) =>
                  repo &&
                  smartCheckout(repo.path, name)
                    .then(() => {
                      pushToast("success", `Checked out ${name}.`);
                      qc.invalidateQueries({ predicate: (query) => query.queryKey[1] === repo.path });
                    })
                    .catch(toastError)
                }
                onRefDrop={dropOnRef}
                hiddenRefs={hiddenRefs}
                checkoutTarget={checkoutTarget}
              />
            );
          })}
        </div>
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {pick && repo && (
        <CherryPickPopover
          repoPath={repo.path}
          branch={repo.head.branch ?? repo.head.oid?.slice(0, 7) ?? "HEAD"}
          oids={pick.oids}
          parents={pick.parents}
          onClose={() => setPick(null)}
        />
      )}
      {rebasePlan && repo && (
        <RebasePlanDialog
          repoPath={repo.path}
          base={rebasePlan.base}
          targetOid={rebasePlan.targetOid}
          initialAction={rebasePlan.action}
          initialMove={rebasePlan.move}
          onClose={() => setRebasePlan(null)}
        />
      )}
      {comparison && repo && (
        <CompareDialog
          repoPath={repo.path}
          oldOid={comparison.oldOid}
          newOid={comparison.newOid}
          onClose={() => setComparison(null)}
        />
      )}
    </div>
  );
}

function GraphRowView({
  row,
  top,
  gutter,
  nodeLeft,
  selected,
  opts,
  onSelect,
  onContextMenu,
  onCheckoutRef,
  onRefDrop,
  hiddenRefs,
  checkoutTarget,
}: {
  row: GraphRow;
  top: number;
  gutter: number;
  nodeLeft: number;
  selected: boolean;
  opts: { relativeDates: boolean; showAuthor: boolean };
  onSelect: (event: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onCheckoutRef: (name: string) => void;
  onRefDrop: (event: React.DragEvent, target: string, isHead: boolean) => void;
  hiddenRefs: string[];
  checkoutTarget: string | null;
}) {
  const localNames = new Set(row.refs.filter((ref) => ref.kind === "localBranch").map((ref) => ref.name));
  const collapsedRemotes = new Set(
    row.refs
      .filter((ref) => ref.kind === "remoteBranch")
      .map((ref) => ref.name.split("/").slice(1).join("/"))
      .filter((name) => localNames.has(name)),
  );
  const displayRefs = row.refs.filter(
    (ref) =>
      !hiddenRefs.includes(ref.name) &&
      (ref.kind !== "remoteBranch" ||
        !collapsedRemotes.has(ref.name.split("/").slice(1).join("/"))),
  );
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}`}
      style={{ top, height: ROW_HEIGHT }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-mtgit-commit", row.oid);
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className="row-refs" style={{ width: BRANCH_COL_WIDTH }}>
        {displayRefs.map((r) => (
          <span
            key={r.kind + r.name}
            className={`badge badge-${r.kind}${r.isHead ? " head" : ""}`}
            style={
              r.isHead
                ? { backgroundColor: laneColor(row.color), borderColor: laneColor(row.color) }
                : { borderColor: laneColor(row.color), boxShadow: `inset 0 0 0 1px ${laneColor(row.color)}33` }
            }
            title={`${r.name} — double-click to checkout`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (r.kind !== "tag" && !r.isHead) onCheckoutRef(r.name);
            }}
            draggable
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.setData("application/x-mtgit-ref", r.name);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (r.kind !== "tag") event.preventDefault();
            }}
            onDrop={(event) => r.kind !== "tag" && onRefDrop(event, r.name, r.isHead)}
          >
            {r.kind === "tag" ? "🏷 " : ""}
            {r.isHead ? "✓ 💻 " : ""}
            {r.kind === "remoteBranch" || (r.kind === "localBranch" && collapsedRemotes.has(r.name)) ? "☁ " : ""}
            {checkoutTarget === r.name ? "◌ " : ""}
            {r.name}
          </span>
        ))}
      </div>
      <div className="row-graph" style={{ width: gutter }} />
      <span
        className={`node-avatar${row.parents.length > 1 ? " merge-node" : ""}`}
        style={{ left: nodeLeft - AVATAR_SIZE / 2, borderColor: laneColor(row.color) }}
      >
        <Avatar email={row.email} name={row.author} size={AVATAR_SIZE} />
      </span>
      <span className="row-summary">{row.summary}</span>
      {opts.showAuthor && <span className="row-author">{row.author}</span>}
      <span className="row-date" title={formatTimestamp(row.timestamp)}>
        {opts.relativeDates ? timeAgo(row.timestamp) : formatTimestamp(row.timestamp)}
      </span>
      <span className="row-oid">{row.oid.slice(0, 7)}</span>
    </div>
  );
}
