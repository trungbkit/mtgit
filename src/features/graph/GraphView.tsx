import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  commitStats,
  createBranch,
  deleteBranch,
  deleteTag,
  gitNetwork,
  renameBranch,
  createPatch,
  createTag,
  createWorktree,
  getGraph,
  getRemoteUrl,
  getStatus,
  openRepo,
  wipRows,
  mergeAdvanced,
  mergeRelation,
  rebaseStandard,
  rewriteInfo,
  resetTo,
  revertCommit,
} from "../../ipc/commands";
import type { CommitStats, GraphColumnId, GraphRow, RefBadge, SearchHit } from "../../ipc/types";
import type { RebaseAction, ResetMode } from "../../ipc/types";
import { REVEAL_COMMIT_EVENT } from "../../stores/reveal";
import { pushDetail } from "../../stores/detailStack";
import { useSession, WORKING } from "../../stores/session";
import { seedSearch, useRepoSearch, useSearch } from "../../stores/search";
import { toastError, useToasts } from "../../stores/toasts";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
import { type ConflictKind, conflictLabel } from "../../stores/conflict";
import { confirmDialog, promptDialog } from "../../stores/dialog";
import { validateFolderName, validateRefName } from "../../lib/refname";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { Avatar } from "../../components/Avatar";
import { Autolinked } from "../../components/Autolinked";
import { copyText } from "../../lib/clipboard";
import { smartCheckout } from "../../lib/checkout";
import { dropMenuItems } from "../../lib/dropMenu";
import { captureUndoPoint, toastWithUndo } from "../../lib/undoToast";
import { timeAgo, formatTimestamp } from "../../lib/time";
import { Icon } from "../../components/Icon";
import { matches } from "../../lib/keys";
import { useSettings } from "../../stores/settings";
import { laneColor } from "./palette";
import { CherryPickPopover } from "./CherryPickPopover";
import { RebasePlanDialog } from "./RebasePlanDialog";
import { SearchBar } from "./SearchBar";
import "./graph.css";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 18;
const DOT_RADIUS = 4.5;
const GUTTER_PAD = 12;
const BRANCH_COL_WIDTH = 200;
const AVATAR_SIZE = 18;
const EMPTY_HIDDEN_REFS: string[] = [];
/** Cap on gutter markers — past this they merge into a solid bar anyway. */
const MAX_MARKERS = 400;

/** Rows fetched per `get_graph` call. Big enough that a page covers several
 *  screens of scrolling, small enough that opening a 50k-commit repo does not
 *  push its whole history across IPC before the first paint. */
const PAGE_SIZE = 2000;
/** Start loading the next page once the viewport is within this many rows of
 *  the end of what has been loaded. */
const PREFETCH_MARGIN = 400;

function useGraphData(path: string | undefined) {
  return useInfiniteQuery({
    queryKey: ["graph", path],
    enabled: !!path,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getGraph(path!, pageParam, PAGE_SIZE),
    getNextPageParam: (_last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      return loaded < pages[pages.length - 1].total ? loaded : undefined;
    },
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
  const setRepo = useSession((s) => s.setRepo);
  // One date style for the whole app, persisted — not a per-session toggle.
  const dateStyle = useSettings((s) => s.settings.dateStyle);
  // Columns are a persisted preference, not session state: "a persisted
  // preference belongs in `core/settings.rs` + `stores/settings.ts`, never
  // mirrored into the session store". The old `graphOpts.showAuthor` was that
  // second source of truth, and it is gone.
  const columns = useSettings((s) => s.settings.graphColumns);
  const hiddenRefs = useSession((s) =>
    repo ? s.hiddenRefs[repo.path] ?? EMPTY_HIDDEN_REFS : EMPTY_HIDDEN_REFS,
  );
  const checkoutTarget = useSession((s) => s.checkoutTarget);

  const { data, isPending, error, hasNextPage, isFetchingNextPage, fetchNextPage } = useGraphData(
    repo?.path,
  );
  const rows = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;
  const headOid = data?.pages[0]?.head;

  const search = useRepoSearch(repo?.path);
  const hitOids = useMemo(() => new Set(search.hits.map((h) => h.oid)), [search.hits]);
  const currentHitOid = search.cursor >= 0 ? search.hits[search.cursor]?.oid : undefined;
  const filtering = !!search.submitted && search.mode === "filter";
  /** What the list actually renders. In filter mode that is the hits only. */
  const visibleRows = useMemo(
    () => (filtering ? rows.filter((row) => hitOids.has(row.oid)) : rows),
    [rows, filtering, hitOids],
  );

  const { data: status } = useQuery({
    queryKey: ["status", repo?.path],
    enabled: !!repo?.path,
    queryFn: () => getStatus(repo!.path),
  });
  // One WIP row per *dirty* worktree, each carrying the lane of its own HEAD.
  // The lane is computed in Rust against the same cached layout the graph
  // drew (invariant 5) — `GraphView` positions it, it does not derive it.
  const { data: wips } = useQuery({
    queryKey: ["wipRows", repo?.path],
    enabled: !!repo?.path,
    queryFn: () => wipRows(repo!.path),
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
  const [selectedOids, setSelectedOids] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [pick, setPick] = useState<{ oids: string[]; parents: string[] } | null>(null);
  /** Row to flash: the new HEAD after a checkout, or a just-picked commit. */
  const [flashOid, setFlashOid] = useState<string | null>(null);
  const [rebasePlan, setRebasePlan] = useState<{
    base: string;
    targetOid?: string;
    action?: RebaseAction;
    move?: "up" | "down";
  } | null>(null);

  useEffect(() => {
    setSelectedOids(new Set());
    setSelectionAnchor(null);
    setPick(null);
    setRebasePlan(null);
  }, [repo?.path]);

  const rowContextMenu = useCallback(
    (e: React.MouseEvent, row: GraphRow) => {
      e.preventDefault();
      if (!repo) return;
      const path = repo.path;
      const head = repo.head.branch ?? "HEAD";
      const refresh = () => refreshRepo(qc, path);
      const run = async (fn: () => Promise<unknown>, ok?: string) => {
        // The journal point is read *before* the mutation so the toast can
        // tell whether this operation is the one Undo would reverse (§3.3).
        const capture = await captureUndoPoint(path);
        try {
          await fn();
          await refresh();
          if (ok) await toastWithUndo(qc, path, ok, capture);
        } catch (err) {
          toastError(err);
        }
      };
      // Toast only. The banner is `refreshRepo`'s to raise, from git's own
      // record, so that a conflict looks identical however it was caused —
      // including one the user made in the terminal (overview §5.1).
      const reportConflicts = (kind: ConflictKind, c: { conflicts: string[] }, okMsg: string) => {
        if (c.conflicts.length > 0) {
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
      // Rows are newest-first, so the last chosen row is the oldest commit.
      const oldestSelected = chosenRows[chosenRows.length - 1];
      const parentRow = rows.find((candidate) => candidate.oid === row.parents[0]);

      const standardRebase = async () => {
        try {
          await requireNoPausedOperation(path, `rebase ${head} onto ${short}`);
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
                ? // `06-rebase.md` B7: rebasing onto an ancestor replays
                  // nothing, and "Rebased 0 commit(s)" reads as a failure.
                  pushToast(
                    info.commits === 0 ? "info" : "success",
                    info.commits === 0 ? "Already up to date." : `Rebased ${info.commits} commit(s)`,
                  )
                : reportConflicts("rebase", result, ""),
            ),
          );
        } catch (error) {
          toastError(error);
        }
      };

      /**
       * `target` is a branch name when the row carries one, and the commit oid
       * otherwise. A branch is attached as-is; a bare commit now gets a
       * **detached HEAD** (`02-checkout.md` B8) rather than a branch named
       * after the folder — asking for "a worktree at this commit" is not
       * asking for a new branch, and the invented one occupied the name.
       */
      const createWorktreeFlow = async (target: string, label: string) => {
        const detach = target === row.oid;
        const name = await promptDialog({
          title: `Open ${label} in a worktree`,
          message: detach
            ? "The worktree will sit on a detached HEAD at this commit. Create a branch from it later if you want one."
            : undefined,
          label: detach ? "Worktree folder name" : "Worktree folder / branch name",
          defaultValue: detach ? "" : target.split("/").pop() ?? "",
          confirmLabel: "Choose location…",
          // A detached worktree's name is only a directory, so it is checked
          // as one; an attached worktree's name also becomes a branch.
          validate: detach ? validateFolderName : validateRefName,
        });
        if (!name) return;
        const parent = await openDialog({ directory: true, title: "Choose worktree location" });
        if (typeof parent !== "string") return;
        const wtPath = `${parent}/${name}`;
        run(async () => {
          await createWorktree(path, name, wtPath, target, detach);
          setRepo(await openRepo(wtPath));
        }, `Worktree ${name} created`);
      };
      const createPatchFlow = async () => {
        const out = await saveDialog({ defaultPath: `${short}.patch`, title: "Save patch" });
        if (typeof out !== "string") return;
        run(() => createPatch(path, row.oid, out), "Patch created");
      };

      // §5.3 lists reset among the entry points a paused operation refuses: a
      // reset out from under a conflicted merge is how the index gets orphaned.
      const doReset = (mode: ResetMode) =>
        run(async () => {
          await requireNoPausedOperation(path, `reset ${head} to ${short}`);
          return resetTo(path, row.oid, mode);
        }, `Reset (${mode})`);

      const items: MenuItem[] = [];
      if (localBadge) {
        items.push(
          {
            label: `Checkout ${localBadge.name}`,
            onClick: () => run(() => smartCheckout(path, localBadge.name), `Checked out ${localBadge.name}`),
          },
          // Offered right beside Checkout, because a worktree is the answer to
          // the same question that does not disturb the tree you are in (G18).
          {
            label: `Open ${localBadge.name} in worktree…`,
            onClick: () => createWorktreeFlow(localBadge.name, localBadge.name),
          },
        );
      }
      items.push(
        { label: "Checkout this commit", onClick: () => run(() => smartCheckout(path, row.oid), "Checked out commit") },
        { label: "Create worktree from this commit", onClick: () => createWorktreeFlow(row.oid, short) },
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
          // STATUS B8: with a multi-select, the plan is the selection's own
          // range — `<oldest selected>^..HEAD` — not `<clicked>..HEAD`. The
          // two agree only when the selection happens to end at HEAD, which
          // is why the bug was easy to miss.
          label:
            chosenRows.length > 1
              ? `Interactive rebase ${chosenRows.length} selected commits`
              : `Interactive rebase ${head} onto this commit`,
          // The oldest selected commit's parent is the base: rebasing *onto*
          // the oldest selection itself would leave it out of the plan.
          disabled: chosenRows.length > 1 && !oldestSelected?.parents[0],
          onClick: () =>
            setRebasePlan({
              base:
                chosenRows.length > 1
                  ? (oldestSelected?.parents[0] ?? row.oid)
                  : row.oid,
            }),
        },
        {
          label: `Reset ${head} to this commit`,
          submenu: [
            { label: "Soft (keep index & working tree)", onClick: () => doReset("soft") },
            { label: "Mixed (keep working tree)", onClick: () => doReset("mixed") },
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
                  doReset("hard");
                }
              },
            },
          ],
        },
        {
          label: "Revert commit",
          onClick: () =>
            run(async () => {
              await requireNoPausedOperation(path, `revert ${short}`);
              reportConflicts("revert", await revertCommit(path, row.oid), "Reverted");
            }),
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
            // A sheet on the detail stack, not a modal: the commit you were
            // reading stays underneath and Back returns to it (G24).
            pushDetail({
              kind: "compare",
              oldOid: chosenRows[1].oid,
              newOid: chosenRows[0].oid,
            }),
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
    [repo, qc, pushToast, originUrl, rows, selectedOids, selectOid],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  // Pull the next page in as the viewport approaches the loaded tail.
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisible = virtualItems[virtualItems.length - 1]?.index ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastVisible >= visibleRows.length - PREFETCH_MARGIN) {
      void fetchNextPage();
    }
  }, [lastVisible, visibleRows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Changes column (G16): counts for the rows actually on screen.
  //
  // Per-window rather than per-page, and only when the column is on, because
  // it is a diff per commit — the one column in the set that is not free.
  // Rounding the window to a block keeps the key stable while the user drags
  // the scrollbar a few pixels, which would otherwise be a fetch per frame.
  const wantsStats = columns.includes("changes");
  const statsWindow = useMemo(() => {
    if (!wantsStats || !virtualItems.length) return [] as string[];
    const block = 50;
    const from = Math.max(0, Math.floor(virtualItems[0].index / block) * block);
    const to = Math.min(
      visibleRows.length,
      Math.ceil((virtualItems[virtualItems.length - 1].index + 1) / block) * block,
    );
    return visibleRows.slice(from, to).map((row) => row.oid);
  }, [wantsStats, virtualItems, visibleRows]);

  const { data: statsData } = useQuery({
    queryKey: ["commitStats", repo?.path, statsWindow.join(",")],
    enabled: !!repo && statsWindow.length > 0,
    queryFn: () => commitStats(repo!.path, statsWindow),
    staleTime: Infinity,
  });
  const statsByOid = useMemo(
    () => new Map((statsData ?? []).map((entry) => [entry.oid, entry] as const)),
    [statsData],
  );

  // Filter mode is only truthful once the whole history is loaded: a hit on a
  // page nobody has scrolled to is not "filtered out", it is unfetched — and
  // the footer's "showing 37 of 12,481" would be counting our own laziness.
  useEffect(() => {
    if (filtering && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [filtering, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const maxLane = visibleRows.reduce((m, r) => {
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
    const last = Math.min(visibleRows.length - 1, Math.ceil((scrollTop + ch) / ROW_HEIGHT) + 1);

    // Filter mode hides rows, so consecutive rows are no longer parent and
    // child: drawing the edge band between them would assert a parentage that
    // does not exist. Nodes only, until the filter is lifted.
    if (!filtering) {
      for (let i = first; i <= last; i++) {
        const row = visibleRows[i];
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
    }

    for (let i = first; i <= last; i++) {
      const row = visibleRows[i];
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
  }, [visibleRows, gutterWidth, laneX, selectedOid, filtering]);

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
      if (visibleRows.length === 0) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      ev.preventDefault();
      const idx = visibleRows.findIndex((r) => r.oid === selectedOid);
      const next =
        ev.key === "ArrowDown"
          ? Math.min(visibleRows.length - 1, idx < 0 ? 0 : idx + 1)
          : Math.max(0, idx < 0 ? 0 : idx - 1);
      selectOid(visibleRows[next].oid);
      virtualizer.scrollToIndex(next, { align: "auto" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleRows, selectedOid, selectOid, virtualizer]);

  // Live values for `navigateHits`, which awaits page fetches and would
  // otherwise read the rows as they were when the keystroke landed.
  const live = useRef({ rows, visibleRows, filtering, hasNextPage });
  live.current = { rows, visibleRows, filtering, hasNextPage };

  /**
   * Step to the next/previous hit, loading the page it lives on first.
   *
   * The backend searches the whole history, so a hit can be thousands of rows
   * past anything fetched (§4). Refusing to navigate to a hit we just counted
   * would be worse than not counting it.
   */
  const navigateHits = useCallback(
    async (delta: number) => {
      const path = repo?.path;
      if (!path) return;
      const store = useSearch.getState();
      const at = store.step(path, delta);
      if (at < 0) return;
      const hit = store.get(path).hits[at];
      if (!hit) return;
      selectOid(hit.oid);
      if (hit.index === null) {
        pushToast("info", `${hit.oid.slice(0, 7)} is not in the graph — a stash, or a commit no ref reaches.`);
        return;
      }
      let guard = 0;
      while (hit.index >= live.current.rows.length && live.current.hasNextPage && guard++ < 200) {
        const next = await fetchNextPage();
        live.current.rows = next.data?.pages.flatMap((page) => page.rows) ?? live.current.rows;
        live.current.hasNextPage = next.hasNextPage;
      }
      const displayIndex = live.current.filtering
        ? live.current.visibleRows.findIndex((row) => row.oid === hit.oid)
        : hit.index;
      if (displayIndex >= 0) virtualizer.scrollToIndex(displayIndex, { align: "center" });
    },
    [repo?.path, selectOid, pushToast, fetchNextPage, virtualizer],
  );

  /**
   * Reveal a commit someone else named (G19: a terminal link).
   *
   * Same problem `navigateHits` solves, from a different direction: the oid
   * may be thousands of rows past what is loaded, so pages are pulled until
   * it turns up. Filter mode is left as it is — a reveal that silently
   * dropped the user's filter would be a worse surprise than a scroll that
   * cannot land — and the toast says so.
   */
  useEffect(() => {
    const onReveal = async (event: Event) => {
      const oid = (event as CustomEvent<string>).detail;
      const path = repo?.path;
      if (!oid || !path) return;
      selectOid(oid);
      let guard = 0;
      while (
        !live.current.rows.some((row) => row.oid === oid) &&
        live.current.hasNextPage &&
        guard++ < 200
      ) {
        const next = await fetchNextPage();
        live.current.rows = next.data?.pages.flatMap((page) => page.rows) ?? live.current.rows;
        live.current.hasNextPage = next.hasNextPage;
      }
      const index = live.current.filtering
        ? live.current.visibleRows.findIndex((row) => row.oid === oid)
        : live.current.rows.findIndex((row) => row.oid === oid);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: "center" });
      } else if (live.current.filtering) {
        pushToast("info", `${oid.slice(0, 7)} is filtered out — clear the search to see it.`);
      } else {
        pushToast("info", `${oid.slice(0, 7)} is not in this graph — no ref reaches it.`);
      }
    };
    window.addEventListener(REVEAL_COMMIT_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_COMMIT_EVENT, onReveal);
  }, [repo?.path, selectOid, fetchNextPage, virtualizer, pushToast]);

  // F3 / ⌘G and their reverses, plus the two ways into the field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Previous before next: both are F3-shaped and the shifted one is the
      // more specific match, so testing next first would swallow it.
      if (matches(event, "search.prev")) {
        event.preventDefault();
        void navigateHits(-1);
        return;
      }
      if (matches(event, "search.next")) {
        event.preventDefault();
        void navigateHits(1);
        return;
      }
      // The bound chord works from anywhere; the sidebar's ⌘F also reaches the
      // search while the graph has focus, because two panes cannot both own
      // one chord and focus is the tiebreak (`08-search-and-filter.md` §2).
      const graphFocused = !!document.activeElement?.closest(".graph-container");
      if (matches(event, "search.focus") || (graphFocused && matches(event, "sidebar.filter"))) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("mtgit:focus-search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigateHits]);

  // Select mode hands every hit to the range operations (cherry-pick a search
  // result, plan a rebase over one) without a click per row.
  useEffect(() => {
    if (search.mode === "select" && search.submitted && search.hits.length > 0) {
      setSelectedOids(new Set(search.hits.map((hit) => hit.oid)));
    }
  }, [search.mode, search.submitted, search.hits]);

  // B5: entering filter mode changes neither selection nor scroll, and leaving
  // it puts both back exactly.
  const lastMode = useRef(search.mode);
  useEffect(() => {
    const path = repo?.path;
    if (!path) return;
    const store = useSearch.getState();
    if (lastMode.current !== "filter" && search.mode === "filter") {
      store.patch(path, {
        restore: { oid: selectedOid, scrollTop: parentRef.current?.scrollTop ?? 0 },
      });
    } else if (lastMode.current === "filter" && search.mode !== "filter") {
      const restore = store.get(path).restore;
      if (restore) {
        selectOid(restore.oid);
        requestAnimationFrame(() => {
          if (parentRef.current) parentRef.current.scrollTop = restore.scrollTop;
        });
        store.patch(path, { restore: null });
      }
    }
    lastMode.current = search.mode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.mode]);

  // HEAD moved: scroll to it, and flash the row (STATUS §4).
  //
  // The scroll alone was the load-bearing half, but on a long history it looks
  // identical to not having moved — the row you land on is centred either way.
  // The flash is what says "this is the one that changed". Skipped on first
  // paint: opening a repository is not a checkout, and a flash on load reads
  // as a glitch.
  const seenHead = useRef<string | null>(null);
  useEffect(() => {
    if (!headOid) return;
    const index = visibleRows.findIndex((row) => row.oid === headOid);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
    if (seenHead.current && seenHead.current !== headOid) {
      setFlashOid(headOid);
      const timer = setTimeout(() => setFlashOid(null), 1200);
      seenHead.current = headOid;
      return () => clearTimeout(timer);
    }
    seenHead.current = headOid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headOid]);

  if (!repo) {
    return <div className="graph-empty">Open a repository to view its history.</div>;
  }
  if (isPending) {
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

  const currentWip = (wips ?? []).find((wip) => wip.isCurrent);
  const otherWips = (wips ?? []).filter((wip) => !wip.isCurrent);

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
    // Gives the pane focus, which is what decides who owns ⌘F.
    parentRef.current?.focus({ preventScroll: true });
  };

  /**
   * Right-clicking a ref pill acts on the *ref* (STATUS B1).
   *
   * It used to fall through to the commit menu, which made push, rename,
   * delete and merge-from-here sidebar-only — and the graph is where most
   * people point at a branch. The entries mirror the sidebar's deliberately:
   * two menus for one object that disagree about what you can do to it is
   * worse than either.
   */
  const refContextMenu = useCallback(
    (event: React.MouseEvent, ref: RefBadge) => {
      event.preventDefault();
      event.stopPropagation();
      if (!repo) return;
      const path = repo.path;
      const head = repo.head.branch ?? "HEAD";
      const run = async (fn: () => Promise<unknown>, ok?: string) => {
        try {
          await fn();
          if (ok) pushToast("success", ok);
          await refreshRepo(qc, path);
        } catch (err) {
          toastError(err);
        }
      };

      const items: MenuItem[] = [];
      if (ref.kind === "tag") {
        items.push(
          { label: "Copy tag name", onClick: () => copyText(ref.name) },
          {
            label: "Push tag to origin",
            onClick: () =>
              run(async () => {
                const result = await gitNetwork(path, "push", "origin", [`refs/tags/${ref.name}`]);
                if (!result.success) throw new Error(result.output);
              }, `Pushed tag ${ref.name}`),
          },
          { separator: true },
          {
            label: "Delete tag",
            danger: true,
            onClick: async () => {
              if (
                await confirmDialog({
                  title: "Delete tag",
                  message: `Delete tag "${ref.name}"?`,
                  confirmLabel: "Delete",
                  danger: true,
                })
              ) {
                void run(() => deleteTag(path, ref.name), "Tag deleted");
              }
            },
          },
        );
        setMenu({ x: event.clientX, y: event.clientY, items });
        return;
      }

      const isLocal = ref.kind === "localBranch";
      items.push(
        {
          label: `Checkout ${ref.name}`,
          disabled: ref.isHead,
          onClick: () => run(() => smartCheckout(path, ref.name), `Checked out ${ref.name}`),
        },
        {
          label: "Show only this in the graph",
          onClick: () => {
            seedSearch(path, `ref:${ref.name}`, true);
            useSearch.getState().setMode(path, "filter");
          },
        },
        { separator: true },
        {
          label: `Merge ${ref.name} into ${head}`,
          disabled: ref.isHead,
          onClick: () =>
            run(async () => {
              await requireNoPausedOperation(path, `merge ${ref.name}`);
              const result = await mergeAdvanced(path, ref.name, "noFf");
              if (result.kind === "conflicts") {
                pushToast("error", `Merge paused — ${result.conflicts.length} conflicted file(s).`);
              } else {
                pushToast("success", `Merged ${ref.name}.`);
              }
            }),
        },
        {
          label: `Rebase ${head} onto ${ref.name}`,
          disabled: ref.isHead,
          onClick: () =>
            run(async () => {
              await requireNoPausedOperation(path, `rebase onto ${ref.name}`);
              const result = await rebaseStandard(path, ref.name);
              if (result.success) pushToast("success", `Rebased onto ${ref.name}.`);
              else pushToast("error", `Rebase paused — ${result.conflicts.length} conflicted file(s).`);
            }),
        },
      );

      if (isLocal) {
        items.push(
          { separator: true },
          {
            label: `Push ${ref.name}`,
            onClick: () =>
              run(async () => {
                const result = await gitNetwork(path, "push", "origin", [ref.name]);
                if (!result.success) throw new Error(result.output);
              }, `Pushed ${ref.name}`),
          },
          {
            label: "Rename…",
            onClick: async () => {
              const next = await promptDialog({
                title: "Rename branch",
                label: "New branch name",
                defaultValue: ref.name,
                confirmLabel: "Rename",
                validate: validateRefName,
              });
              if (next && next !== ref.name) void run(() => renameBranch(path, ref.name, next), "Renamed");
            },
          },
          {
            label: "Delete branch",
            danger: true,
            disabled: ref.isHead,
            onClick: async () => {
              if (
                await confirmDialog({
                  title: "Delete branch",
                  message: `Delete the local branch "${ref.name}"?`,
                  confirmLabel: "Delete",
                  danger: true,
                })
              ) {
                void run(() => deleteBranch(path, ref.name, false), `Deleted ${ref.name}`);
              }
            },
          },
        );
      }
      items.push({ separator: true }, { label: "Copy ref name", onClick: () => copyText(ref.name) });
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [repo, qc, pushToast],
  );

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
        // The checkout below gates itself, but it only happens when the target
        // is not already HEAD — so the drop needs its own refusal too (§5.3).
        await requireNoPausedOperation(repo.path, action === "rebase" ? `rebase ${target}` : `merge ${source}`);
        if (repo.head.branch !== target) await smartCheckout(repo.path, target);
        if (action === "rebase") {
          const result = await rebaseStandard(repo.path, source);
          if (result.success) {
            pushToast("success", `Rebased ${target} onto ${source}.`);
          } else {
            pushToast("error", `Rebase paused — ${result.conflicts.length} conflicted file(s).`);
          }
        } else {
          const result = await mergeAdvanced(repo.path, source, action === "ff" ? "ffOnly" : "noFf");
          if (result.kind === "conflicts") {
            pushToast("error", `Merge paused — ${result.conflicts.length} conflicted file(s).`);
          } else {
            pushToast("success", action === "ff" ? `Fast-forwarded ${target} to ${source}.` : `Merged ${source} into ${target}.`);
          }
        }
        await refreshRepo(qc, repo.path);
      } catch (error) {
        toastError(error);
      }
    };
    // Coordinates are read before the await: React pools nothing here, but the
    // event object is gone by the time the relation lands.
    const { clientX, clientY } = event;
    void mergeRelation(repo.path, target, source)
      .catch(() => null)
      .then((relation) =>
        setMenu({
          x: clientX,
          y: clientY,
          items: dropMenuItems(target, source, relation, runDrop),
        }),
      );
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
        {columns.map((id) => (
          <div key={id} className={`gh-col col-${id}`}>
            {COLUMN_LABELS[id]}
          </div>
        ))}
        {repo && (
          <SearchBar
            repoPath={repo.path}
            pageSize={PAGE_SIZE}
            disabled={total === 0}
            disabledReason="Nothing to search — this repository has no commits yet."
            onNavigate={(delta) => void navigateHits(delta)}
          />
        )}
        <button className="gh-gear" title="Graph options" onClick={() => setGearOpen((v) => !v)}>
          <Icon name="gear" />
        </button>
        {gearOpen && (
          <div className="gh-gear-pop" onMouseLeave={() => setGearOpen(false)}>
            <label>
              <input
                type="checkbox"
                checked={dateStyle === "relative"}
                onChange={(e) =>
                  useSettings.getState().set({ dateStyle: e.target.checked ? "relative" : "absolute" })
                }
              />
              Relative dates
            </label>
            <div className="gh-gear-sep">Columns</div>
            <ColumnManager columns={columns} />
          </div>
        )}
      </div>

      {(search.submitted || search.error) && (
        <div className={`graph-searchbar-notes${search.error ? " error" : ""}`}>
          {search.error ? (
            <span>{search.error}</span>
          ) : (
            <>
              {search.running && <span>Searching…</span>}
              {!search.running && search.hits.length === 0 && (
                <span>No commits {search.summary}.</span>
              )}
              {filtering && search.hits.length > 0 && (
                <span>
                  Showing {visibleRows.length.toLocaleString()} of {total.toLocaleString()} commits
                  {hasNextPage ? " (loading the rest of the history…)" : ""} — topology is not
                  continuous.
                </span>
              )}
              {search.truncated && (
                <span>
                  Stopped at the first {search.hits.length.toLocaleString()} matches.{" "}
                  <button onClick={() => window.dispatchEvent(new CustomEvent("mtgit:search-more"))}>
                    Keep going
                  </button>
                </span>
              )}
              {search.cancelled && <span>Cancelled — these are partial results.</span>}
              {search.notes.map((note) => (
                <span key={note}>{note}</span>
              ))}
            </>
          )}
        </div>
      )}

      {status?.isDirty && (
        <WipRowView
          lane={currentWip?.lane ?? 0}
          color={currentWip?.color ?? 0}
          gutter={gutterWidth}
          laneX={laneX}
          // The count comes from `status`, not from `wip_rows`: this is the
          // row the staging view sits behind, and the two must not disagree.
          changed={dirtyCount}
          // Named only when a second WIP row is on screen — with one row
          // there is nothing to tell apart (overview §1.1).
          worktree={otherWips.length ? currentWip?.worktree : undefined}
          branch={repo.head.branch}
          selected={selectedOid === WORKING}
          onClick={() => selectOid(WORKING)}
        />
      )}
      {otherWips.map((wip) => (
        <WipRowView
          key={wip.path}
          lane={wip.lane}
          color={wip.color}
          gutter={gutterWidth}
          laneX={laneX}
          changed={wip.changed}
          worktree={wip.worktree}
          branch={wip.branch}
          other
          title={`${wip.path} — open this worktree in a tab`}
          // Another worktree's uncommitted work cannot be staged from here:
          // this tab's index is a different index. Opening it as its own tab
          // is the only honest action, and it is the one G18 is built around.
          onClick={() => openRepo(wip.path).then(setRepo).catch(toastError)}
        />
      ))}
      <div className="graph-body">
      <div className="graph-scroll" ref={parentRef} tabIndex={-1}>
        <div className="graph-inner" style={{ height: virtualizer.getTotalSize() }}>
          <canvas className="graph-canvas" ref={canvasRef} style={{ marginLeft: BRANCH_COL_WIDTH }} />
          {virtualItems.map((vi) => {
            const row = visibleRows[vi.index];
            return (
              <GraphRowView
                key={row.oid}
                row={row}
                repoPath={repo.path}
                top={vi.start}
                gutter={gutterWidth}
                nodeLeft={BRANCH_COL_WIDTH + laneX(row.lane)}
                selected={row.oid === selectedOid || selectedOids.has(row.oid)}
                hit={hitOids.has(row.oid)}
                flash={row.oid === flashOid}
                currentHit={row.oid === currentHitOid}
                onSearchAuthor={() =>
                  repo && seedSearch(repo.path, `author:${row.email || row.author}`)
                }
                columns={columns}
                stats={statsByOid.get(row.oid)}
                opts={{ relativeDates: dateStyle === "relative" }}
                onSelect={(event) => selectRow(event, row)}
                onContextMenu={(e) => rowContextMenu(e, row)}
                onCheckoutRef={(name) =>
                  repo &&
                  smartCheckout(repo.path, name)
                    .then(() => {
                      pushToast("success", `Checked out ${name}.`);
                      return refreshRepo(qc, repo.path);
                    })
                    .catch(toastError)
                }
                onRefDrop={dropOnRef}
                onRefContextMenu={refContextMenu}
                hiddenRefs={hiddenRefs}
                checkoutTarget={checkoutTarget}
              />
            );
          })}
        </div>
        {hasNextPage && (
          <div className="graph-more">
            {isFetchingNextPage
              ? "Loading more history…"
              : `${rows.length.toLocaleString()} of ${total.toLocaleString()} commits`}
          </div>
        )}
      </div>
      {/* The minimap only exists while a search does: it answers "where in
          the history are my matches clustered", which is not a question with
          an answer when nothing is searched for. */}
      {search.submitted && search.hits.length > 0 && (
        <SearchMinimap
          total={total}
          hits={search.hits}
          cursor={search.cursor}
          onJump={(index) => {
            const at = search.hits.findIndex((hit) => hit.index === index);
            if (at >= 0) void navigateHits(at - search.cursor);
          }}
        />
      )}
      <ScrollMarkers
        total={total}
        hits={search.hits}
        cursor={search.cursor}
        headIndex={rows.findIndex((row) => row.oid === headOid)}
        selectedIndex={rows.findIndex((row) => row.oid === selectedOid)}
      />
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
    </div>
  );
}

/**
 * A worktree's uncommitted work, drawn on its own lane (G18, and STATUS §4's
 * "WIP row is not on the lane").
 *
 * It stays a strip above the scroll container rather than becoming a virtual
 * row: it is not a commit, and putting it in the row list would shift every
 * index `searchCommits` reports as a page hint.
 */
function WipRowView({
  lane,
  color,
  gutter,
  laneX,
  changed,
  worktree,
  branch,
  selected,
  other,
  title,
  onClick,
}: {
  lane: number;
  color: number;
  gutter: number;
  laneX: (lane: number) => number;
  changed: number;
  worktree?: string;
  branch?: string | null;
  selected?: boolean;
  /** A worktree other than this tab's: dimmed, and clicking opens it. */
  other?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <div
      className={`wip-row${selected ? " selected" : ""}${other ? " other" : ""}`}
      onClick={onClick}
      title={title}
    >
      <div className="wip-refs" style={{ width: BRANCH_COL_WIDTH }}>
        {worktree && (
          <span className="wip-worktree">
            <Icon name="worktree" size={11} /> {worktree}
            {branch ? ` · ${branch}` : ""}
          </span>
        )}
      </div>
      <div className="wip-lane" style={{ width: gutter }}>
        <span
          className="wip-dot"
          style={{ left: laneX(lane) - 6, borderColor: laneColor(color) }}
        />
      </div>
      <span className="wip-label" style={{ color: laneColor(color) }}>
        // WIP
      </span>
      <span className="wip-count">
        <Icon name="pencil" size={11} /> {changed} changed file{changed === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function GraphRowView({
  row,
  repoPath,
  top,
  gutter,
  nodeLeft,
  selected,
  hit,
  currentHit,
  flash,
  onSearchAuthor,
  columns,
  stats,
  opts,
  onSelect,
  onContextMenu,
  onCheckoutRef,
  onRefDrop,
  onRefContextMenu,
  hiddenRefs,
  checkoutTarget,
}: {
  row: GraphRow;
  repoPath: string;
  top: number;
  gutter: number;
  nodeLeft: number;
  selected: boolean;
  hit: boolean;
  currentHit: boolean;
  flash: boolean;
  onSearchAuthor: () => void;
  columns: GraphColumnId[];
  stats: CommitStats | undefined;
  opts: { relativeDates: boolean };
  onSelect: (event: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onCheckoutRef: (name: string) => void;
  onRefDrop: (event: React.DragEvent, target: string, isHead: boolean) => void;
  onRefContextMenu: (event: React.MouseEvent, ref: RefBadge) => void;
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
      className={`graph-row${selected ? " selected" : ""}${hit ? " hit" : ""}${
        currentHit ? " current-hit" : ""
      }${flash ? " flash" : ""}`}
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
            onContextMenu={(event) => onRefContextMenu(event, r)}
          >
            {r.kind === "tag" && <Icon name="tag" size={11} />}
            {r.isHead && <Icon name="check" size={11} />}
            {(r.kind === "remoteBranch" ||
              (r.kind === "localBranch" && collapsedRemotes.has(r.name))) && (
              <Icon name="cloud" size={11} />
            )}
            {checkoutTarget === r.name && <Icon name="pending" size={11} />}
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
      {/* Sync markers (G23, `03-push.md` §7). A dot beside the node rather
          than a column: the question is "is this one of mine", which is asked
          while looking at the graph, not while reading a column. */}
      {(row.unpushed || row.unpulled) && (
        <span
          className={`row-sync ${row.unpushed ? "unpushed" : "unpulled"}`}
          style={{ left: nodeLeft + AVATAR_SIZE / 2 + 2 }}
          title={row.unpushed ? "Not yet pushed to the upstream" : "On the upstream, not yet pulled"}
        >
          <Icon name={row.unpushed ? "push" : "pull"} size={9} />
        </span>
      )}
      <span className="row-summary">
        {/* Issue references are links here too (G20): the graph is where most
            people read a message, and a reference you can only follow from the
            detail panel is one you mostly do not follow. */}
        <Autolinked repoPath={repoPath} text={row.summary} />
      </span>
      {columns.map((id) => (
        <span key={id} className={`row-col col-${id}`}>
          {id === "author" && (
            <span
              className="row-author"
              title={`${row.author} — right-click to search this author's commits`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSearchAuthor();
              }}
            >
              {row.author}
            </span>
          )}
          {id === "changes" &&
            (stats ? (
              <span className="row-changes" title={`${stats.files} file(s) changed`}>
                <b>{stats.files}</b>
                <span className="diff-stat add">+{stats.additions}</span>
                <span className="diff-stat del">−{stats.deletions}</span>
              </span>
            ) : (
              /* A dash, not a zero: the counts are fetched per visible window
                 and "not loaded yet" is not "changed nothing". */
              <span className="row-changes pending">–</span>
            ))}
          {id === "date" && (
            <span title={formatTimestamp(row.timestamp)}>
              {opts.relativeDates ? timeAgo(row.timestamp) : formatTimestamp(row.timestamp)}
            </span>
          )}
          {id === "sha" && <span className="row-oid">{row.oid.slice(0, 7)}</span>}
        </span>
      ))}
    </div>
  );
}

const COLUMN_LABELS: Record<GraphColumnId, string> = {
  author: "AUTHOR",
  changes: "CHANGES",
  date: "DATE",
  sha: "SHA",
};

const ALL_COLUMNS: GraphColumnId[] = ["author", "changes", "date", "sha"];

/**
 * The column manager in the graph's gear popover (G16).
 *
 * Reorder is ▲/▼ rather than drag-and-drop on purpose: the popover is 200px
 * wide, drag inside it would fight the graph's own row dragging, and four
 * items do not need a gesture. The list shows *all* columns with a checkbox,
 * so a disabled one is still reachable — a manager that only listed enabled
 * columns would give no way to get a removed one back.
 */
function ColumnManager({ columns }: { columns: GraphColumnId[] }) {
  const setColumns = (next: GraphColumnId[]) => useSettings.getState().set({ graphColumns: next });
  const off = ALL_COLUMNS.filter((id) => !columns.includes(id));

  return (
    <div className="gh-columns">
      {columns.map((id, i) => (
        <div key={id} className="gh-column-row">
          <label>
            <input
              type="checkbox"
              checked
              onChange={() => setColumns(columns.filter((c) => c !== id))}
            />
            {COLUMN_LABELS[id]}
          </label>
          <button
            disabled={i === 0}
            title="Move left"
            onClick={() => setColumns(swap(columns, i, i - 1))}
          >
            ▲
          </button>
          <button
            disabled={i === columns.length - 1}
            title="Move right"
            onClick={() => setColumns(swap(columns, i, i + 1))}
          >
            ▼
          </button>
        </div>
      ))}
      {off.map((id) => (
        <div key={id} className="gh-column-row off">
          <label>
            <input type="checkbox" checked={false} onChange={() => setColumns([...columns, id])} />
            {COLUMN_LABELS[id]}
          </label>
        </div>
      ))}
    </div>
  );
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/**
 * Scroll-gutter markers (G17): hits, HEAD and the selection at their
 * proportional positions in the whole history.
 *
 * A prerequisite for search rather than a garnish — a hit 8,000 rows down is
 * otherwise invisible, and "37 results" with nothing to aim at is half a
 * feature. Positions are fractions of `total` (every commit), not of the rows
 * loaded so far, so a marker does not slide as pages arrive.
 */
/**
 * The on-search minimap (G17), beside the marker gutter.
 *
 * It is a *density* strip, not a scaled-down graph: at 12,000 commits in
 * 600px of height each pixel row is twenty commits, so drawing one mark per
 * hit loses every cluster to overlap. Bucketing and shading by count is the
 * only rendering at that scale that says anything — "the matches are all in
 * one place near the top" is the answer the strip exists to give.
 *
 * Clicking a bucket navigates to its first hit rather than scrolling to the
 * offset: the user is looking for a match, and landing near one but not on it
 * would leave them hunting.
 */
function SearchMinimap({
  total,
  hits,
  cursor,
  onJump,
}: {
  total: number;
  hits: SearchHit[];
  cursor: number;
  onJump: (index: number) => void;
}) {
  const BUCKETS = 60;
  const buckets = useMemo(() => {
    const counts = new Array<number>(BUCKETS).fill(0);
    const first = new Array<number>(BUCKETS).fill(-1);
    for (const hit of hits) {
      if (hit.index === null) continue;
      const b = Math.min(BUCKETS - 1, Math.floor((hit.index / Math.max(1, total)) * BUCKETS));
      counts[b] += 1;
      if (first[b] < 0 || hit.index < first[b]) first[b] = hit.index;
    }
    return { counts, first, peak: Math.max(1, ...counts) };
  }, [hits, total]);

  const currentBucket =
    cursor >= 0 && hits[cursor]?.index != null
      ? Math.min(BUCKETS - 1, Math.floor((hits[cursor].index! / Math.max(1, total)) * BUCKETS))
      : -1;

  return (
    <div className="graph-minimap" title={`${hits.length} match(es) across the history`}>
      {buckets.counts.map((count, i) => (
        <button
          key={i}
          className={`mm-bucket${i === currentBucket ? " current" : ""}`}
          disabled={count === 0}
          style={count ? { opacity: 0.25 + 0.75 * (count / buckets.peak) } : undefined}
          title={count ? `${count} match(es) here` : undefined}
          onClick={() => buckets.first[i] >= 0 && onJump(buckets.first[i])}
        />
      ))}
    </div>
  );
}

function ScrollMarkers({
  total,
  hits,
  cursor,
  headIndex,
  selectedIndex,
}: {
  total: number;
  hits: SearchHit[];
  cursor: number;
  headIndex: number;
  selectedIndex: number;
}) {
  if (total === 0) return null;
  // One marker per hit is unreadable past a few hundred and costs a DOM node
  // each; sample instead, and keep the current hit whatever the sampling says.
  const stride = Math.ceil(hits.length / MAX_MARKERS);
  const sampled = hits.filter((hit, i) => i % stride === 0 && hit.index !== null);
  const current = cursor >= 0 ? hits[cursor] : undefined;
  const pct = (index: number) => `${(index / total) * 100}%`;

  return (
    <div className="graph-gutter">
      {headIndex >= 0 && <span className="graph-mark head" style={{ top: pct(headIndex) }} title="HEAD" />}
      {selectedIndex >= 0 && (
        <span className="graph-mark selection" style={{ top: pct(selectedIndex) }} title="Selected commit" />
      )}
      {sampled.map((hit) => (
        <span key={hit.oid} className="graph-mark hit" style={{ top: pct(hit.index!) }} />
      ))}
      {current?.index != null && (
        <span className="graph-mark current" style={{ top: pct(current.index) }} title="Current hit" />
      )}
    </div>
  );
}
