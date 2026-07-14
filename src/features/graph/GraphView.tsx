import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  checkout,
  cherryPick,
  getCommit,
  getGraph,
  getStatus,
  rebaseOnto,
  resetTo,
} from "../../ipc/commands";
import type { GraphRow } from "../../ipc/types";
import { useSession, WORKING } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { copyText } from "../../lib/clipboard";
import { laneColor } from "./palette";
import "./graph.css";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 18;
const DOT_RADIUS = 4.5;
const GUTTER_PAD = 12;

/** Fetch the whole graph in one shot — the Rust side caches the layout, and row
 *  metadata for even 50k commits is only a few MB. The DOM stays light because
 *  rows are virtualized; the canvas only ever paints the visible band. */
function useGraphData(path: string | undefined) {
  return useQuery({
    queryKey: ["graph", path],
    enabled: !!path,
    queryFn: () => getGraph(path!, 0, 1_000_000),
  });
}

export function GraphView() {
  const repo = useSession((s) => s.repo);
  const selectedOid = useSession((s) => s.selectedOid);
  const selectOid = useSession((s) => s.selectOid);

  const { data, isLoading, error } = useGraphData(repo?.path);
  const rows = data?.rows ?? [];

  const { data: status } = useQuery({
    queryKey: ["status", repo?.path],
    enabled: !!repo?.path,
    queryFn: () => getStatus(repo!.path),
  });

  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
  const [menu, setMenu] = useState<MenuState | null>(null);

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
      const items: MenuItem[] = [];
      if (localBadge) {
        items.push({
          label: `Checkout ${localBadge.name}`,
          onClick: () => run(() => checkout(path, localBadge.name), `Checked out ${localBadge.name}`),
        });
      }
      items.push(
        { label: `Checkout ${short} (detached)`, onClick: () => run(() => checkout(path, row.oid), "Checked out commit") },
        { label: "Cherry-pick onto current", onClick: () => run(() => cherryPick(path, row.oid).then((r) => reportConflicts(r, "Cherry-picked"))) },
        {
          label: `Rebase ${head} onto ${short}`,
          onClick: () =>
            run(() =>
              rebaseOnto(path, row.oid).then((r) =>
                r.done ? pushToast("success", `Rebased ${r.applied} commit(s)`) : reportConflicts(r, ""),
              ),
            ),
        },
        { label: `Reset ${head} → ${short} (soft)`, onClick: () => run(() => resetTo(path, row.oid, "soft"), "Reset (soft)") },
        { label: `Reset ${head} → ${short} (mixed)`, onClick: () => run(() => resetTo(path, row.oid, "mixed"), "Reset (mixed)") },
        {
          label: `Reset ${head} → ${short} (hard)`,
          danger: true,
          onClick: () => {
            if (confirm("Hard reset discards uncommitted changes. Continue?")) {
              run(() => resetTo(path, row.oid, "hard"), "Reset (hard)");
            }
          },
        },
        { label: "Copy SHA", onClick: () => copyText(row.oid) },
        {
          label: "Copy commit message",
          onClick: () =>
            getCommit(path, row.oid)
              .then((d) => copyText(d.body ? `${d.summary}\n\n${d.body}` : d.summary))
              .catch(toastError),
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [repo, qc, pushToast],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  // Widest lane referenced anywhere sets the gutter width.
  const maxLane = rows.reduce((m, r) => {
    let local = r.lane;
    for (const e of r.edges) local = Math.max(local, e.fromLane, e.toLane);
    return Math.max(m, local);
  }, 0);
  const gutterWidth = (maxLane + 1) * LANE_WIDTH + GUTTER_PAD;

  const laneX = useCallback((lane: number) => GUTTER_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2, []);

  // Imperative canvas paint of the visible band. Called on scroll/resize/data.
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

    // Edges first so dots sit on top.
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
          // Smooth S-curve between lanes.
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

  // Repaint on scroll.
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

  // Keyboard navigation over the selected row.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
      if (rows.length === 0) return;
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
          <canvas className="graph-canvas" ref={canvasRef} />
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index];
            return (
              <GraphRowView
                key={row.oid}
                row={row}
                top={vi.start}
                gutter={gutterWidth}
                selected={row.oid === selectedOid}
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
  selected,
  onSelect,
  onContextMenu,
}: {
  row: GraphRow;
  top: number;
  gutter: number;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}`}
      style={{ top, height: ROW_HEIGHT, paddingLeft: gutter }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <div className="row-refs">
        {row.refs.map((r) => (
          <span key={r.kind + r.name} className={`badge badge-${r.kind}${r.isHead ? " head" : ""}`}>
            {r.name}
          </span>
        ))}
      </div>
      <span className="row-summary">{row.summary}</span>
      <span className="row-author">{row.author}</span>
      <span className="row-date">{formatDate(row.timestamp)}</span>
      <span className="row-oid">{row.oid.slice(0, 7)}</span>
    </div>
  );
}

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
