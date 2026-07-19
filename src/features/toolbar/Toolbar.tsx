import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  createBranch,
  createTag,
  clearHistory,
  gitAutoFetch,
  gitNetwork,
  historyStatus,
  listRefs,
  openRepo,
  redo,
  setUpstream,
  stashSave,
  stashList,
  stashPop,
  undo,
} from "../../ipc/commands";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { choiceDialog, confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { smartCheckout } from "../../lib/checkout";
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [remoteMutation, setRemoteMutation] = useState(false);

  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo,
    queryFn: () => listRefs(repo!.path),
  });
  const { data: history } = useQuery({
    queryKey: ["historyStatus", repo?.path],
    enabled: !!repo,
    queryFn: () => historyStatus(repo!.path),
  });

  const currentBranch = refs?.local.find((branch) => branch.isHead);
  const ahead = currentBranch?.ahead ?? 0;
  const behind = currentBranch?.behind ?? 0;

  useEffect(() => setRemoteMutation(false), [repo?.path]);

  useEffect(() => {
    if (!repo) return;
    const raw = localStorage.getItem(`mtgit.autoFetch.${repo.path}`);
    const minutes = raw === null ? 1 : Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const fetchNow = () => {
      gitAutoFetch(repo.path)
        .then((result) => {
          if (result.success) {
            setFetchError(null);
            setLastFetch(Date.now());
            refresh();
          } else {
            setFetchError(result.output);
          }
        })
        .catch((error) => setFetchError(String(error)));
    };
    const timer = window.setInterval(fetchNow, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [repo?.path]);

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
      let remote: string | undefined;
      let args = [...(extra ?? [])];
      if (op === "push" && !currentBranch?.upstream) {
        const remotes = [...new Set((refs?.remote ?? []).map((branch) => branch.name.split("/")[0]))];
        if (!currentBranch || remotes.length === 0) throw new Error("No remote is configured for this repository.");
        remote = await choiceDialog({
          title: `Publish ${currentBranch.name}`,
          message: "Choose the remote for this branch. MTGit will set it as the upstream.",
          choices: remotes.map((name) => ({ label: name, value: name })),
        }) ?? undefined;
        if (!remote) return;
        args = ["--set-upstream", remote, currentBranch.name, ...args];
        remote = undefined;
      }
      if (op === "pull") args = [...args, "--autostash"];
      const res = await gitNetwork(repo.path, op, remote, args);
      if (res.success) {
        pushToast("success", `${op} complete`);
        if (op === "push") {
          await clearHistory(repo.path);
          setRemoteMutation(true);
        }
      }
      else if (op === "push" && /non-fast-forward|fetch first|rejected/i.test(res.output)) {
        const recovery = await choiceDialog({
          title: "Push rejected",
          message: res.output,
          choices: [
            { label: "Pull (rebase), then push", value: "rebase" },
            { label: "Pull (merge), then push", value: "merge" },
            { label: "Force push with lease…", value: "force", danger: true },
          ],
        });
        if (recovery === "rebase") {
          await net("pull", ["--rebase"]);
        } else if (recovery === "merge") {
          await net("pull");
        } else if (recovery === "force") {
          await forcePush();
        }
      } else if (op === "pull" && args.includes("--ff-only") && /fast-forward|diverg/i.test(res.output)) {
        const recovery = await choiceDialog({
          title: "Cannot fast-forward",
          message: "The branch has diverged. Choose how to integrate the upstream commits.",
          choices: [
            { label: "Pull (merge)", value: "merge" },
            { label: "Pull (rebase)", value: "rebase" },
          ],
        });
        if (recovery === "merge") await net("pull");
        if (recovery === "rebase") await net("pull", ["--rebase"]);
      } else {
        pushToast("error", `${op} failed: ${res.output || "Unknown git error"}`);
      }
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function forcePush() {
    if (!repo || !currentBranch) return;
    if (
      !(await confirmDialog({
        title: "Force push with lease",
        message: `Rewrite ${currentBranch.upstream ?? currentBranch.name} with local ${currentBranch.name}? This is refused if the remote changed since your last fetch.`,
        confirmLabel: "Force push with lease",
        danger: true,
      }))
    ) {
      return;
    }
    await net("push", ["--force-with-lease"]);
  }

  async function pullFrom(upstream: string, strategy: "merge" | "rebase" | "ffOnly") {
    if (!repo || !currentBranch) return;
    if (!currentBranch.upstream) await setUpstream(repo.path, currentBranch.name, upstream);
    const args = strategy === "rebase" ? ["--rebase"] : strategy === "ffOnly" ? ["--ff-only"] : [];
    await net("pull", args);
  }

  async function defaultPull() {
    if (!repo || !currentBranch) return;
    if (!currentBranch.upstream) {
      const candidates = (refs?.remote ?? []).map((branch) => branch.name);
      const upstream = await choiceDialog({
        title: `Choose upstream for ${currentBranch.name}`,
        message: "Select the remote branch to pull from and track.",
        choices: candidates.map((name) => ({ label: name, value: name })),
      });
      if (!upstream) return;
      return pullFrom(upstream, "merge");
    }
    const strategy =
      (localStorage.getItem(`mtgit.pullStrategy.${repo.path}`) as "merge" | "rebase" | "ffOnly" | null) ??
      "merge";
    return pullFrom(currentBranch.upstream, strategy);
  }

  async function historyAction(kind: "undo" | "redo") {
    if (!repo) return;
    try {
      const result = await (kind === "undo" ? undo(repo.path) : redo(repo.path));
      if (result.restoredMessage) {
        window.dispatchEvent(new CustomEvent("mtgit-restore-commit-message", { detail: result.restoredMessage }));
      }
      pushToast("success", `${kind === "undo" ? "Undid" : "Redid"} local operation.`);
      refresh();
    } catch (error) {
      toastError(error);
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !repo) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        historyAction(event.shiftKey ? "redo" : "undo");
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        if (event.shiftKey) defaultPull();
        else net("push");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
          onClick: () => run(() => smartCheckout(repo.path, b.name), `Checked out ${b.name}`),
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

  async function configureAutoFetch() {
    if (!repo) return;
    const current = localStorage.getItem(`mtgit.autoFetch.${repo.path}`) ?? "1";
    const value = await promptDialog({
      title: "Auto-fetch interval",
      message: "Enter minutes between background fetches. Use 0 to turn auto-fetch off.",
      label: "Minutes",
      defaultValue: current,
      confirmLabel: "Save",
      validate: (text) => {
        const number = Number(text);
        return Number.isFinite(number) && number >= 0 ? null : "Enter 0 or a positive number.";
      },
    });
    if (value !== null) {
      localStorage.setItem(`mtgit.autoFetch.${repo.path}`, value);
      pushToast("info", "Auto-fetch setting saved. It takes effect when the repository is reopened.");
    }
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
          className={`tb-target${fetchError ? " warning" : ""}`}
          title={
            fetchError
              ? `Auto-fetch failed${lastFetch ? `; last success ${new Date(lastFetch).toLocaleTimeString()}` : ""}: ${fetchError}`
              : `Fetch${lastFetch ? ` — last successful ${new Date(lastFetch).toLocaleTimeString()}` : ""}`
          }
          disabled={!repo}
          onClick={() => net("fetch", ["--all", "--prune"])}
        >
          ⟳
        </button>
      </div>

      <div className="tb-sep" />

      {/* History group */}
      <div className="tb-group">
        <ToolBtn
          icon="↶"
          label="Undo"
          disabled={!history?.undoLabel}
          title={history?.undoLabel ? `Undo ${history.undoLabel}` : remoteMutation ? "Remote operations cannot be undone" : "Nothing to undo"}
          onClick={() => historyAction("undo")}
        />
        <ToolBtn
          icon="↷"
          label="Redo"
          disabled={!history?.redoLabel}
          title={history?.redoLabel ? `Redo ${history.redoLabel}` : "Nothing to redo"}
          onClick={() => historyAction("redo")}
        />
      </div>

      <div className="tb-sep" />

      {/* Remote / branch actions */}
      <div className="tb-group">
        <ToolBtn
          icon="⭳"
          label="Pull"
          disabled={!repo}
          badge={behind || undefined}
          onClick={defaultPull}
          onCaret={(e) =>
            openMenu(e, [
              { label: "Pull (merge)", onClick: () => net("pull") },
              { label: "Pull (rebase)", onClick: () => net("pull", ["--rebase"]) },
              { label: "Pull (fast-forward only)", onClick: () => net("pull", ["--ff-only"]) },
              { separator: true },
              { label: "Set default: merge", onClick: () => localStorage.setItem(`mtgit.pullStrategy.${repo!.path}`, "merge") },
              { label: "Set default: rebase", onClick: () => localStorage.setItem(`mtgit.pullStrategy.${repo!.path}`, "rebase") },
              { label: "Set default: ff-only", onClick: () => localStorage.setItem(`mtgit.pullStrategy.${repo!.path}`, "ffOnly") },
            ])
          }
        />
        <ToolBtn
          icon="⭱"
          label="Push"
          badge={ahead || undefined}
          disabled={!repo || (!!currentBranch?.upstream && ahead === 0)}
          title={currentBranch?.upstream && ahead === 0 ? "Nothing to push" : "Push"}
          onClick={() => net("push")}
          onCaret={(e) =>
            openMenu(e, [
              { label: "Push", onClick: () => net("push") },
              {
                label: "Force push (with lease)",
                danger: true,
                onClick: forcePush,
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
              { label: "Fetch All", onClick: () => net("fetch", ["--all", "--prune"]) },
              { label: "Configure auto-fetch…", onClick: configureAutoFetch },
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
  badge,
}: {
  icon: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
  onCaret?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  badge?: number;
}) {
  return (
    <div className={`tb-action${disabled ? " disabled" : ""}`}>
      <button className="tb-action-main" disabled={disabled} onClick={onClick} title={title ?? label}>
        <span className="tb-icon">{icon}</span>
        {badge ? <span className="tb-badge">{badge}</span> : null}
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
