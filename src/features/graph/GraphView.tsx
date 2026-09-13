import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  commitStats,
  containingRefs,
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
  worktreeHolding,
  mergeAdvanced,
  mergeRelation,
  rebaseStandard,
  rewriteInfo,
  resetTo,
  revertCommit,
} from "../../ipc/commands";
import type {
  CommitStats,
  GhostRef,
  GraphColumnId,
  GraphRow,
  RefBadge,
  SearchHit,
  WorktreeInfo,
} from "../../ipc/types";
import type { RebaseAction, ResetMode } from "../../ipc/types";
import { REVEAL_COMMIT_EVENT, revealCommit } from "../../stores/reveal";
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
import { isCancelled, smartCheckout } from "../../lib/checkout";
import { announcePush, PUSH_FLASH_EVENT } from "../network/net";
import { dropMenuItems } from "../../lib/dropMenu";
import { justPushed, planRefPills } from "../../lib/refPills";
import { runCherryPick } from "../../lib/cherryPick";
import { captureUndoPoint, toastWithUndo } from "../../lib/undoToast";
import { timeAgo, formatTimestamp } from "../../lib/time";
import { Icon } from "../../components/Icon";
import { isTypingTarget, matches } from "../../lib/keys";
import { useSettings } from "../../stores/settings";
import { laneColor, laneTint } from "./palette";
import { BranchFinder } from "./BranchFinder";
import { CherryPickPopover } from "./CherryPickPopover";
import { RebasePlanDialog } from "./RebasePlanDialog";
import { SearchBar } from "./SearchBar";
import "./graph.css";

/**
 * Fallbacks for the density tokens, used only where no document has been laid
 * out yet (jsdom in the test suite). The live values come from `theme.css` via
 * `useDensityMetrics` — see the note there for why they cannot be constants.
 */
const DEFAULT_ROW_HEIGHT = 28;
const DEFAULT_LANE_WIDTH = 18;
const DOT_RADIUS = 4.5;
const GUTTER_PAD = 12;
const BRANCH_COL_WIDTH = 200;

/**
 * Row height and lane width for the current density setting.
 *
 * These used to be two module constants, which meant Appearance → Density
 * wrote `data-density` onto the document, `theme.css` redefined `--row-height`
 * and `--lane-width` under it, and the graph — the one surface the setting
 * exists for — went on drawing 28px rows. Nothing in `src/` read either token.
 *
 * They are read back out of the tokens rather than duplicated here for the
 * same reason `palette.ts` reads the lane ring: the values are a property of
 * the theme, and a second copy in TypeScript is a second thing to keep in step.
 * The canvas needs them as numbers, so the read cannot be left to CSS.
 */
function useDensityMetrics(): { rowHeight: number; laneWidth: number; avatarSize: number } {
  const density = useSettings((s) => s.settings.density);
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const px = (token: string, fallback: number) =>
      parseFloat(style.getPropertyValue(token)) || fallback;
    const rowHeight = px("--row-height", DEFAULT_ROW_HEIGHT);
    return {
      rowHeight,
      laneWidth: px("--lane-width", DEFAULT_LANE_WIDTH),
      // The avatar is the node, so it has to shrink with the row it sits in or
      // a compact graph is a column of overlapping circles. Capped at 18 so a
      // comfortable row does not turn the lane into a portrait gallery.
      avatarSize: Math.min(18, Math.round(rowHeight * 0.64)),
    };
    // `applyAppearance` writes `data-density` synchronously before React
    // re-renders, so the attribute is already in place when this runs.
  }, [density]);
}
const EMPTY_HIDDEN_REFS: string[] = [];
/** Stable identity for "no ghosts", so a memoized row is not re-rendered by a
 *  fresh empty array on every parent render. */
const EMPTY_GHOSTS: GhostRef[] = [];
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

/**
 * How a ref is named at the top of a row's context menu.
 *
 * The kind comes first because the name alone is ambiguous next to the commit
 * actions below it — "main" reads as a verb-less entry, "Branch main" does not.
 */
function refMenuLabel(ref: RefBadge): string {
  if (ref.kind === "tag") return `Tag ${ref.name}`;
  if (ref.kind === "remoteBranch") return `Remote branch ${ref.name}`;
  return ref.isHead ? `Branch ${ref.name} (checked out)` : `Branch ${ref.name}`;
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
  const refInlineCount = useSettings((s) => s.settings.graphRefInlineCount);
  const { rowHeight, laneWidth, avatarSize } = useDensityMetrics();
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
  /** Row to flash: the new HEAD after a checkout. */
  const [flashOid, setFlashOid] = useState<string | null>(null);
  /**
   * The *source* commits of a cherry-pick (`07-cherry-pick.md` §3).
   *
   * Separate state from `flashOid`, not a second use of it: a pick moves HEAD
   * too, so both fire at once and one slot would let the HEAD flash overwrite
   * the correspondence the picked flash exists to show. They also mean
   * different things, and the CSS says so.
   */
  const [pickedOids, setPickedOids] = useState<Set<string>>(new Set());
  /** Row the pointer is over, for ghost refs (overview §1.2). */
  const [hoverOid, setHoverOid] = useState<string | null>(null);
  /** Branch whose remote pill just moved under a push (STATUS §4). */
  const [pushedBranch, setPushedBranch] = useState<string | null>(null);
  const [finderOpen, setFinderOpen] = useState(false);
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
    setPickedOids(new Set());
    setHoverOid(null);
    setFinderOpen(false);
  }, [repo?.path]);

  /**
   * Ghost refs for the hovered row.
   *
   * One query for the whole graph rather than one per row: containment is a
   * merge-base per ref, and forty visible rows each asking on mount would pay
   * that forty times for thirty-nine answers nobody reads. Kept fresh for a
   * minute — a ref would have to move for the answer to change, and moving one
   * invalidates the graph anyway.
   */
  const { data: ghostRefs } = useQuery({
    queryKey: ["ghostRefs", repo?.path, hoverOid],
    enabled: !!repo?.path && !!hoverOid,
    queryFn: () => containingRefs(repo!.path, hoverOid!, 2),
    staleTime: 60_000,
  });

  /**
   * The actions that apply to one ref, as a list of menu items.
   *
   * A *builder*, not a menu of its own. Every ref a row carries is offered as
   * a submenu of that row's menu, so right-clicking anywhere on the row — pill
   * included — raises one menu that can act on the commit *and* on its refs.
   * Two menus for one row that disagree about what is reachable is worse than
   * either, and a pill is a 60px target for half of what the user wants.
   *
   * The entries still mirror the sidebar's deliberately.
   */
  const refMenuItems = useCallback(
    (ref: RefBadge): MenuItem[] => {
      if (!repo) return [];
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
        return items;
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
                announcePush(ref.name);
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
      return items;
    },
    [repo, qc, pushToast],
  );

  /**
   * The one menu a right-click on a graph row raises.
   *
   * Anywhere on the row: the message, a column cell, or a ref pill. `clickedRef`
   * only *reorders* — the pill that was pointed at comes first — because the
   * target of a right-click is a row, and a menu that changed its whole
   * contents depending on which 60px of the row the pointer happened to be over
   * is a menu the user has to aim for. Ref actions are submenus of this one
   * rather than a second menu (`00-overview.md` §1.4).
   */
  const rowContextMenu = useCallback(
    (e: React.MouseEvent, row: GraphRow, clickedRef?: RefBadge) => {
      e.preventDefault();
      e.stopPropagation();
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
      const webUrl = originUrl ? commitWebUrl(originUrl, row.oid) : null;
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

      // Every ref this row carries, as a submenu — the pointed-at pill first.
      const rowRefs = clickedRef
        ? [clickedRef, ...row.refs.filter((r) => r.kind !== clickedRef.kind || r.name !== clickedRef.name)]
        : row.refs;
      if (rowRefs.length > 0) {
        items.push({ header: rowRefs.length === 1 ? "Ref on this row" : "Refs on this row" });
        for (const ref of rowRefs) {
          items.push({ label: refMenuLabel(ref), submenu: refMenuItems(ref) });
        }
        items.push({ separator: true });
      }

      items.push(
        { header: `Commit ${short}` },
        {
          label: "Checkout this commit",
          onClick: () => run(() => smartCheckout(path, row.oid), "Checked out commit"),
        },
        {
          label: "Create branch here…",
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
          label: "Create tag here",
          submenu: [
            {
              label: "Lightweight tag…",
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
              label: "Annotated tag…",
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
          ],
        },
        // Offered right beside Checkout, because a worktree is the answer to the
        // same question that does not disturb the tree you are in (G18). With a
        // branch on the row both answers exist and they differ: one attaches the
        // branch, the other detaches at the commit (`02-checkout.md` B8).
        localBadge
          ? {
              label: "Open in worktree",
              submenu: [
                {
                  label: `From ${localBadge.name} (attached)…`,
                  onClick: () => createWorktreeFlow(localBadge.name, localBadge.name),
                },
                { label: "At this commit (detached)…", onClick: () => createWorktreeFlow(row.oid, short) },
              ],
            }
          : { label: "Open in worktree…", onClick: () => createWorktreeFlow(row.oid, short) },
        { separator: true },
        {
          label:
            chosenOldestFirst.length > 1 ? `Cherry-pick ${chosenOldestFirst.length} commits` : "Cherry-pick commit",
          onClick: () =>
            setPick({
              oids: chosenOldestFirst,
              parents: chosenOldestFirst.length === 1 ? row.parents : [],
            }),
        },
        {
          label: "Revert commit",
          onClick: () =>
            run(async () => {
              await requireNoPausedOperation(path, `revert ${short}`);
              reportConflicts("revert", await revertCommit(path, row.oid), "Reverted");
            }),
        },
        { label: `Rebase ${head} onto this commit`, onClick: standardRebase },
        {
          // STATUS B8: with a multi-select, the plan is the selection's own
          // range — `<oldest selected>^..HEAD` — not `<clicked>..HEAD`. The
          // two agree only when the selection happens to end at HEAD, which
          // is why the bug was easy to miss.
          label:
            chosenRows.length > 1
              ? `Interactive rebase ${chosenRows.length} selected commits…`
              : `Interactive rebase ${head} onto this commit…`,
          // The oldest selected commit's parent is the base: rebasing *onto*
          // the oldest selection itself would leave it out of the plan.
          disabled: chosenRows.length > 1 && !oldestSelected?.parents[0],
          onClick: () =>
            setRebasePlan({
              base: chosenRows.length > 1 ? (oldestSelected?.parents[0] ?? row.oid) : row.oid,
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
          // Five entries that are one operation wearing five labels: each opens
          // the interactive-rebase plan with a verb pre-applied. Flat, they were
          // a third of the menu and sat between actions that rewrite nothing;
          // grouped, the menu names the cost before it names the verb.
          label: "Rewrite history",
          disabled: row.parents.length === 0 && !parentRow?.parents[0],
          submenu: [
            {
              label: "Edit commit message…",
              disabled: row.parents.length === 0,
              onClick: () =>
                row.parents[0] && setRebasePlan({ base: row.parents[0], targetOid: row.oid, action: "reword" }),
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
          ],
        },
        { separator: true },
        { label: "Compare against working directory", onClick: () => selectOid(WORKING) },
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
        { separator: true },
        { label: "Copy commit sha", onClick: () => copyText(row.oid) },
        {
          label: "More",
          submenu: [
            { label: "Copy commit message", onClick: () => copyText(row.summary) },
            ...(webUrl ? [{ label: "Copy link to this commit on origin", onClick: () => copyText(webUrl) }] : []),
            { label: "Create patch from commit…", onClick: createPatchFlow },
            { separator: true },
            {
              label: `Search this author's commits (${row.author})`,
              onClick: () => seedSearch(path, `author:${row.email || row.author}`),
            },
          ],
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [repo, qc, pushToast, originUrl, rows, selectedOids, selectOid, refMenuItems],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const virtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 24,
  });

  // The virtualizer caches measurements, so a density change has to tell it to
  // forget them — otherwise the rows resize and the offsets do not.
  const firstMeasure = useRef(true);
  useLayoutEffect(() => {
    if (firstMeasure.current) {
      firstMeasure.current = false;
      return;
    }
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

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

  /**
   * Width of the lane gutter, from the widest lane anywhere in the history.
   *
   * Memoized because it is a sweep of every loaded row *and every edge on it* —
   * 50k rows on a large repository — and it used to run on each render. Hovering
   * a row, flashing HEAD or moving the selection each re-rendered the graph, so
   * this walked the whole history on every mouse move down the list. It only
   * changes when the rows do.
   */
  const gutterWidth = useMemo(() => {
    let maxLane = 0;
    for (const r of visibleRows) {
      if (r.lane > maxLane) maxLane = r.lane;
      for (const e of r.edges) {
        if (e.fromLane > maxLane) maxLane = e.fromLane;
        if (e.toLane > maxLane) maxLane = e.toLane;
      }
    }
    return (maxLane + 1) * laneWidth + GUTTER_PAD;
  }, [visibleRows, laneWidth]);

  const laneX = useCallback(
    (lane: number) => GUTTER_PAD + lane * laneWidth + laneWidth / 2,
    [laneWidth],
  );

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
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 1);
    const last = Math.min(visibleRows.length - 1, Math.ceil((scrollTop + ch) / rowHeight) + 1);

    // Filter mode hides rows, so consecutive rows are no longer parent and
    // child: drawing the edge band between them would assert a parentage that
    // does not exist. Nodes only, until the filter is lifted.
    if (!filtering) {
      for (let i = first; i <= last; i++) {
        const row = visibleRows[i];
        const yTop = i * rowHeight - scrollTop + rowHeight / 2;
        const yBot = yTop + rowHeight;
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
      const y = i * rowHeight - scrollTop + rowHeight / 2;
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
  }, [visibleRows, gutterWidth, laneX, selectedOid, filtering, rowHeight]);

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
      // `/` is a bare key, so it only counts when the user is not typing —
      // otherwise every path in a commit message would open the finder.
      if (!isTypingTarget(event) && matches(event, "graph.findRef")) {
        event.preventDefault();
        setFinderOpen(true);
        return;
      }
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

  // A push moved a remote-tracking ref; say so on the pill rather than only in
  // a toast, which is somewhere else on the screen from the thing that changed.
  useEffect(() => {
    const onPushed = (event: Event) => setPushedBranch((event as CustomEvent<string>).detail);
    window.addEventListener(PUSH_FLASH_EVENT, onPushed);
    return () => window.removeEventListener(PUSH_FLASH_EVENT, onPushed);
  }, []);
  useEffect(() => {
    if (!pushedBranch) return;
    const timer = setTimeout(() => setPushedBranch(null), 1800);
    return () => clearTimeout(timer);
  }, [pushedBranch]);

  // The picked flash is one pulse, like the HEAD one, and then gone.
  useEffect(() => {
    if (pickedOids.size === 0) return;
    const timer = setTimeout(() => setPickedOids(new Set()), 1200);
    return () => clearTimeout(timer);
  }, [pickedOids]);

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

  /**
   * Open the worktree that holds the target branch, then pick into it.
   *
   * Run directly rather than through the confirm popover, because the popover
   * is state of *this* tab and the pick happens in another repository handle —
   * carrying it across the switch would mean a popover that outlives the
   * repository it was raised for. The menu entry named both halves, which is
   * the confirmation the popover would have been.
   */
  const pickInWorktree = useCallback(
    async (holder: WorktreeInfo, branch: string, commitOid: string) => {
      try {
        const opened = await openRepo(holder.path);
        setRepo(opened);
        pushToast("info", `Switched to the "${holder.name}" worktree.`);
        await runCherryPick({
          repoPath: holder.path,
          oids: [commitOid],
          branch,
          commitImmediately: true,
          qc,
        });
      } catch (error) {
        toastError(error);
      }
    },
    [qc, setRepo, pushToast],
  );

  const selectRow = useCallback((event: React.MouseEvent, row: GraphRow) => {
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
  }, [rows, selectionAnchor, selectOid]);

  /**
   * Row indices for the two fixed scrollbar marks.
   *
   * Two linear scans of the whole loaded history, and they were inline in the
   * render, so they ran again for every hover, flash and selection change.
   */
  const markerIndices = useMemo(
    () => ({
      head: rows.findIndex((row) => row.oid === headOid),
      selected: rows.findIndex((row) => row.oid === selectedOid),
    }),
    [rows, headOid, selectedOid],
  );

  /**
   * Checking out a ref from a pill's double-click.
   *
   * A `useCallback` rather than an inline arrow because it is a prop of every
   * visible row, and `GraphRowView` is memoized — one unstable prop re-renders
   * all forty rows on every parent render and throws the memo away.
   */
  const checkoutRef = useCallback(
    (name: string) => {
      const path = repo?.path;
      if (!path) return;
      smartCheckout(path, name)
        .then(() => {
          pushToast("success", `Checked out ${name}.`);
          return refreshRepo(qc, path);
        })
        .catch(toastError);
    },
    [repo?.path, qc, pushToast],
  );

  const rowOpts = useMemo(() => ({ relativeDates: dateStyle === "relative" }), [dateStyle]);

  // ---- No hooks below this line. ----
  //
  // These early returns mean a hook declared after them is one React sees on
  // some renders and not others. `refMenuItems` (then `refContextMenu`) and `pickInWorktree` used to
  // sit further down beside `dropOnRef`, the plain helper that calls them, and
  // the first render that got past `isPending` — which is to say opening any
  // repository — crashed the renderer with "rendered more hooks than during
  // the previous render". Nothing here is linted for it: there is no eslint
  // config in this repo, so this comment is the guard.
  if (!repo) {
    return (
      <div className="graph-empty">
        <b>No repository open</b>
        <span>Open, clone or initialise one from the Start tab.</span>
      </div>
    );
  }
  if (isPending) {
    // Skeleton rows rather than a centred word: the graph's shape is the thing
    // being waited for, and showing it empty says "this is where the history
    // goes" while a line of text in the middle of the pane says only "wait".
    // The visible text stays for the test suite and for a screen reader.
    return (
      <div className="graph-container">
        <div className="graph-skeleton" aria-busy="true">
          <span className="sr-only">Loading history…</span>
          {Array.from({ length: 14 }, (_, i) => (
            <div className="skeleton-row" key={i} style={{ height: rowHeight }}>
              <span className="skeleton-node" />
              <span className="skeleton-bar" style={{ width: `${28 + ((i * 37) % 46)}%` }} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="graph-empty error">
        <b>This repository could not be read.</b>
        <span>{String(error)}</span>
      </div>
    );
  }
  if (rows.length === 0 && !status?.isDirty) {
    return (
      <div className="graph-empty">
        <b>No commits yet.</b>
        <span>Stage some files and make the first commit — it will appear here.</span>
      </div>
    );
  }

  const dirtyCount = new Set([
    ...(status?.staged ?? []).map((entry) => entry.path),
    ...(status?.unstaged ?? []).map((entry) => entry.path),
    ...(status?.conflicted ?? []).map((entry) => entry.path),
  ]).size;

  const currentWip = (wips ?? []).find((wip) => wip.isCurrent);
  const otherWips = (wips ?? []).filter((wip) => !wip.isCurrent);

  const dropOnRef = (event: React.DragEvent, target: string, isHead: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    if (!repo) return;
    const commitOid = event.dataTransfer.getData("application/x-mtgit-commit");
    if (commitOid) {
      const commit = rows.find((candidate) => candidate.oid === commitOid);
      if (isHead) {
        setPick({ oids: [commitOid], parents: commit?.parents ?? [] });
        return;
      }
      // `07-cherry-pick.md` §5: picking onto a branch that is not checked out
      // here is a *composite* action, not an error. Which composite depends on
      // why it is not checked out — another worktree holds it, or it is simply
      // not the current branch — so the menu has to ask git first.
      const short = commitOid.slice(0, 7);
      const { clientX: x, clientY: y } = event;
      void worktreeHolding(repo.path, target)
        .catch(() => null)
        .then((holder) =>
          setMenu({
            x,
            y,
            items: holder
              ? [
                  {
                    label: `Open the "${holder.name}" worktree and cherry-pick ${short}`,
                    onClick: () => void pickInWorktree(holder, target, commitOid),
                  },
                ]
              : [
                  {
                    label: `Check out ${target} and cherry-pick ${short}`,
                    onClick: async () => {
                      try {
                        await smartCheckout(repo.path, target);
                        await refreshRepo(qc, repo.path);
                        // The popover survives this: the repository path has
                        // not changed, so the reset effect keyed on it does
                        // not fire and take the pick with it.
                        setPick({ oids: [commitOid], parents: commit?.parents ?? [] });
                      } catch (error) {
                        if (!isCancelled(error)) toastError(error);
                      }
                    },
                  },
                ],
          }),
        );
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
            <label className="gh-gear-number">
              Ref pills before <code>+N</code>
              <input
                type="number"
                min={1}
                max={20}
                value={refInlineCount}
                onChange={(e) =>
                  useSettings
                    .getState()
                    .set({ graphRefInlineCount: Number(e.target.value) || 1 })
                }
              />
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
      <div
        className="graph-scroll"
        ref={parentRef}
        tabIndex={-1}
        // Otherwise the last row hovered keeps its ghosts while the pointer is
        // somewhere else entirely.
        onMouseLeave={() => setHoverOid(null)}
      >
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
                index={vi.index}
                gutter={gutterWidth}
                nodeLeft={BRANCH_COL_WIDTH + laneX(row.lane)}
                rowHeight={rowHeight}
                avatarSize={avatarSize}
                selected={row.oid === selectedOid || selectedOids.has(row.oid)}
                hit={hitOids.has(row.oid)}
                flash={row.oid === flashOid}
                picked={pickedOids.has(row.oid)}
                currentHit={row.oid === currentHitOid}
                columns={columns}
                stats={statsByOid.get(row.oid)}
                opts={rowOpts}
                onSelect={selectRow}
                onContextMenu={rowContextMenu}
                onCheckoutRef={checkoutRef}
                onRefDrop={dropOnRef}
                onHover={setHoverOid}
                hiddenRefs={hiddenRefs}
                refInlineCount={refInlineCount}
                ghosts={hoverOid === row.oid ? (ghostRefs ?? EMPTY_GHOSTS) : EMPTY_GHOSTS}
                pushedBranch={pushedBranch}
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
        headIndex={markerIndices.head}
        selectedIndex={markerIndices.selected}
      />
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {finderOpen && (
        <BranchFinder
          repoPath={repo.path}
          // `revealCommit` already owns "scroll to a commit that may not be
          // loaded yet" — it pulls pages until the row exists. The finder has
          // nothing to add to that beyond choosing the oid.
          onPick={(oid, name) => {
            revealCommit(oid);
            pushToast("info", `${name} — showing its tip.`);
          }}
          onClose={() => setFinderOpen(false)}
        />
      )}
      {pick && repo && (
        <CherryPickPopover
          repoPath={repo.path}
          branch={repo.head.branch ?? repo.head.oid?.slice(0, 7) ?? "HEAD"}
          oids={pick.oids}
          parents={pick.parents}
          onPicked={(oids) => setPickedOids(new Set(oids))}
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

/**
 * One commit row.
 *
 * Memoized, and every callback prop it takes is stable, because the parent
 * re-renders on hover, on selection, on a flash and on every page that arrives
 * — and without this each of those re-rendered all forty visible rows, avatars
 * and pills included.
 */
const GraphRowView = memo(function GraphRowView({
  row,
  repoPath,
  top,
  index,
  gutter,
  nodeLeft,
  rowHeight,
  avatarSize,
  selected,
  hit,
  currentHit,
  flash,
  picked,
  columns,
  stats,
  opts,
  onSelect,
  onContextMenu,
  onCheckoutRef,
  onRefDrop,
  onHover,
  hiddenRefs,
  refInlineCount,
  ghosts,
  pushedBranch,
  checkoutTarget,
}: {
  row: GraphRow;
  repoPath: string;
  top: number;
  index: number;
  gutter: number;
  nodeLeft: number;
  rowHeight: number;
  avatarSize: number;
  selected: boolean;
  hit: boolean;
  currentHit: boolean;
  flash: boolean;
  picked: boolean;
  columns: GraphColumnId[];
  stats: CommitStats | undefined;
  opts: { relativeDates: boolean };
  onSelect: (event: React.MouseEvent, row: GraphRow) => void;
  onContextMenu: (event: React.MouseEvent, row: GraphRow, ref?: RefBadge) => void;
  onCheckoutRef: (name: string) => void;
  onRefDrop: (event: React.DragEvent, target: string, isHead: boolean) => void;
  onHover: (oid: string) => void;
  hiddenRefs: string[];
  refInlineCount: number;
  ghosts: GhostRef[];
  pushedBranch: string | null;
  checkoutTarget: string | null;
}) {
  const [expandedRefs, setExpandedRefs] = useState(false);
  const { shown: displayRefs, hidden: overflowRefs, collapsed: collapsedRemotes } = planRefPills(
    row.refs,
    hiddenRefs,
    refInlineCount,
    expandedRefs,
  );
  return (
    <div
      className={`graph-row${index % 2 ? " odd" : ""}${selected ? " selected" : ""}${
        hit ? " hit" : ""
      }${currentHit ? " current-hit" : ""}${flash ? " flash" : ""}${picked ? " picked" : ""}`}
      // The band is the row's own lane colour rather than one blue for all of
      // them, which is what ties it to the node and edges beside it. Computed
      // here, inside the memoized row: a tint swept in the parent would walk
      // every loaded row on each hover (parity plan §7). Banding parity comes
      // from the index rather than `:nth-child`, because rows are absolutely
      // positioned and their DOM order is the virtualizer's, not the graph's.
      style={{ top, height: rowHeight, background: selected ? laneTint(row.color) : undefined }}
      onClick={(event) => onSelect(event, row)}
      // Only rows with nothing to show ask: a ghost never renders beside a
      // real pill, so asking there would be a merge-base sweep per hovered
      // row for an answer that is thrown away.
      onMouseEnter={() => displayRefs.length === 0 && onHover(row.oid)}
      onContextMenu={(event) => onContextMenu(event, row)}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-mtgit-commit", row.oid);
        event.dataTransfer.effectAllowed = "copy";
      }}
    >
      <div className="row-refs" style={{ width: BRANCH_COL_WIDTH }}>
        {/* Ghost refs (overview §1.2): what this row *would* be labelled.
            Only when it carries no pill of its own — beside a real one they
            read as a rendering fault rather than a hint. */}
        {displayRefs.length === 0 &&
          ghosts.map((ghost) => (
            <span
              key={`ghost-${ghost.kind}-${ghost.name}`}
              className={`badge badge-${ghost.kind} ghost`}
              style={{ borderColor: laneColor(row.color) }}
              title={`Contained in ${ghost.name}, ${ghost.distance} commit${
                ghost.distance === 1 ? "" : "s"
              } back from its tip`}
            >
              <Icon name={ghost.kind === "tag" ? "tag" : "branch"} size={11} />
              <span className="badge-name">{ghost.name}</span>
            </span>
          ))}
        {displayRefs.map((r) => (
          <span
            key={r.kind + r.name}
            className={`badge badge-${r.kind}${r.isHead ? " head" : ""}${
              justPushed(r, pushedBranch) ? " pushed" : ""
            }`}
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
            // Not a menu of its own any more: the row's menu carries this
            // pill's actions as its first submenu (`00-overview.md` §1.4).
            onContextMenu={(event) => onContextMenu(event, row, r)}
          >
            {r.kind === "tag" && <Icon name="tag" size={11} />}
            {r.isHead && <Icon name="check" size={11} />}
            {(r.kind === "remoteBranch" ||
              (r.kind === "localBranch" && collapsedRemotes.has(r.name))) && (
              <Icon name="cloud" size={11} />
            )}
            {/* The one pill kind that carried no glyph, so a plain local
                branch was the only pill identified by colour alone. */}
            {r.kind === "localBranch" && !r.isHead && !collapsedRemotes.has(r.name) && (
              <Icon name="branch" size={11} />
            )}
            {checkoutTarget === r.name && <Icon name="pending" size={11} />}
            <span className="badge-name">{r.name}</span>
          </span>
        ))}
        {overflowRefs.length > 0 && (
          <button
            type="button"
            className="badge badge-overflow"
            title={overflowRefs.map((r) => r.name).join("\n")}
            onClick={(event) => {
              event.stopPropagation();
              setExpandedRefs(true);
            }}
          >
            +{overflowRefs.length}
          </button>
        )}
      </div>
      <div className="row-graph" style={{ width: gutter }} />
      <span
        className={`node-avatar${row.parents.length > 1 ? " merge-node" : ""}`}
        style={{
          left: nodeLeft - avatarSize / 2,
          width: avatarSize,
          height: avatarSize,
          borderColor: laneColor(row.color),
        }}
      >
        <Avatar email={row.email} name={row.author} size={avatarSize} />
      </span>
      {/* Sync markers (G23, `03-push.md` §7). A dot beside the node rather
          than a column: the question is "is this one of mine", which is asked
          while looking at the graph, not while reading a column. */}
      {(row.unpushed || row.unpulled) && (
        <span
          className={`row-sync ${row.unpushed ? "unpushed" : "unpulled"}`}
          style={{ left: nodeLeft + avatarSize / 2 + 2 }}
          title={row.unpushed ? "Not yet pushed to the upstream" : "On the upstream, not yet pulled"}
        >
          <Icon name={row.unpushed ? "push" : "pull"} size={9} />
        </span>
      )}
      <span className="row-summary">
        {/* Issue references are links here too (G20): the graph is where most
            people read a message, and a reference you can only follow from the
            detail panel is one you mostly do not follow. That holds for the
            body half as well — it used to be spliced into `summary` by the Rust
            side, so it has always been autolinked, and it is where a "fixes
            #123" usually is. */}
        <Autolinked repoPath={repoPath} text={row.summary} />
        {row.bodyPreview && (
          <span className="row-body">
            <Autolinked repoPath={repoPath} text={row.bodyPreview} />
          </span>
        )}
      </span>
      {columns.map((id) => (
        <span key={id} className={`row-col col-${id}`}>
          {id === "author" && (
            /* No context menu of its own: right-clicking anywhere on a row
               raises the row's menu, and "search this author" lives in it.
               A cell that swallowed the gesture made a third of the row's
               width the one place the menu did not open. */
            <span className="row-author" title={row.email ? `${row.author} <${row.email}>` : row.author}>
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
});

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

/* Both of these are memoized: their props are the search hits and two row
   indices, none of which change when the pointer moves — and `ScrollMarkers`
   renders up to four hundred spans, which is not a thing to reconcile on every
   hovered row. */

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
const SearchMinimap = memo(function SearchMinimap({
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
});

const ScrollMarkers = memo(function ScrollMarkers({
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
});
