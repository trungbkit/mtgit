import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  checkout,
  createBranch,
  createTag,
  gitNetwork,
  listRefs,
  openRepo,
  stashSave,
  stashList,
  stashPop,
} from "../../ipc/commands";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import "./toolbar.css";

export function Toolbar() {
  const repo = useSession((s) => s.repo);
  const setRepo = useSession((s) => s.setRepo);
  const recentRepos = useSession((s) => s.recentRepos);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const setPaletteOpen = useSession((s) => s.setPaletteOpen);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo,
    queryFn: () => listRefs(repo!.path),
  });

  const refresh = () => repo && qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repo.path });

  async function run(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) pushToast("success", ok);
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function load(path: string) {
    setBusy(true);
    try {
      setRepo(await openRepo(path));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: "Open repository" });
      if (typeof selected === "string") await load(selected);
    } catch (e) {
      toastError(e);
    }
  }

  async function net(op: "fetch" | "pull" | "push", extra?: string[]) {
    if (!repo) return;
    try {
      const res = await gitNetwork(repo.path, op, undefined, extra);
      if (res.success) pushToast("success", `${op} complete`);
      else pushToast("error", `${op} failed: ${res.output.split("\n").pop() ?? ""}`);
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  function openMenu(e: React.MouseEvent, items: MenuItem[]) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items });
  }

  function repoMenu(e: React.MouseEvent) {
    const items: MenuItem[] = [{ label: "Open repository…", onClick: pick }];
    if (recentRepos.length) {
      items.push({ separator: true });
      for (const p of recentRepos) {
        items.push({ label: p.split("/").pop() || p, onClick: () => load(p) });
      }
    }
    openMenu(e, items);
  }

  function branchMenu(e: React.MouseEvent) {
    if (!repo) return;
    const locals = refs?.local ?? [];
    const items: MenuItem[] = locals.length
      ? locals.map((b) => ({
          label: (b.isHead ? "● " : "  ") + b.name,
          onClick: () => run(() => checkout(repo.path, b.name), `Checked out ${b.name}`),
        }))
      : [{ label: "No branches", disabled: true }];
    openMenu(e, items);
  }

  async function newBranch() {
    if (!repo) return;
    const name = await promptDialog({
      title: "Create branch",
      label: "Branch name",
      placeholder: "feature/x",
      confirmLabel: "Create",
      validate: validateRefName,
    });
    if (name) run(() => createBranch(repo.path, name, undefined, true), `Created ${name}`);
  }

  async function newTag() {
    if (!repo || !repo.head.oid) return;
    const name = await promptDialog({
      title: "Create tag",
      label: "Tag name",
      confirmLabel: "Create",
      validate: validateRefName,
    });
    if (name) run(() => createTag(repo.path, name, repo.head.oid!), `Tagged ${name}`);
  }

  const head = repo?.head.branch ?? (repo?.head.detached ? "detached" : "—");

  return (
    <header className="toolbar">
      {/* Repository + branch selectors */}
      <div className="tb-selectors">
        <div className="tb-field">
          <label>repository</label>
          <button
            className="tb-select"
            disabled={busy}
            onClick={(e) => (repo ? repoMenu(e) : pick())}
            title={repo?.path ?? "Open a repository"}
          >
            <span className="tb-select-text">{busy ? "Opening…" : repo?.name ?? "Open…"}</span>
            <span className="tb-caret">▾</span>
          </button>
        </div>
        <div className="tb-field">
          <label>branch</label>
          <button className="tb-select" disabled={!repo} onClick={branchMenu}>
            <span className="tb-select-text">{head}</span>
            <span className="tb-caret">▾</span>
          </button>
        </div>
        <button
          className="tb-target"
          title="Fetch"
          disabled={!repo}
          onClick={() => net("fetch")}
        >
          ⟳
        </button>
      </div>

      <div className="tb-sep" />

      {/* History group */}
      <div className="tb-group">
        <ToolBtn icon="↶" label="Undo" disabled title="Undo (unavailable)" />
        <ToolBtn icon="↷" label="Redo" disabled title="Redo (unavailable)" />
      </div>

      <div className="tb-sep" />

      {/* Remote / branch actions */}
      <div className="tb-group">
        <ToolBtn
          icon="⭳"
          label="Pull"
          disabled={!repo}
          onClick={() => net("pull")}
          onCaret={(e) =>
            openMenu(e, [
              { label: "Pull", onClick: () => net("pull") },
              { label: "Pull (rebase)", onClick: () => net("pull", ["--rebase"]) },
              { label: "Fetch", onClick: () => net("fetch") },
              { label: "Fetch (prune)", onClick: () => net("fetch", ["--prune"]) },
            ])
          }
        />
        <ToolBtn
          icon="⭱"
          label="Push"
          disabled={!repo}
          onClick={() => net("push")}
          onCaret={(e) =>
            openMenu(e, [
              { label: "Push", onClick: () => net("push") },
              {
                label: "Force push (with lease)",
                danger: true,
                onClick: () => net("push", ["--force-with-lease"]),
              },
            ])
          }
        />
        <ToolBtn icon="⑂" label="Branch" disabled={!repo} onClick={newBranch} />
        <ToolBtn
          icon="⇩"
          label="Stash"
          disabled={!repo}
          onClick={() => repo && run(() => stashSave(repo.path, undefined, true), "Stashed")}
        />
        <ToolBtn
          icon="⇧"
          label="Pop"
          disabled={!repo}
          onClick={() =>
            repo &&
            run(async () => {
              const list = await stashList(repo.path);
              if (!list.length) throw new Error("No stashes to pop");
              return stashPop(repo.path, list[0].index);
            }, "Stash popped")
          }
        />
        <ToolBtn icon="▤" label="Terminal" disabled={!repo} onClick={() => repo && toggleTerminal()} />
      </div>

      <div className="tb-spacer" />

      <div className="tb-group tb-right">
        <ToolBtn
          icon="⚙"
          label="Actions"
          disabled={!repo}
          onClick={(e) =>
            openMenu(e, [
              { label: "New branch…", onClick: newBranch },
              { label: "New tag…", onClick: newTag },
              { separator: true },
              { label: "Fetch", onClick: () => net("fetch") },
              { label: "Fetch (prune)", onClick: () => net("fetch", ["--prune"]) },
              { label: "Open terminal", onClick: () => repo && toggleTerminal() },
            ])
          }
        />
        <ToolBtn icon="🔍" label="Search" onClick={() => setPaletteOpen(true)} />
        <ToolBtn icon="▥" label="Layout" onClick={toggleSidebar} />
      </div>

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </header>
  );
}

function ToolBtn({
  icon,
  label,
  onClick,
  onCaret,
  disabled,
  title,
}: {
  icon: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  onCaret?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className={`tb-action${disabled ? " disabled" : ""}`}>
      <button className="tb-action-main" disabled={disabled} onClick={onClick} title={title ?? label}>
        <span className="tb-icon">{icon}</span>
        <span className="tb-label">{label}</span>
      </button>
      {onCaret && (
        <button className="tb-action-caret" disabled={disabled} onClick={onCaret} title={`${label} options`}>
          ▾
        </button>
      )}
    </div>
  );
}
