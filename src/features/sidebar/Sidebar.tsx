import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  checkout,
  createBranch,
  deleteBranch,
  listRefs,
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
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import "./sidebar.css";

export function Sidebar() {
  const repo = useSession((s) => s.repo);
  const selectOid = useSession((s) => s.selectOid);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);
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

  function branchMenu(e: React.MouseEvent, b: BranchInfo, local: boolean) {
    e.preventDefault();
    const items: MenuItem[] = [{ label: "Checkout", onClick: () => doCheckout(b.name) }];
    if (local) {
      items.push(
        {
          label: "Rename…",
          onClick: () => {
            const nn = prompt("New branch name", b.name);
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
          onClick: () =>
            run(() =>
              rebaseOnto(path, b.name).then((r) =>
                r.done
                  ? pushToast("success", `Rebased ${r.applied} commit(s)`)
                  : pushToast("error", `Rebase conflict in ${r.conflicts.length} file(s) — aborted.`),
              ),
            ),
        },
        {
          label: "Delete",
          danger: true,
          disabled: b.isHead,
          onClick: () => {
            if (confirm(`Delete branch ${b.name}?`)) run(() => deleteBranch(path, b.name), "Deleted");
          },
        },
      );
    } else {
      items.push({
        label: "Merge into current",
        onClick: () => run(() => mergeRef(path, b.name).then(reportMerge)),
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function reportMerge(res: Awaited<ReturnType<typeof mergeRef>>) {
    if (res.kind === "conflicts") {
      pushToast("error", `Merge has conflicts in ${res.conflicts.length} file(s) — resolve externally.`);
    } else if (res.kind === "upToDate") {
      pushToast("info", "Already up to date.");
    } else {
      pushToast("success", `Merged (${res.kind}).`);
    }
  }

  function newBranch() {
    const name = prompt("New branch name");
    if (name) run(() => createBranch(path, name, undefined, true), `Created ${name}`);
  }

  const f = filter.trim().toLowerCase();
  const match = (b: BranchInfo) => !f || b.name.toLowerCase().includes(f);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input
          className="sidebar-filter"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button title="New branch" onClick={newBranch}>
          +
        </button>
      </div>

      <div className="sidebar-scroll">
        <BranchSection
          title="Local"
          items={(data?.local ?? []).filter(match)}
          local
          onOpen={(b) => selectOid(b.oid)}
          onCheckout={(b) => doCheckout(b.name)}
          onMenu={branchMenu}
          headBranch={headBranch}
          dragged={dragged}
          setDragged={setDragged}
          onDropMerge={(target, source) => {
            if (target !== source) {
              if (confirm(`Merge ${source} into ${target}?`)) {
                run(async () => {
                  if (headBranch !== target) await checkout(path, target);
                  return mergeRef(path, source).then(reportMerge);
                });
              }
            }
          }}
        />
        <BranchSection
          title="Remote"
          items={(data?.remote ?? []).filter(match)}
          onOpen={(b) => selectOid(b.oid)}
          onCheckout={(b) => doCheckout(b.name)}
          onMenu={(e, b) => branchMenu(e, b, false)}
          dragged={dragged}
          setDragged={setDragged}
        />
        <PlainSection title="Tags" items={(data?.tags ?? []).filter(match)} onOpen={(b) => selectOid(b.oid)} icon="🏷" />

        {stashes && stashes.length > 0 && (
          <div className="section">
            <div className="section-header">
              Stashes<span className="count">{stashes.length}</span>
            </div>
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
      <div className="section-header" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        {title}
        <span className="count">{items.length}</span>
      </div>
      {open &&
        groupByFolder(items).map(([folder, branches]) => (
          <div key={folder || "_root"}>
            {folder && <div className="folder">{folder}</div>}
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
  icon,
}: {
  title: string;
  items: BranchInfo[];
  onOpen: (b: BranchInfo) => void;
  icon: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="section">
      <div className="section-header" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        {title}
        <span className="count">{items.length}</span>
      </div>
      {open &&
        items.map((b) => (
          <div key={b.name} className="ref-item" style={{ paddingLeft: 20 }} onClick={() => onOpen(b)}>
            <span className="ref-icon">{icon}</span>
            <span className="ref-name">{b.name}</span>
          </div>
        ))}
    </div>
  );
}
