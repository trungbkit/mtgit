import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  addRemote,
  clearHistory,
  createWorktree,
  createBranch,
  createTag,
  deleteBranch,
  deleteRemoteBranch,
  deleteTag,
  gitNetwork,
  listRefs,
  listRemotes,
  listContributors,
  listSubmodules,
  listWorktrees,
  mergeAdvanced,
  mergeRelation,
  openRepo,
  rebaseStandard,
  removeRemote,
  removeWorktree,
  renameRemote,
  rewriteInfo,
  renameBranch,
  setRemoteUrl,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  unsetUpstream,
  updateSubmodules,
} from "../../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
import type { BranchInfo, Contributor, RemoteInfo, WorktreeInfo } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { seedSearch, useSearch } from "../../stores/search";
import { toastError, useToasts } from "../../stores/toasts";
import { choiceDialog, confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { joinPath, validateCloneUrl } from "../../lib/cloneurl";
import { Icon, type IconName } from "../../components/Icon";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { matches } from "../../lib/keys";
import { copyText } from "../../lib/clipboard";
import { Avatar } from "../../components/Avatar";
import { timeAgo } from "../../lib/time";
import { smartCheckout } from "../../lib/checkout";
import { dropMenuItems } from "../../lib/dropMenu";
import { captureUndoPoint, toastWithUndo } from "../../lib/undoToast";
import "./sidebar.css";

const EMPTY_HIDDEN_REFS: string[] = [];

/**
 * Remote-name rules, checked here so the user is told in the dialog rather
 * than by a toast after it closes. The backend rejects the same things
 * (`core/remote.rs::check_name`) — this copy exists for the timing, not the
 * safety.
 */
function validateRemoteName(value: string, existing: RemoteInfo[]): string | null {
  const name = value.trim();
  if (!name) return "Name cannot be empty.";
  if (/[\s~^:?*[\\/]/.test(name)) return "Name cannot contain spaces, '/' or ~ ^ : ? * [ \\.";
  if (name.startsWith("-") || name.startsWith(".")) return "Name cannot start with '-' or '.'.";
  if (existing.some((r) => r.name === name)) return `A remote named "${name}" already exists.`;
  return null;
}

// The placeholder is the only place this shortcut is advertised, so it has to
// name the keys the handler below actually binds (STATUS A5).
const FILTER_HINT = /mac/i.test(navigator.userAgent) ? "⌘F" : "Ctrl+F";

export function Sidebar() {
  const repo = useSession((s) => s.repo);
  const selectOid = useSession((s) => s.selectOid);
  const collapsed = useSession((s) => s.sidebarCollapsed);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const hiddenRefs = useSession((s) =>
    repo ? s.hiddenRefs[repo.path] ?? EMPTY_HIDDEN_REFS : EMPTY_HIDDEN_REFS,
  );
  const toggleHiddenRef = useSession((s) => s.toggleHiddenRef);
  const checkoutTarget = useSession((s) => s.checkoutTarget);
  const setRepo = useSession((s) => s.setRepo);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusFilter = (event: KeyboardEvent) => {
      if (!matches(event, "sidebar.filter")) return;
      // The graph reads the same chord (the commit search), so focus decides:
      // with the graph focused it searches commits, and everywhere else —
      // including nothing focused — it filters refs here
      // (`08-search-and-filter.md` §2). The graph's own `search.focus` chord
      // works from anywhere and never reaches this handler.
      //
      // The shift key is deliberately *not* tested here any more. It used to
      // stand in for "this is the graph's ⇧⌘F", which `matches` now decides —
      // and testing it again would break a user who rebinds this action to
      // something containing Shift.
      if (document.activeElement?.closest(".graph-container")) return;
      event.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
    };
    window.addEventListener("keydown", focusFilter);
    return () => window.removeEventListener("keydown", focusFilter);
  }, []);

  const { data } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo,
    queryFn: () => listRefs(repo!.path),
  });
  const { data: stashes } = useQuery({
    queryKey: ["stashes", repo?.path],
    enabled: !!repo,
    queryFn: () => stashList(repo!.path),
  });
  const { data: worktrees } = useQuery({
    queryKey: ["worktrees", repo?.path],
    enabled: !!repo,
    queryFn: () => listWorktrees(repo!.path),
  });
  const { data: submodules } = useQuery({
    queryKey: ["submodules", repo?.path],
    enabled: !!repo,
    queryFn: () => listSubmodules(repo!.path),
  });
  const { data: remotes } = useQuery({
    queryKey: ["remotes", repo?.path],
    enabled: !!repo,
    queryFn: () => listRemotes(repo!.path),
  });
  const { data: contributors } = useQuery({
    queryKey: ["contributors", repo?.path],
    enabled: !!repo,
    queryFn: () => listContributors(repo!.path),
    // A full-history walk is the most expensive thing the sidebar asks for,
    // and the answer moves only when commits land — which a refresh
    // invalidates anyway.
    staleTime: 30_000,
  });

  if (!repo) return <aside className="sidebar" />;
  const path = repo.path;
  const headBranch = repo.head.branch;

  const refresh = () => refreshRepo(qc, path);
  async function run(fn: () => Promise<unknown>, ok?: string) {
    // Read before the mutation, so the toast only offers Undo for what *this*
    // operation did rather than for whatever came before it (§3.3).
    const capture = await captureUndoPoint(path);
    try {
      await fn();
      await refresh();
      if (ok) await toastWithUndo(qc, path, ok, capture);
    } catch (e) {
      toastError(e);
    }
  }

  async function doCheckout(name: string) {
    await run(() => smartCheckout(path, name), `Checked out ${name}`);
  }

  // Merge and rebase both funnel through one helper apiece so §5.3's refusal has
  // a single home per operation rather than one per menu item. Checkout needs
  // none of this: `smartCheckout` carries the gate itself.
  async function doMerge(source: string, mode: "noFf" | "ffOnly") {
    await requireNoPausedOperation(path, `merge ${source}`);
    reportMerge(await mergeAdvanced(path, source, mode));
  }

  async function doRebase(target: string) {
    await requireNoPausedOperation(path, `rebase onto ${target}`);
    const info = await rewriteInfo(path, target);
    if (
      (info.pushed > 0 || info.merges > 0) &&
      !(await confirmDialog({
        title: `Rebase ${headBranch ?? "HEAD"} onto ${target}`,
        message: `${info.pushed ? `${info.pushed} affected commit(s) are pushed. ` : ""}${info.merges ? `${info.merges} merge commit(s) will be flattened.` : ""}`,
        confirmLabel: "Rebase",
        danger: info.pushed > 0,
      }))
    ) {
      return;
    }
    const result = await rebaseStandard(path, target);
    reportRebase(result, info.commits);
  }

  async function deleteBranchFlow(b: BranchInfo) {
    const ok = await confirmDialog({
      title: "Delete branch",
      message: `Delete branch "${b.name}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteBranch(path, b.name, false);
      pushToast("success", "Deleted");
      refresh();
    } catch (e) {
      if (/not fully merged/i.test(String(e))) {
        const force = await confirmDialog({
          title: "Branch not fully merged",
          message: `"${b.name}" has commits not merged into HEAD. Force delete and lose them?`,
          confirmLabel: "Force delete",
          danger: true,
        });
        if (force) run(() => deleteBranch(path, b.name, true), "Deleted (forced)");
      } else {
        toastError(e);
      }
    }
  }

  async function deleteRemoteBranchFlow(b: BranchInfo) {
    const slash = b.name.indexOf("/");
    if (slash < 0) return;
    const remote = b.name.slice(0, slash);
    const branch = b.name.slice(slash + 1);
    const ok = await confirmDialog({
      title: "Delete remote branch",
      message: `Delete "${branch}" on "${remote}"?\n\nRuns: git push ${remote} --delete ${branch}`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await deleteRemoteBranch(path, remote, branch);
      if (res.success) pushToast("success", `Deleted ${b.name} on remote`);
      else pushToast("error", res.output.split("\n").pop() ?? "push --delete failed");
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  const f = filter.trim().toLowerCase();
  const match = (b: BranchInfo) => !f || b.name.toLowerCase().includes(f);
  const localItems = (data?.local ?? []).filter(match);
  const remoteItems = (data?.remote ?? []).filter(match);
  const tagItems = (data?.tags ?? []).filter(match);
  const viewing = localItems.length + remoteItems.length + tagItems.length;

  // ---- Collapsed icon rail (screenshot 2) --------------------------------
  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="rail-toggle" title="Expand sidebar" onClick={toggleSidebar}>
          ›
        </button>
        <RailIcon icon="branch" count={data?.local.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="cloud" count={remotes?.length ?? data?.remote.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="tag" count={data?.tags.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="worktree" count={worktrees?.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="stash" count={stashes?.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="commit" count={submodules?.length ?? 0} onClick={toggleSidebar} />
      </aside>
    );
  }

  function branchMenu(e: React.MouseEvent, b: BranchInfo, local: boolean) {
    e.preventDefault();
    const items: MenuItem[] = [
      { label: "Checkout", onClick: () => doCheckout(b.name) },
      { label: "Open in worktree…", onClick: () => openInWorktree(b.name) },
      {
        // Scoping the graph to a ref *is* the `ref:` search term, not a second
        // filter mechanism (overview §2) — so this writes the query the search
        // field would have written.
        label: "Show only this in the graph",
        onClick: () => {
          seedSearch(path, `ref:${b.name}`, true);
          useSearch.getState().setMode(path, "filter");
        },
      },
      {
        label: "Search commits on this branch",
        onClick: () => seedSearch(path, `ref:${b.name}`, true),
      },
    ];
    if (local) {
      if (b.upstreamGone && b.upstream) {
        // `04-pull.md` §5 (STATUS C8). Both recoveries are offered because
        // only the user knows which it is: a branch merged and deleted on the
        // remote is finished, and one deleted by mistake is not.
        items.push(
          { separator: true },
          { label: `${b.upstream} no longer exists on the remote`, disabled: true },
          {
            label: "Stop tracking it",
            onClick: () => run(() => unsetUpstream(path, b.name), `${b.name} no longer tracks anything`),
          },
          {
            label: "Delete this local branch",
            danger: true,
            disabled: b.isHead,
            onClick: () => deleteBranchFlow(b),
          },
          { separator: true },
        );
      }
      if (b.isHead && b.upstream && !b.upstreamGone) {
        items.push({
          label: `Pull (fast-forward) from ${b.upstream}`,
          disabled: !b.behind,
          onClick: () =>
            run(async () => {
              await requireNoPausedOperation(path, "pull");
              const result = await gitNetwork(path, "pull", undefined, ["--ff-only"]);
              if (!result.success) throw new Error(result.output);
            }, `Fast-forwarded ${b.name}`),
        });
      }
      items.push(
        {
          label: `Push ${b.name}`,
          onClick: () => {
            const remote = b.upstream?.split("/")[0] ?? "origin";
            run(async () => {
              const result = await gitNetwork(path, "push", remote, [b.name]);
              if (!result.success) throw new Error(result.output);
              await clearHistory(path);
            }, `Pushed ${b.name}`);
          },
        },
        {
          label: "Rename…",
          onClick: async () => {
            const nn = await promptDialog({
              title: "Rename branch",
              label: "New branch name",
              defaultValue: b.name,
              confirmLabel: "Rename",
              validate: validateRefName,
            });
            if (nn && nn !== b.name) run(() => renameBranch(path, b.name, nn), "Renamed");
          },
        },
        {
          label: `Merge into ${headBranch ?? "HEAD"}`,
          onClick: () => run(() => doMerge(b.name, "noFf")),
          disabled: b.isHead,
        },
        {
          label: `Merge into ${headBranch ?? "HEAD"} (ff-only)`,
          onClick: () => run(() => doMerge(b.name, "ffOnly")),
          disabled: b.isHead,
        },
        {
          label: `Rebase ${headBranch ?? "HEAD"} onto ${b.name}`,
          disabled: b.isHead,
          onClick: () => run(() => doRebase(b.name)),
        },
        {
          label: "Delete",
          danger: true,
          disabled: b.isHead,
          onClick: () => deleteBranchFlow(b),
        },
      );
    } else {
      items.push(
        {
          label: "Merge into current",
          onClick: () => run(() => doMerge(b.name, "noFf")),
        },
        { separator: true },
        {
          label: "Delete remote branch",
          danger: true,
          onClick: () => deleteRemoteBranchFlow(b),
        },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  /**
   * "Open in worktree…" (G18) — offered wherever Checkout is, because GitLens
   * treats a worktree as the *default* answer to "look at another branch":
   * it does not disturb the working tree you are in.
   *
   * The backend resolves `target` — a local branch is attached as-is, a
   * remote one gets a tracking local branch — so this only has to ask where.
   */
  async function openInWorktree(target: string) {
    const suggested = target.split("/").pop() || target;
    const parent = await openDialog({
      directory: true,
      multiple: false,
      title: `Where to create the worktree for ${target}`,
    });
    if (typeof parent !== "string") return;
    const folder = await promptDialog({
      title: "Open in worktree",
      message: `A worktree for ${target} will be created inside ${parent}.`,
      label: "Folder name",
      defaultValue: suggested,
      confirmLabel: "Create",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) return "Name cannot be empty.";
        if (/[/\\]/.test(trimmed)) return "Name cannot contain a path separator.";
        return null;
      },
    });
    if (!folder) return;
    const wtPath = joinPath(parent, folder.trim());
    await run(async () => {
      await createWorktree(path, folder.trim(), wtPath, target);
      // Opening it immediately is the point: a worktree you have to go and
      // find is a worktree you forget you made.
      setRepo(await openRepo(wtPath));
    }, `Worktree for ${target} created`);
  }

  async function addWorktreeFlow() {
    const branches = (data?.local ?? []).map((b) => b.name);
    const target = await choiceDialog({
      title: "Add worktree",
      message: "Which branch should the new worktree check out?",
      choices: branches.length
        ? branches.map((name) => ({ label: name, value: name }))
        : [{ label: headBranch ?? "HEAD", value: headBranch ?? "HEAD" }],
    });
    if (target) await openInWorktree(target);
  }

  function worktreeMenu(e: React.MouseEvent, wt: WorktreeInfo) {
    e.preventDefault();
    const items: MenuItem[] = [];
    if (!wt.isCurrent) {
      items.push({
        label: "Open in a tab",
        onClick: () =>
          openRepo(wt.path)
            .then(setRepo)
            .catch(toastError),
      });
    }
    items.push(
      { label: "Open folder", onClick: () => openPath(wt.path).catch(toastError) },
      { label: "Copy path", onClick: () => copyText(wt.path) },
    );
    if (!wt.isMain) {
      items.push(
        { separator: true },
        {
          label: "Remove worktree",
          danger: true,
          // Removing the worktree you are looking at would leave the tab
          // pointing at a directory that no longer exists.
          disabled: wt.isCurrent,
          onClick: () => removeWorktreeFlow(wt),
        },
      );
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  async function removeWorktreeFlow(wt: WorktreeInfo) {
    const ok = await confirmDialog({
      title: "Remove worktree",
      message: `Delete the working directory at ${wt.path}?\n\nThe branch "${wt.branch ?? "detached"}" is not deleted.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeWorktree(path, wt.name, false);
      pushToast("success", `Removed worktree ${wt.name}`);
      refresh();
    } catch (error) {
      // The backend refuses a dirty or locked worktree rather than deleting
      // uncommitted work; offer the force the way branch delete does.
      if (/uncommitted|locked/i.test(String(error))) {
        const force = await confirmDialog({
          title: "Worktree has uncommitted changes",
          message: `${String(error)}\n\nDelete it anyway and lose them?`,
          confirmLabel: "Delete anyway",
          danger: true,
        });
        if (force) run(() => removeWorktree(path, wt.name, true), `Removed worktree ${wt.name}`);
      } else {
        toastError(error);
      }
    }
  }

  async function addRemoteFlow() {
    const name = await promptDialog({
      title: "Add remote",
      label: "Remote name",
      placeholder: "upstream",
      confirmLabel: "Next",
      validate: (value) => validateRemoteName(value, remotes ?? []),
    });
    if (!name) return;
    const url = await promptDialog({
      title: `URL for ${name.trim()}`,
      label: "Remote URL",
      placeholder: "https://github.com/org/repo.git",
      confirmLabel: "Add",
      validate: validateCloneUrl,
    });
    if (!url) return;
    run(() => addRemote(path, name.trim(), url.trim()), `Added remote ${name.trim()}`);
  }

  function remoteMenu(e: React.MouseEvent, remote: RemoteInfo) {
    e.preventDefault();
    const items: MenuItem[] = [
      {
        label: `Fetch ${remote.name}`,
        onClick: () =>
          run(async () => {
            const result = await gitNetwork(path, "fetch", remote.name, ["--prune"]);
            if (!result.success) throw new Error(result.output);
          }, `Fetched ${remote.name}`),
      },
      { separator: true },
      {
        label: "Copy URL",
        disabled: !remote.url,
        onClick: () => remote.url && copyText(remote.url),
      },
      {
        label: "Edit URL…",
        onClick: async () => {
          const url = await promptDialog({
            title: `URL for ${remote.name}`,
            label: "Remote URL",
            defaultValue: remote.url ?? "",
            confirmLabel: "Save",
            validate: validateCloneUrl,
          });
          if (url && url.trim() !== remote.url) {
            run(() => setRemoteUrl(path, remote.name, url.trim()), "Remote URL updated");
          }
        },
      },
      {
        label: "Rename…",
        onClick: async () => {
          const next = await promptDialog({
            title: "Rename remote",
            label: "New name",
            defaultValue: remote.name,
            confirmLabel: "Rename",
            validate: (value) =>
              value.trim() === remote.name ? null : validateRemoteName(value, remotes ?? []),
          });
          if (!next || next.trim() === remote.name) return;
          run(async () => {
            // git2 reports refspecs it could not rewrite instead of failing;
            // a silent partial rename leaves a remote that fetches nothing.
            const problems = await renameRemote(path, remote.name, next.trim());
            if (problems.length) {
              pushToast("info", `Renamed, but these refspecs need attention: ${problems.join(", ")}`);
            } else {
              pushToast("success", `Renamed to ${next.trim()}`);
            }
          });
        },
      },
      { separator: true },
      {
        label: "Remove remote",
        danger: true,
        onClick: async () => {
          const ok = await confirmDialog({
            title: "Remove remote",
            message: `Remove "${remote.name}"?\n\nIts ${remote.branches} remote-tracking branch(es) go with it. Nothing is deleted on the server.`,
            confirmLabel: "Remove",
            danger: true,
          });
          if (ok) run(() => removeRemote(path, remote.name), `Removed ${remote.name}`);
        },
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  /**
   * Push-tag rows: one per remote when there is more than one, so picking a
   * remote never silently means "origin".
   */
  function pushTagItems(tag: BranchInfo): MenuItem[] {
    const names = (remotes ?? []).map((r) => r.name);
    if (!names.length) return [{ label: "Push tag (no remote configured)", disabled: true }];
    const pushTo = (remote: string) =>
      run(async () => {
        const result = await gitNetwork(path, "push", remote, [`refs/tags/${tag.name}`]);
        if (!result.success) throw new Error(result.output);
      }, `Pushed tag ${tag.name} to ${remote}`);
    if (names.length === 1) {
      return [{ label: `Push tag to ${names[0]}`, onClick: () => pushTo(names[0]) }];
    }
    return names.map((remote) => ({
      label: `Push tag to ${remote}`,
      onClick: () => pushTo(remote),
    }));
  }

  function tagMenu(e: React.MouseEvent, tag: BranchInfo) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Copy SHA", onClick: () => copyText(tag.oid) },
        // `03-push.md` §5 (STATUS B2). A tag nobody can push is a tag that
        // only exists on one machine, and `git_network` has always been able
        // to push a refspec — the entry point was simply missing.
        ...pushTagItems(tag),
        { separator: true },
        {
          label: "Delete tag",
          danger: true,
          onClick: async () => {
            if (await confirmDialog({ title: "Delete tag", message: `Delete tag "${tag.name}"?`, confirmLabel: "Delete", danger: true })) {
              run(() => deleteTag(path, tag.name), "Tag deleted");
            }
          },
        },
      ],
    });
  }

  // These only toast. The banner comes from `refreshRepo` re-reading git, so
  // that a conflict looks the same whoever caused it (overview §5.1).
  function reportMerge(res: Awaited<ReturnType<typeof mergeAdvanced>>) {
    if (res.kind === "conflicts") {
      pushToast("error", `Merge paused — ${res.conflicts.length} conflicted file(s).`);
    } else if (res.kind === "upToDate") {
      pushToast("info", "Already up to date.");
    } else {
      pushToast("success", `Merged (${res.kind}).`);
    }
  }

  function reportRebase(r: Awaited<ReturnType<typeof rebaseStandard>>, commits?: number) {
    if (!r.success) {
      pushToast("error", `Rebase paused — ${r.conflicts.length} conflicted file(s).`);
    } else if (commits === 0) {
      // `06-rebase.md` B7: onto an ancestor there was nothing to replay, and
      // reporting a successful rebase of nothing reads as a no-op that failed.
      pushToast("info", "Already up to date.");
    } else {
      pushToast("success", "Rebase complete");
    }
  }

  function addMenu(e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        {
          label: "New branch…",
          onClick: async () => {
            const name = await promptDialog({
              title: "Create branch",
              label: "Branch name",
              placeholder: "feature/x",
              confirmLabel: "Create",
              validate: validateRefName,
            });
            if (name) run(() => createBranch(path, name, undefined, true), `Created ${name}`);
          },
        },
        {
          label: "New tag…",
          onClick: async () => {
            if (!repo!.head.oid) return;
            const name = await promptDialog({
              title: "Create tag",
              label: "Tag name",
              confirmLabel: "Create",
              validate: validateRefName,
            });
            if (name) run(() => createTag(path, name, repo!.head.oid!), `Tagged ${name}`);
          },
        },
        { separator: true },
        { label: "Add remote…", onClick: addRemoteFlow },
      ],
    });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-seg">
        <button className="seg-btn active">☰ List</button>
        <button className="sidebar-collapse" title="Collapse sidebar" onClick={toggleSidebar}>
          ‹
        </button>
      </div>
      <div className="sidebar-viewing">Viewing {viewing}</div>

      <div className="sidebar-top">
        <input
          ref={filterRef}
          className="sidebar-filter"
          placeholder={`Filter (${FILTER_HINT})`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button title="New branch / tag" onClick={addMenu}>
          +
        </button>
      </div>

      <div className="sidebar-scroll">
        <BranchSection
          title="Local"
          icon="branch"
          items={localItems}
          local
          onOpen={(b) => selectOid(b.oid)}
          onCheckout={(b) => doCheckout(b.name)}
          onMenu={branchMenu}
          headBranch={headBranch}
          dragged={dragged}
          setDragged={setDragged}
          // A menu at the cursor, not a modal (STATUS C5) — the graph already
          // did it this way, and the same gesture must not behave differently
          // depending on where it lands. Both sites now share `dropMenuItems`,
          // which is also what computes whether a fast-forward is possible.
          onDropMerge={async (event, target, source) => {
            if (target === source) return;
            const { clientX, clientY } = event;
            const relation = await mergeRelation(path, target, source).catch(() => null);
            setMenu({
              x: clientX,
              y: clientY,
              items: dropMenuItems(target, source, relation, (action) =>
                run(async () => {
                  if (headBranch !== target) await smartCheckout(path, target);
                  if (action === "rebase") return doRebase(source);
                  return doMerge(source, action === "ff" ? "ffOnly" : "noFf");
                }),
              ),
            });
          }}
          hiddenRefs={hiddenRefs}
          onToggleHidden={(name) => toggleHiddenRef(path, name)}
          checkoutTarget={checkoutTarget}
        />
        <RemoteSection
          remotes={remotes ?? []}
          items={remoteItems}
          filtering={!!f}
          onAddRemote={addRemoteFlow}
          onRemoteMenu={remoteMenu}
          onOpen={(b) => selectOid(b.oid)}
          onCheckout={(b) => doCheckout(b.name)}
          onMenu={(e, b) => branchMenu(e, b, false)}
          setDragged={setDragged}
          hiddenRefs={hiddenRefs}
          onToggleHidden={(name) => toggleHiddenRef(path, name)}
          checkoutTarget={checkoutTarget}
        />
        <PlainSection
          title="Tags"
          icon="tag"
          items={tagItems}
          onOpen={(b) => selectOid(b.oid)}
          onMenu={tagMenu}
        />

        <div className="section">
          <div className="section-header">
            <span className="sec-icon"><Icon name="worktree" /></span>
            Worktrees
            <span className="count">{worktrees?.length ?? 0}</span>
            <button
              className="section-add"
              title="Add worktree…"
              onClick={(event) => {
                event.stopPropagation();
                addWorktreeFlow();
              }}
            >
              +
            </button>
          </div>
          {(worktrees ?? []).map((w) => (
            <div
              key={w.path}
              className={`ref-item${w.isCurrent ? " head" : ""}`}
              style={{ paddingLeft: 20 }}
              title={`${w.path}${w.changed === null ? " (unreadable)" : ""}`}
              onDoubleClick={() => !w.isCurrent && openRepo(w.path).then(setRepo).catch(toastError)}
              onContextMenu={(e) => worktreeMenu(e, w)}
            >
              <span className="ref-icon"><Icon name={w.isCurrent ? "check" : "worktree"} /></span>
              <span className="ref-name">{w.name}</span>
              {w.branch && <span className="wt-branch">{w.branch}</span>}
              {w.locked && <span className="wt-flag" title="Locked">🔒</span>}
              {/* null means the worktree could not be opened — "unknown", not "clean". */}
              {w.changed === null ? (
                <span className="wt-flag" title="Could not read this worktree">?</span>
              ) : w.changed > 0 ? (
                <span className="wt-flag dirty" title={`${w.changed} changed file(s)`}>
                  <Icon name="pencil" size={10} />
                  {w.changed}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        {stashes && stashes.length > 0 && (
          <div className="section">
            <SectionHead title="Stashes" icon="stash" count={stashes.length} />
            {stashes.map((s) => (
              <div
                key={s.oid}
                className="ref-item"
                style={{ paddingLeft: 20 }}
                title={s.message}
                onClick={() => selectOid(s.oid)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: "Apply", onClick: () => run(() => stashApply(path, s.index), "Stash applied") },
                      { label: "Pop", onClick: () => run(() => stashPop(path, s.index), "Stash popped") },
                      { label: "Drop", danger: true, onClick: () => run(() => stashDrop(path, s.index), "Stash dropped") },
                    ],
                  });
                }}
              >
                <span className="ref-icon"><Icon name="stash" /></span>
                <span className="ref-name">{s.message}</span>
              </div>
            ))}
          </div>
        )}

        <ContributorSection
          items={contributors ?? []}
          onFilter={(c) => seedSearch(path, `author:${c.email}`, true)}
          onSelect={(c) => selectOid(c.lastCommit)}
          onMenu={(event, c) => {
            event.preventDefault();
            setMenu({
              x: event.clientX,
              y: event.clientY,
              items: [
                { label: "Filter graph by this author", onClick: () => seedSearch(path, `author:${c.email}`, true) },
                { label: "Go to their latest commit", onClick: () => selectOid(c.lastCommit) },
                { label: "Copy name and email", onClick: () => copyText(`${c.name} <${c.email}>`) },
                {
                  label: "Copy Co-authored-by trailer",
                  onClick: () => copyText(`Co-authored-by: ${c.name} <${c.email}>`),
                },
              ],
            });
          }}
        />

        <div className="section">
          <SectionHead title="Submodules" icon="commit" count={submodules?.length ?? 0} />
          {(submodules ?? []).map((submodule) => (
            <div
              key={submodule.path}
              className="ref-item"
              style={{ paddingLeft: 20 }}
              title={submodule.url ?? submodule.path}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  items: [
                    { label: "Update submodules", onClick: () => run(() => updateSubmodules(path), "Submodules updated") },
                    { label: "Open folder", onClick: () => openPath(`${path}/${submodule.path}`).catch(toastError) },
                    { label: "Copy path", onClick: () => copyText(submodule.path) },
                  ],
                });
              }}
            >
              <span className="ref-icon">
                <Icon name="commit" />
              </span>
              <span className="ref-name">{submodule.name}</span>
              <span className="ref-count">{submodule.oid?.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}

/**
 * CONTRIBUTORS (G28).
 *
 * Collapsed by default and capped, because it is a reference list rather than
 * a navigation tree: a repository with four hundred contributors would push
 * every other section off the screen to show information nobody scrolls to.
 * "Show all" is there for when they do.
 */
function ContributorSection({
  items,
  onFilter,
  onSelect,
  onMenu,
}: {
  items: Contributor[];
  onFilter: (c: Contributor) => void;
  onSelect: (c: Contributor) => void;
  onMenu: (event: React.MouseEvent, c: Contributor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 8);

  return (
    <div className="section">
      <SectionHead
        title="Contributors"
        icon="person"
        count={items.length}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open &&
        shown.map((c) => (
          <div
            key={c.email}
            className="ref-item contributor"
            style={{ paddingLeft: 20 }}
            title={`${c.name} <${c.email}>\n${c.commits} commit(s)${
              c.coAuthored ? `, ${c.coAuthored} co-authored` : ""
            } · last ${timeAgo(c.lastTimestamp)}`}
            onClick={() => onSelect(c)}
            onDoubleClick={() => onFilter(c)}
            onContextMenu={(event) => onMenu(event, c)}
          >
            <Avatar email={c.email} name={c.name} size={16} />
            <span className="ref-name">{c.name || c.email}</span>
            <span className="ref-count">
              {c.commits}
              {c.coAuthored > 0 && <span className="contributor-co" title="Co-authored">+{c.coAuthored}</span>}
            </span>
          </div>
        ))}
      {open && items.length > shown.length && (
        <button className="section-more" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      )}
    </div>
  );
}

function RailIcon({ icon, count, onClick }: { icon: IconName; count: number; onClick: () => void }) {
  return (
    <button className="rail-icon" onClick={onClick} title={`${count}`}>
      <span><Icon name={icon} size={15} /></span>
      <span className="rail-count">{count}</span>
    </button>
  );
}

function SectionHead({
  title,
  icon,
  count,
  open,
  onToggle,
}: {
  title: string;
  icon: IconName;
  count: number;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="section-header" onClick={onToggle}>
      {onToggle && <span className="caret">{open ? "▾" : "▸"}</span>}
      <span className="sec-icon"><Icon name={icon} /></span>
      {title}
      <span className="count">{count}</span>
    </div>
  );
}

function groupByFolder(items: BranchInfo[]): [string, BranchInfo[]][] {
  const groups = new Map<string, BranchInfo[]>();
  for (const b of items) {
    const idx = b.name.indexOf("/");
    const key = idx > 0 ? b.name.slice(0, idx) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function BranchSection({
  title,
  icon,
  items,
  local,
  onOpen,
  onCheckout,
  onMenu,
  headBranch,
  dragged,
  setDragged,
  onDropMerge,
  hiddenRefs,
  onToggleHidden,
  checkoutTarget,
}: {
  title: string;
  icon: IconName;
  items: BranchInfo[];
  local?: boolean;
  onOpen: (b: BranchInfo) => void;
  onCheckout: (b: BranchInfo) => void;
  onMenu: (e: React.MouseEvent, b: BranchInfo, local: boolean) => void;
  headBranch?: string | null;
  dragged: string | null;
  setDragged: (s: string | null) => void;
  onDropMerge?: (event: React.DragEvent, target: string, source: string) => void;
  hiddenRefs: string[];
  onToggleHidden: (name: string) => void;
  checkoutTarget: string | null;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="section">
      <SectionHead title={title} icon={icon} count={items.length} open={open} onToggle={() => setOpen((o) => !o)} />
      {open &&
        groupByFolder(items).map(([folder, branches]) => (
          <div key={folder || "_root"}>
            {folder && <div className="folder">📁 {folder}</div>}
            {branches.map((b) => (
              <div
                key={b.name}
                className={`ref-item${b.isHead ? " head" : ""}${dragged && dragged !== b.name && local ? " droppable" : ""}`}
                style={{ paddingLeft: folder ? 34 : 20 }}
                title={
                  b.upstreamGone
                    ? `${b.name} — its upstream ${b.upstream} is gone from the remote`
                    : b.upstream
                      ? `tracks ${b.upstream}`
                      : b.name
                }
                draggable
                onDragStart={() => setDragged(b.name)}
                onDragEnd={() => setDragged(null)}
                onDragOver={(e) => local && e.preventDefault()}
                onDrop={(e) => {
                  if (local && dragged && onDropMerge) onDropMerge(e, b.name, dragged);
                  setDragged(null);
                }}
                onClick={() => onOpen(b)}
                onDoubleClick={() => onCheckout(b)}
                onContextMenu={(e) => onMenu(e, b, !!local)}
              >
                <span className={`ref-icon${checkoutTarget === b.name ? " spinning" : ""}`}>
                  <Icon name={checkoutTarget === b.name ? "pending" : b.isHead ? "check" : local ? "branch" : "cloud"} />
                </span>
                <span className="ref-name">{folder ? b.name.slice(folder.length + 1) : b.name}</span>
                {b.upstreamGone && (
                  /* Not an error tone: a merged-and-deleted branch is the
                     normal end of a branch's life, not a fault. */
                  <span className="upstream-gone" title={`${b.upstream} is gone from the remote`}>
                    orphaned
                  </span>
                )}
                {(b.ahead || b.behind) && (
                  <span className="ahead-behind">
                    {b.ahead ? <span className="ahead">↑{b.ahead}</span> : null}
                    {b.behind ? <span className="behind">↓{b.behind}</span> : null}
                  </span>
                )}
                {b.isHead && <span className="head-dot" title={`HEAD: ${headBranch}`} />}
                <button
                  className="ref-eye"
                  title={hiddenRefs.includes(b.name) ? "Show in graph" : "Hide from graph"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleHidden(b.name);
                  }}
                >
                  <Icon name={hiddenRefs.includes(b.name) ? "eye-off" : "eye"} size={13} />
                </button>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

/**
 * REMOTE, grouped by remote (G4).
 *
 * The remotes come from `list_remotes` rather than from the branch-name
 * prefixes, because a remote with no fetched branches is exactly the one the
 * user needs to see — the one they just added. Prefixes with no configured
 * remote are still shown, under "(not configured)": those are tracking refs
 * left behind by a removed remote, and hiding them would make refs the graph
 * still draws unreachable from the sidebar.
 */
function RemoteSection({
  remotes,
  items,
  filtering,
  onAddRemote,
  onRemoteMenu,
  onOpen,
  onCheckout,
  onMenu,
  setDragged,
  hiddenRefs,
  onToggleHidden,
  checkoutTarget,
}: {
  remotes: RemoteInfo[];
  items: BranchInfo[];
  /** True while the sidebar filter is narrowing `items`. */
  filtering: boolean;
  onAddRemote: () => void;
  onRemoteMenu: (e: React.MouseEvent, remote: RemoteInfo) => void;
  onOpen: (b: BranchInfo) => void;
  onCheckout: (b: BranchInfo) => void;
  onMenu: (e: React.MouseEvent, b: BranchInfo, local: boolean) => void;
  /** Remote branches are drag *sources* (onto a local branch), never targets. */
  setDragged: (s: string | null) => void;
  hiddenRefs: string[];
  onToggleHidden: (name: string) => void;
  checkoutTarget: string | null;
}) {
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const byRemote = new Map<string, BranchInfo[]>();
  for (const remote of remotes) byRemote.set(remote.name, []);
  for (const branch of items) {
    // Longest configured-remote prefix wins: a remote may itself contain a
    // slash-free name, but "origin/feature/x" must not be filed under
    // "origin/feature".
    const owner =
      remotes
        .map((r) => r.name)
        .filter((name) => branch.name.startsWith(`${name}/`))
        .sort((a, b) => b.length - a.length)[0] ?? branch.name.split("/")[0];
    if (!byRemote.has(owner)) byRemote.set(owner, []);
    byRemote.get(owner)!.push(branch);
  }

  const configured = new Set(remotes.map((r) => r.name));
  const total = items.length;
  // While filtering, a remote whose every branch was filtered out is noise —
  // and its "no fetched branches yet" empty state would be a lie.
  const groups = [...byRemote.entries()].filter(([, branches]) => !filtering || branches.length);

  return (
    <div className="section">
      <div className="section-header" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="sec-icon"><Icon name="cloud" /></span>
        Remote
        <span className="count">{total}</span>
        <button
          className="section-add"
          title="Add remote…"
          onClick={(event) => {
            event.stopPropagation();
            onAddRemote();
          }}
        >
          +
        </button>
      </div>

      {open && groups.length === 0 && !filtering && (
        <div className="section-empty">
          No remotes. <button className="link-btn" onClick={onAddRemote}>Add one</button>
        </div>
      )}

      {open &&
        groups.map(([name, branches]) => {
          const remote = remotes.find((r) => r.name === name);
          const shut = collapsed[name];
          return (
            <div key={name}>
              <div
                className="remote-node"
                title={remote?.url ?? "no remote configured for these refs"}
                onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}
                onContextMenu={(event) => remote && onRemoteMenu(event, remote)}
              >
                <span className="caret">{shut ? "▸" : "▾"}</span>
                <span className="ref-icon"><Icon name="cloud" /></span>
                <span className="ref-name">{name}</span>
                {!configured.has(name) && <span className="remote-orphan">not configured</span>}
                <span className="ref-count">{branches.length}</span>
              </div>
              {!shut &&
                branches.map((b) => (
                  <div
                    key={b.name}
                    className="ref-item"
                    style={{ paddingLeft: 36 }}
                    title={b.name}
                    draggable
                    onDragStart={() => setDragged(b.name)}
                    onDragEnd={() => setDragged(null)}
                    onClick={() => onOpen(b)}
                    onDoubleClick={() => onCheckout(b)}
                    onContextMenu={(e) => onMenu(e, b, false)}
                  >
                    <span className={`ref-icon${checkoutTarget === b.name ? " spinning" : ""}`}>
                      <Icon name={checkoutTarget === b.name ? "pending" : "cloud"} />
                    </span>
                    <span className="ref-name">
                      {b.name.startsWith(`${name}/`) ? b.name.slice(name.length + 1) : b.name}
                    </span>
                    <button
                      className="ref-eye"
                      title={hiddenRefs.includes(b.name) ? "Show in graph" : "Hide from graph"}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleHidden(b.name);
                      }}
                    >
                      <Icon name={hiddenRefs.includes(b.name) ? "eye-off" : "eye"} size={13} />
                    </button>
                  </div>
                ))}
              {!shut && branches.length === 0 && (
                <div className="section-empty" style={{ paddingLeft: 36 }}>
                  No fetched branches yet.
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

function PlainSection({
  title,
  items,
  onOpen,
  onMenu,
  icon,
}: {
  title: string;
  items: BranchInfo[];
  onOpen: (b: BranchInfo) => void;
  onMenu?: (e: React.MouseEvent, b: BranchInfo) => void;
  icon: IconName;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="section">
      <SectionHead title={title} icon={icon} count={items.length} open={open} onToggle={() => setOpen((o) => !o)} />
      {open &&
        items.map((b) => (
          <div
            key={b.name}
            className="ref-item"
            style={{ paddingLeft: 20 }}
            onClick={() => onOpen(b)}
            onContextMenu={onMenu ? (e) => onMenu(e, b) : undefined}
          >
            <span className="ref-icon">{icon}</span>
            <span className="ref-name">{b.name}</span>
          </div>
        ))}
    </div>
  );
}
