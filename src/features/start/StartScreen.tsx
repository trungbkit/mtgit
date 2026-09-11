import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { initRepo, openRepo } from "../../ipc/commands";
import type { RepoInfo } from "../../ipc/types";
import { joinPath } from "../../lib/cloneurl";
import { timeAgo } from "../../lib/time";
import { promptDialog } from "../../stores/dialog";
import { Icon } from "../../components/Icon";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import "./start.css";

/**
 * The app's front door (G3).
 *
 * Before this, MTGit booted into three empty panes and hid its recent repos in
 * a toolbar dropdown — the one screen a new user sees said nothing about what
 * to do. Clone / Open / Init are the three answers, and the recent list is the
 * fourth.
 */
export function StartScreen() {
  const setRepo = useSession((s) => s.setRepo);
  const recentRepos = useSession((s) => s.recentRepos);
  const forgetRecent = useSession((s) => s.forgetRecent);
  const tabs = useSession((s) => s.tabs);
  const closeStart = useSession((s) => s.closeStart);
  const pushToast = useToasts((s) => s.push);

  const setCloneOpen = useSession((s) => s.setCloneOpen);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  function adopt(repo: RepoInfo) {
    setRepo(repo);
  }

  async function openExisting() {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: "Open repository" });
      if (typeof selected !== "string") return;
      await load(selected);
    } catch (e) {
      toastError(e);
    }
  }

  async function load(path: string) {
    setBusy(path);
    try {
      adopt(await openRepo(path));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  async function initNew() {
    try {
      const parent = await openDialog({ directory: true, multiple: false, title: "Where to create the repository" });
      if (typeof parent !== "string") return;
      const name = await promptDialog({
        title: "New repository",
        message: `A folder will be created inside ${parent}.`,
        label: "Repository name",
        placeholder: "my-project",
        confirmLabel: "Create",
        validate: (value) => {
          const trimmed = value.trim();
          if (!trimmed) return "Name cannot be empty.";
          if (/[/\\]/.test(trimmed)) return "Name cannot contain a path separator.";
          if (trimmed === "." || trimmed === "..") return "Choose a real folder name.";
          return null;
        },
      });
      if (!name) return;
      const path = joinPath(parent, name.trim());
      setBusy(path);
      const repo = await initRepo(path, false);
      pushToast("success", `Created ${repo.name}`);
      adopt(repo);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  const needle = filter.trim().toLowerCase();
  const recent = recentRepos.filter(
    (r) => !needle || r.name.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle),
  );

  return (
    <div className="start-screen">
      <div className="start-inner">
        <header className="start-head">
          <h1>MTGit</h1>
          <p>Open a repository to get started.</p>
        </header>

        <div className="start-cards">
          <StartCard
            icon="⤓"
            title="Clone a repository"
            detail="Copy a remote repository to this machine."
            onClick={() => setCloneOpen(true)}
          />
          <StartCard
            icon="📂"
            title="Open a repository"
            detail="Point MTGit at a folder that already has a .git."
            onClick={openExisting}
          />
          <StartCard
            icon="✦"
            title="Start a new repository"
            detail="Create a folder and run git init in it."
            onClick={initNew}
          />
        </div>

        <section className="start-recent">
          <div className="start-recent-head">
            <h2>Recent repositories</h2>
            {recentRepos.length > 4 && (
              <input
                className="start-filter"
                placeholder="Filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
          </div>

          {recentRepos.length === 0 ? (
            <div className="start-empty">Nothing here yet — clone or open a repository and it will be listed.</div>
          ) : recent.length === 0 ? (
            <div className="start-empty">No recent repository matches “{filter}”.</div>
          ) : (
            <ul className="recent-list">
              {recent.map((entry) => (
                <li key={entry.path}>
                  <button
                    className="recent-row"
                    disabled={busy === entry.path}
                    onClick={() => load(entry.path)}
                    title={entry.path}
                  >
                    <span className="recent-name">{entry.name}</span>
                    <span className="recent-path">{entry.path}</span>
                    {entry.branch && (
                      <span className="recent-branch">
                        <Icon name="branch" size={11} /> {entry.branch}
                      </span>
                    )}
                    <span className="recent-when">
                      {busy === entry.path
                        ? "Opening…"
                        : entry.lastOpened
                          ? timeAgo(Math.floor(entry.lastOpened / 1000))
                          : ""}
                    </span>
                  </button>
                  <button
                    className="recent-forget"
                    title="Remove from this list"
                    onClick={() => forgetRecent(entry.path)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {tabs.length > 0 && (
          <button className="link-btn start-back" onClick={closeStart}>
            ‹ Back to {tabs[tabs.length - 1].name}
          </button>
        )}
      </div>

    </div>
  );
}

function StartCard({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: string;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button className="start-card" onClick={onClick}>
      <span className="start-card-icon">{icon}</span>
      <span className="start-card-title">{title}</span>
      <span className="start-card-detail">{detail}</span>
    </button>
  );
}
