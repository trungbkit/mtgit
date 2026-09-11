import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createBranch,
  createPatch,
  createTag,
  createWorktree,
  getGraph,
  getRemoteUrl,
  getStatus,
  openRepo,
  wipRows,
  mergeAdvanced,
  rebaseStandard,
  rewriteInfo,
  resetTo,
  revertCommit,
} from "../../ipc/commands";
import type { GraphRow, SearchHit } from "../../ipc/types";
import type { RebaseAction, ResetMode } from "../../ipc/types";
import { REVEAL_COMMIT_EVENT } from "../../stores/reveal";
import { useSession, WORKING } from "../../stores/session";
import { seedSearch, useRepoSearch, useSearch } from "../../stores/search";
import { toastError, useToasts } from "../../stores/toasts";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
import { type ConflictKind, conflictLabel } from "../../stores/conflict";
import { confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { Avatar } from "../../components/Avatar";
import { copyText } from "../../lib/clipboard";
import { smartCheckout } from "../../lib/checkout";
import { timeAgo, formatTimestamp } from "../../lib/time";
import { Icon } from "../../components/Icon";
import { matches } from "../../lib/keys";
import { useSettings } from "../../stores/settings";
import { laneColor } from "./palette";
import { CherryPickPopover } from "./CherryPickPopover";
import { RebasePlanDialog } from "./RebasePlanDialog";
import { CompareDialog } from "./CompareDialog";
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
  const graphOpts = useSession((s) => s.graphOpts);
  // One date style for the whole app, persisted — not a per-session toggle.
  const dateStyle = useSettings((s) => s.settings.dateStyle);
  const setGraphOpts = useSession((s) => s.setGraphOpts);
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
      const refresh = () => refreshRepo(qc, path);
      const run = async (fn: () => Promise<unknown>, ok?: string) => {
        try {
          await fn();
          if (ok) pushToast("success", ok);
          await refresh();
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
                ? pushToast("success", `Rebased ${info.commits} commit(s)`)
                : reportConflicts("rebase", result, ""),
            ),
          );
        } catch (error) {
          toastError(error);
        }
      };

      /**
       * `target` is a branch name when the row carries one, and the commit
       * oid otherwise. The backend resolves both (`core/worktree.rs::add`):
       * a branch is attached as-is, an oid gets a new branch named `name`.
       */
      const createWorktreeFlow = async (target: string, label: string) => {
        const name = await promptDialog({
          title: `Open ${label} in a worktree`,
          label: "Worktree folder / branch name",
          defaultValue: target === row.oid ? "" : target.split("/").pop() ?? "",
          confirmLabel: "Choose location…",
          validate: validateRefName,
        });
        if (!name) return;
        const parent = await openDialog({ directory: true, title: "Choose worktree location" });
        if (typeof parent !== "string") return;
        const wtPath = `${parent}/${name}`;
        run(async () => {
          await createWorktree(path, name, wtPath, target);
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
          label: `Interactive rebase ${head} onto this commit`,
          onClick: () => setRebasePlan({ base: row.oid }),
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

  useEffect(() => {
    if (!headOid) return;
    const index = visibleRows.findIndex((row) => row.oid === headOid);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
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
                top={vi.start}
                gutter={gutterWidth}
                nodeLeft={BRANCH_COL_WIDTH + laneX(row.lane)}
                selected={row.oid === selectedOid || selectedOids.has(row.oid)}
                hit={hitOids.has(row.oid)}
                currentHit={row.oid === currentHitOid}
                onSearchAuthor={() =>
                  repo && seedSearch(repo.path, `author:${row.email || row.author}`)
                }
                opts={{ relativeDates: dateStyle === "relative", showAuthor: graphOpts.showAuthor }}
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
  top,
  gutter,
  nodeLeft,
  selected,
  hit,
  currentHit,
  onSearchAuthor,
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
  hit: boolean;
  currentHit: boolean;
  onSearchAuthor: () => void;
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
      className={`graph-row${selected ? " selected" : ""}${hit ? " hit" : ""}${
        currentHit ? " current-hit" : ""
      }`}
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
      <span className="row-summary">{row.summary}</span>
      {opts.showAuthor && (
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
      <span className="row-date" title={formatTimestamp(row.timestamp)}>
        {opts.relativeDates ? timeAgo(row.timestamp) : formatTimestamp(row.timestamp)}
      </span>
      <span className="row-oid">{row.oid.slice(0, 7)}</span>
    </div>
  );
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
