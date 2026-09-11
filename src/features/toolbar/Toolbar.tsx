import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  createBranch,
  createTag,
  clearHistory,
  gitAutoFetch,
  gitNetwork,
  historyStatus,
  listRefs,
  listRemotes,
  openRepo,
  redo,
  setUpstream,
  stashSave,
  stashList,
  stashPop,
  undo,
} from "../../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
import { push, type NetOp } from "../network/net";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { choiceDialog, confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { smartCheckout } from "../../lib/checkout";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import "./toolbar.css";

const DEFAULT_AUTO_FETCH_MINUTES = 1;

/** Minutes between background fetches; 0 when auto-fetch is off or unparseable. */
function readAutoFetch(path: string): number {
  const raw = localStorage.getItem(`mtgit.autoFetch.${path}`);
  const minutes = raw === null ? DEFAULT_AUTO_FETCH_MINUTES : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

export function Toolbar() {
  const repo = useSession((s) => s.repo);
  const setRepo = useSession((s) => s.setRepo);
  const recentRepos = useSession((s) => s.recentRepos);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const setPaletteOpen = useSession((s) => s.setPaletteOpen);
  const openStart = useSession((s) => s.openStart);
  const setCloneOpen = useSession((s) => s.setCloneOpen);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [remoteMutation, setRemoteMutation] = useState(false);
  const [autoFetchMinutes, setAutoFetchMinutes] = useState(0);
  const lastAutoFetch = useRef<{ path: string; at: number } | null>(null);

  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo,
    queryFn: () => listRefs(repo!.path),
  });
  const { data: remotes } = useQuery({
    queryKey: ["remotes", repo?.path],
    enabled: !!repo,
    queryFn: () => listRemotes(repo!.path),
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

  // The interval lives in state, not in a value read once inside the timer
  // effect. Keyed on `repo.path` alone, saving a new interval could not restart
  // the timer — the code apologised for it in its own toast (STATUS A4).
  useEffect(() => {
    setAutoFetchMinutes(repo ? readAutoFetch(repo.path) : 0);
  }, [repo?.path]);

  useEffect(() => {
    if (!repo || autoFetchMinutes <= 0) return;
    const path = repo.path;
    let cancelled = false;
    const fetchNow = () => {
      // Attempt time, not success time: this is what keeps StrictMode's second
      // effect invocation (and a mere interval change) from re-fetching, while
      // `lastFetch` stays the *successful* fetch the tooltip reports.
      lastAutoFetch.current = { path, at: Date.now() };
      gitAutoFetch(path)
        .then((result) => {
          if (cancelled) return;
          if (result.success) {
            setFetchError(null);
            setLastFetch(Date.now());
            refresh();
          } else {
            setFetchError(result.output);
          }
        })
        .catch((error) => !cancelled && setFetchError(String(error)));
    };
    // `04-pull.md` §2 — ahead/behind must be right without the user asking, so
    // the first fetch cannot wait out a full interval after opening the repo.
    const previous = lastAutoFetch.current;
    if (!previous || previous.path !== path || Date.now() - previous.at >= autoFetchMinutes * 60_000) {
      fetchNow();
    }
    const timer = window.setInterval(fetchNow, autoFetchMinutes * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [repo?.path, autoFetchMinutes]);

  // Invalidate + re-read the in-progress operation. Never invalidate alone
  // here: `gitNetwork` cannot report conflicts, so a conflicting pull has no
  // other way to raise the banner (STATUS A1).
  const refresh = () => (repo ? refreshRepo(qc, repo.path) : Promise.resolve());

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

  async function net(op: NetOp, extra?: string[]) {
    if (!repo) return;
    try {
      // This path does not go through `net.ts:runNet`, so it needs §5.3's pull
      // refusal of its own. Fetch and push are deliberately not gated.
      if (op === "pull") await requireNoPausedOperation(repo.path, "pull");
      let args = [...(extra ?? [])];
      // An unpublished branch goes through net.ts's publish flow (D5): it asks
      // the backend for the real remote instead of inferring it from the
      // remote-tracking branch names, which a freshly added remote has none of.
      if (op === "push" && !currentBranch?.upstream) {
        if (await push(repo, args)) {
          await clearHistory(repo.path);
          setRemoteMutation(true);
        }
        refresh();
        return;
      }
      if (op === "pull") args = [...args, "--autostash"];
      const res = await gitNetwork(repo.path, op, undefined, args);
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

  /**
   * Push the current branch to a named remote (B4 / G4).
   *
   * Explicit `<remote> <branch>` rather than a bare `git push`: the point of
   * the entry is to reach a remote that is *not* the upstream, and a bare push
   * would ignore the choice. Upstream tracking is left alone — picking a
   * second remote once should not silently retarget every later push.
   */
  async function pushTo(remote: string) {
    if (!repo || !currentBranch) return;
    try {
      const result = await gitNetwork(repo.path, "push", remote, [currentBranch.name]);
      if (result.success) {
        pushToast("success", `Pushed ${currentBranch.name} to ${remote}`);
        await clearHistory(repo.path);
        setRemoteMutation(true);
      } else {
        pushToast("error", `push failed: ${result.output.split("\n").pop() ?? ""}`);
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
    const items: MenuItem[] = [
      { label: "Start screen", onClick: openStart },
      { label: "Clone repository…", onClick: () => setCloneOpen(true) },
      { label: "Open repository…", onClick: pick },
    ];
    if (recentRepos.length) {
      items.push({ separator: true });
      for (const entry of recentRepos) {
        items.push({ label: entry.name, onClick: () => load(entry.path) });
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
      const minutes = readAutoFetch(repo.path);
      setAutoFetchMinutes(minutes);
      pushToast(
        "info",
        minutes > 0 ? `Auto-fetching every ${minutes} minute${minutes === 1 ? "" : "s"}.` : "Auto-fetch turned off.",
      );
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
            onClick={repoMenu}
            title={repo?.path ?? "Open a repository"}
          >
            <span className="tb-select-text">{busy ? "Opening…" : repo?.name ?? "Open…"}</span>
            <span className="tb-caret">▾</span>
          </button>
        </div>
        {/* A user who forgets which worktree they are in commits to the wrong
            branch, so the one they are in is named rather than implied (G18). */}
        {repo?.worktree && (
          <span className="tb-worktree" title={`Linked worktree "${repo.worktree}" at ${repo.path}`}>
            🌿 {repo.worktree}
          </span>
        )}
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
              ...((remotes ?? []).length > 1 && currentBranch
                ? [
                    { separator: true } as MenuItem,
                    ...(remotes ?? []).map((r) => ({
                      label: `Push ${currentBranch.name} to ${r.name}`,
                      onClick: () => pushTo(r.name),
                    })),
                    { separator: true } as MenuItem,
                  ]
                : []),
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
