import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  checkout,
  cherryPick,
  createBranch,
  createPatch,
  createTag,
  createWorktree,
  getGraph,
  getRemoteUrl,
  getStatus,
  rebaseOnto,
  resetTo,
  revertCommit,
} from "../../ipc/commands";
import type { GraphRow } from "../../ipc/types";
import { useSession, WORKING } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { Avatar } from "../../components/Avatar";
import { copyText } from "../../lib/clipboard";
import { timeAgo, formatTimestamp } from "../../lib/time";
import { laneColor } from "./palette";
import "./graph.css";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 18;
const DOT_RADIUS = 4.5;
const GUTTER_PAD = 12;
const BRANCH_COL_WIDTH = 200;
const AVATAR_SIZE = 18;

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
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [gearOpen, setGearOpen] = useState(false);

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
      const reportConflicts = (c: { conflicts: string[] }, okMsg: string) => {
        if (c.conflicts.length > 0) {
          pushToast("error", `Conflicts in ${c.conflicts.length} file(s) — resolve externally.`);
        } else {
          pushToast("success", okMsg);
        }
      };

      const localBadge = row.refs.find((r) => r.kind === "localBranch");
      const short = row.oid.slice(0, 7);

      const createWorktreeFlow = async () => {
        const name = prompt("Worktree / branch name");
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
          onClick: () => run(() => checkout(path, localBadge.name), `Checked out ${localBadge.name}`),
        });
      }
      items.push(
        { label: "Checkout this commit", onClick: () => run(() => checkout(path, row.oid), "Checked out commit") },
        { label: "Create worktree from this commit", onClick: createWorktreeFlow },
        { separator: true },
        {
          label: "Create branch here",
          onClick: () => {
            const name = prompt("New branch name");
            if (name) run(() => createBranch(path, name, row.oid, false), `Created ${name}`);
          },
        },
        {
          label: "Cherry pick commit",
          onClick: () => run(() => cherryPick(path, row.oid).then((r) => reportConflicts(r, "Cherry-picked"))),
        },
        {
          label: `Rebase ${head} onto this commit`,
          onClick: () =>
            run(() =>
              rebaseOnto(path, row.oid).then((r) =>
                r.done ? pushToast("success", `Rebased ${r.applied} commit(s)`) : reportConflicts(r, ""),
              ),
            ),
        },
        {
          label: `Reset ${head} to this commit`,
          submenu: [
            { label: "Soft (keep index & working tree)", onClick: () => run(() => resetTo(path, row.oid, "soft"), "Reset (soft)") },
            { label: "Mixed (keep working tree)", onClick: () => run(() => resetTo(path, row.oid, "mixed"), "Reset (mixed)") },
            {
              label: "Hard (discard changes)",
              danger: true,
              onClick: () => {
                if (confirm("Hard reset discards uncommitted changes. Continue?")) {
                  run(() => resetTo(path, row.oid, "hard"), "Reset (hard)");
                }
              },
            },
          ],
        },
        {
          label: "Revert commit",
          onClick: () => run(() => revertCommit(path, row.oid).then((r) => reportConflicts(r, "Reverted"))),
        },
        { separator: true },
        { label: "Copy commit sha", onClick: () => copyText(row.oid) },
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
          onClick: () => {
            const name = prompt("Tag name");
            if (name) run(() => createTag(path, name, row.oid), `Tagged ${name}`);
          },
        },
        {
          label: "Create annotated tag here",
          onClick: () => {
            const name = prompt("Tag name");
            if (!name) return;
            const msg = prompt("Tag message") ?? "";
            run(() => createTag(path, name, row.oid, msg), `Tagged ${name}`);
          },
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [repo, qc, pushToast, originUrl],
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

  if (!repo) {
    return <div className="graph-empty">Open a repository to view its history.</div>;
  }
  if (isLoading) {
    return <div className="graph-empty">Loading history…</div>;
  }
  if (error) {
    return <div className="graph-empty error">{String(error)}</div>;
  }
  if (rows.length === 0) {
    return <div className="graph-empty">No commits yet.</div>;
  }

  const dirtyCount =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.conflicted.length ?? 0);

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
          <span className="wip-label">Uncommitted changes</span>
          <span className="wip-count">{dirtyCount} file{dirtyCount === 1 ? "" : "s"}</span>
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
                selected={row.oid === selectedOid}
                opts={graphOpts}
                onSelect={() => selectOid(row.oid)}
                onContextMenu={(e) => rowContextMenu(e, row)}
              />
            );
          })}
        </div>
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
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
}: {
  row: GraphRow;
  top: number;
  gutter: number;
  nodeLeft: number;
  selected: boolean;
  opts: { relativeDates: boolean; showAuthor: boolean };
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}`}
      style={{ top, height: ROW_HEIGHT }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="row-refs" style={{ width: BRANCH_COL_WIDTH }}>
        {row.refs.map((r) => (
          <span key={r.kind + r.name} className={`badge badge-${r.kind}${r.isHead ? " head" : ""}`} title={r.name}>
            {r.kind === "tag" ? "🏷 " : ""}
            {r.name}
          </span>
        ))}
      </div>
      <div className="row-graph" style={{ width: gutter }} />
      <span
        className="node-avatar"
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
