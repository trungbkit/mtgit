import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  checkout,
  createBranch,
  createTag,
  deleteBranch,
  deleteRemoteBranch,
  deleteTag,
  listRefs,
  listWorktrees,
  mergeRef,
  rebaseOnto,
  renameBranch,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
} from "../../ipc/commands";
import type { BranchInfo } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { useConflict } from "../../stores/conflict";
import { confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { copyText } from "../../lib/clipboard";
import "./sidebar.css";

export function Sidebar() {
  const repo = useSession((s) => s.repo);
  const selectOid = useSession((s) => s.selectOid);
  const collapsed = useSession((s) => s.sidebarCollapsed);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
  const setConflict = useConflict((s) => s.set);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);

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

  if (!repo) return <aside className="sidebar" />;
  const path = repo.path;
  const headBranch = repo.head.branch;

  const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === path });
  async function run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) pushToast("success", ok);
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function doCheckout(name: string) {
    await run(() => checkout(path, name), `Checked out ${name}`);
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
        <RailIcon icon="🖥" count={data?.local.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="☁" count={data?.remote.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="🏷" count={data?.tags.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="🌿" count={worktrees?.length ?? 0} onClick={toggleSidebar} />
        <RailIcon icon="≡" count={stashes?.length ?? 0} onClick={toggleSidebar} />
      </aside>
    );
  }

  function branchMenu(e: React.MouseEvent, b: BranchInfo, local: boolean) {
    e.preventDefault();
    const items: MenuItem[] = [{ label: "Checkout", onClick: () => doCheckout(b.name) }];
    if (local) {
      items.push(
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
          onClick: () => run(() => mergeRef(path, b.name, "default").then(reportMerge)),
          disabled: b.isHead,
        },
        {
          label: `Merge into ${headBranch ?? "HEAD"} (no-ff)`,
          onClick: () => run(() => mergeRef(path, b.name, "noFf").then(reportMerge)),
          disabled: b.isHead,
        },
        {
          label: `Merge into ${headBranch ?? "HEAD"} (ff-only)`,
          onClick: () => run(() => mergeRef(path, b.name, "ffOnly").then(reportMerge)),
          disabled: b.isHead,
        },
        {
          label: `Rebase ${headBranch ?? "HEAD"} onto ${b.name}`,
          disabled: b.isHead,
          onClick: () => run(() => rebaseOnto(path, b.name).then(reportRebase)),
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
          onClick: () => run(() => mergeRef(path, b.name).then(reportMerge)),
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

  function tagMenu(e: React.MouseEvent, tag: BranchInfo) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Copy SHA", onClick: () => copyText(tag.oid) },
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

  function reportMerge(res: Awaited<ReturnType<typeof mergeRef>>) {
    if (res.kind === "conflicts") {
      setConflict({ repoPath: path, kind: "merge", files: res.conflicts });
      pushToast("error", `Merge paused — ${res.conflicts.length} conflicted file(s).`);
    } else if (res.kind === "upToDate") {
      pushToast("info", "Already up to date.");
    } else {
      pushToast("success", `Merged (${res.kind}).`);
    }
  }

  function reportRebase(r: Awaited<ReturnType<typeof rebaseOnto>>) {
    if (r.done) {
      pushToast("success", `Rebased ${r.applied} commit(s)`);
    } else {
      setConflict({ repoPath: path, kind: "rebase", files: r.conflicts });
      pushToast("error", `Rebase paused — ${r.conflicts.length} conflicted file(s).`);
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
          className="sidebar-filter"
          placeholder="Filter (⌘ Option + f)"
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
          icon="🖥"
          items={localItems}
          local
          onOpen={(b) => selectOid(b.oid)}
          onCheckout={(b) => doCheckout(b.name)}
          onMenu={branchMenu}
          headBranch={headBranch}
          dragged={dragged}
          setDragged={setDragged}
          onDropMerge={async (target, source) => {
            if (target === source) return;
            const ok = await confirmDialog({
              title: "Merge branches",
              message:
                headBranch === target
                  ? `Merge "${source}" into "${target}"?`
                  : `Check out "${target}" and merge "${source}" into it?`,
              confirmLabel: "Merge",
            });
            if (!ok) return;
            run(async () => {
              if (headBranch !== target) await checkout(path, target);
              return mergeRef(path, source).then(reportMerge);
            });
          }}
        />
        <BranchSection
          title="Remote"
          icon="☁"
          items={remoteItems}
          onOpen={(b) => selectOid(b.oid)}
          onCheckout={(b) => doCheckout(b.name)}
          onMenu={(e, b) => branchMenu(e, b, false)}
          dragged={dragged}
          setDragged={setDragged}
        />
        <PlainSection
          title="Tags"
          icon="🏷"
          items={tagItems}
          onOpen={(b) => selectOid(b.oid)}
          onMenu={tagMenu}
        />

        {worktrees && worktrees.length > 0 && (
          <div className="section">
            <SectionHead title="Worktrees" icon="🌿" count={worktrees.length} />
            {worktrees.map((w) => (
              <div
                key={w.path}
                className="ref-item"
                style={{ paddingLeft: 20 }}
                title={w.path}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: "Open folder", onClick: () => openPath(w.path).catch(toastError) },
                      { label: "Copy path", onClick: () => copyText(w.path) },
                    ],
                  });
                }}
              >
                <span className="ref-icon">🌿</span>
                <span className="ref-name">{w.name}</span>
                {w.branch && <span className="wt-branch">{w.branch}</span>}
              </div>
            ))}
          </div>
        )}

        {stashes && stashes.length > 0 && (
          <div className="section">
            <SectionHead title="Stashes" icon="≡" count={stashes.length} />
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
                <span className="ref-icon">≡</span>
                <span className="ref-name">{s.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </aside>
  );
}

function RailIcon({ icon, count, onClick }: { icon: string; count: number; onClick: () => void }) {
  return (
    <button className="rail-icon" onClick={onClick} title={`${count}`}>
      <span>{icon}</span>
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
  icon: string;
  count: number;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="section-header" onClick={onToggle}>
      {onToggle && <span className="caret">{open ? "▾" : "▸"}</span>}
      <span className="sec-icon">{icon}</span>
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
}: {
  title: string;
  icon: string;
  items: BranchInfo[];
  local?: boolean;
  onOpen: (b: BranchInfo) => void;
  onCheckout: (b: BranchInfo) => void;
  onMenu: (e: React.MouseEvent, b: BranchInfo, local: boolean) => void;
  headBranch?: string | null;
  dragged: string | null;
  setDragged: (s: string | null) => void;
  onDropMerge?: (target: string, source: string) => void;
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
                title={b.upstream ? `tracks ${b.upstream}` : b.name}
                draggable
                onDragStart={() => setDragged(b.name)}
                onDragEnd={() => setDragged(null)}
                onDragOver={(e) => local && e.preventDefault()}
                onDrop={() => {
                  if (local && dragged && onDropMerge) onDropMerge(b.name, dragged);
                  setDragged(null);
                }}
                onClick={() => onOpen(b)}
                onDoubleClick={() => onCheckout(b)}
                onContextMenu={(e) => onMenu(e, b, !!local)}
              >
                <span className="ref-icon">{local ? "⎇" : "☁"}</span>
                <span className="ref-name">{folder ? b.name.slice(folder.length + 1) : b.name}</span>
                {(b.ahead || b.behind) && (
                  <span className="ahead-behind">
                    {b.ahead ? <span className="ahead">↑{b.ahead}</span> : null}
                    {b.behind ? <span className="behind">↓{b.behind}</span> : null}
                  </span>
                )}
                {b.isHead && <span className="head-dot" title={`HEAD: ${headBranch}`} />}
              </div>
            ))}
          </div>
        ))}
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
  icon: string;
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
