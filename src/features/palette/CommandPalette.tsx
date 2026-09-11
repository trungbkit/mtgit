import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createBranch,
  createTag,
  deleteBranch,
  listRefs,
  listRemotes,
  mergeAdvanced,
  openRepo,
  rebaseStandard,
} from "../../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
import { smartCheckout } from "../../lib/checkout";
import { push, runNet } from "../network/net";
import { openSettings } from "../../stores/settings";
import { useSession } from "../../stores/session";
import { seedSearch } from "../../stores/search";
import { toastError, useToasts } from "../../stores/toasts";
import { confirmDialog, promptDialog } from "../../stores/dialog";
import { validateRefName } from "../../lib/refname";
import { chordFor, formatChord, type ActionId } from "../../lib/keys";
import "./palette.css";

/**
 * The guided command palette (G27).
 *
 * The flat palette could only offer commands that needed no arguments, so
 * everything interesting — merge *which* branch, push to *which* remote —
 * either lived elsewhere or was pre-expanded into one entry per branch. That
 * second trick is why "Checkout main" and "Checkout origin/main" and forty
 * other rows used to crowd out every real command.
 *
 * A guided command instead declares **steps**. The palette walks them one at
 * a time, filtering as you type, with a breadcrumb of what you have chosen and
 * a way back: Escape, or Backspace on an empty field, undoes the last choice
 * rather than closing the palette. Closing is what Escape does at the first
 * step, where there is nothing to undo.
 */

interface Choice {
  id: string;
  label: string;
  /** Right-aligned detail: an upstream, a sha, an ahead/behind count. */
  hint?: string;
  /** What `run` receives. Defaults to `id`. */
  value?: string;
}

interface Step {
  /** Breadcrumb crumb once chosen, e.g. "Merge into main". */
  title: string;
  placeholder: string;
  choices: () => Choice[];
  /** Shown instead of "No matching commands" when this step has nothing. */
  empty?: string;
}

interface Command {
  id: string;
  label: string;
  group: string;
  keys?: ActionId;
  steps?: Step[];
  run: (values: string[]) => void | Promise<void>;
}

export function CommandPalette() {
  const open = useSession((s) => s.paletteOpen);
  const setOpen = useSession((s) => s.setPaletteOpen);
  const repo = useSession((s) => s.repo);
  const setRepo = useSession((s) => s.setRepo);
  const openStart = useSession((s) => s.openStart);
  const setCloneOpen = useSession((s) => s.setCloneOpen);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  /** The command being guided, and the values chosen so far. */
  const [active, setActive] = useState<{ command: Command; values: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo && open,
    queryFn: () => listRefs(repo!.path),
  });
  const { data: remotes } = useQuery({
    queryKey: ["remotes", repo?.path],
    enabled: !!repo && open,
    queryFn: () => listRemotes(repo!.path),
  });

  const refresh = () => (repo ? refreshRepo(qc, repo.path) : Promise.resolve());
  const wrap = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setOpen(false);
    try {
      await fn();
      if (ok) pushToast("success", ok);
      refresh();
    } catch (e) {
      toastError(e);
    }
  };

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      { id: "start", label: "Start screen", group: "Application", run: () => { setOpen(false); openStart(); } },
      { id: "clone", label: "Clone repository…", group: "Application", run: () => { setOpen(false); setCloneOpen(true); } },
      {
        id: "open",
        label: "Open repository…",
        group: "Application",
        run: wrap(async () => {
          const sel = await openDialog({ directory: true, multiple: false });
          if (typeof sel === "string") setRepo(await openRepo(sel));
        }),
      },
      { id: "settings", label: "Settings…", group: "Application", keys: "settings.open", run: () => { setOpen(false); openSettings(); } },
    ];
    if (!repo) return list;

    const head = repo.head.branch;
    // Checkout offers remote branches too, which the flat palette never did
    // (STATUS B7): `smartCheckout` already creates the tracking branch, so
    // there was never a reason to hide them.
    const checkoutChoices = (): Choice[] => [
      ...(refs?.local ?? [])
        .filter((b) => !b.isHead)
        .map((b) => ({ id: b.name, label: b.name, hint: b.upstream ?? undefined })),
      ...(refs?.remote ?? []).map((b) => ({ id: b.name, label: b.name, hint: "remote" })),
      ...(refs?.tags ?? []).map((t) => ({ id: t.name, label: t.name, hint: "tag" })),
    ];
    const branchChoices = (): Choice[] =>
      [...(refs?.local ?? []), ...(refs?.remote ?? [])]
        .filter((b) => b.name !== head)
        .map((b) => ({ id: b.name, label: b.name, hint: b.isHead ? "current" : undefined }));

    list.push(
      // These report their own outcome (a failed push is not "Pushed"), so
      // they are wrapped without a success message.
      { id: "fetch", label: "Fetch", group: "Remote", run: wrap(() => runNet(repo, "fetch", undefined, "Fetched")) },
      { id: "pull", label: "Pull", group: "Remote", keys: "pull", run: wrap(() => runNet(repo, "pull", undefined, "Pulled")) },
      { id: "push", label: "Push", group: "Remote", keys: "push", run: wrap(() => push(repo)) },
      {
        id: "push-to",
        label: "Push to a specific remote…",
        group: "Remote",
        steps: [
          {
            title: "Push to",
            placeholder: "Choose a remote",
            choices: () => (remotes ?? []).map((r) => ({ id: r.name, label: r.name, hint: r.url ?? undefined })),
            empty: "This repository has no remotes.",
          },
        ],
        run: ([remote]) =>
          wrap(async () => {
            if (!head) throw new Error("Detached HEAD has no branch to push.");
            await runNet(repo, "push", [remote, head], `Pushed to ${remote}`);
          })(),
      },
      {
        id: "checkout",
        label: "Checkout…",
        group: "Repository",
        steps: [
          {
            title: "Checkout",
            placeholder: "Branch, remote branch or tag",
            choices: checkoutChoices,
            empty: "Nothing to check out.",
          },
        ],
        run: ([name]) => wrap(() => smartCheckout(repo.path, name), `Checked out ${name}`)(),
      },
      {
        id: "merge",
        label: "Merge a branch…",
        group: "Repository",
        steps: [
          {
            title: `Merge into ${head ?? "HEAD"}`,
            placeholder: "Branch to merge in",
            choices: branchChoices,
            empty: "No other branch to merge.",
          },
        ],
        run: ([name]) =>
          wrap(async () => {
            await requireNoPausedOperation(repo.path, `merge ${name}`);
            const result = await mergeAdvanced(repo.path, name, "default");
            if (result.conflicts.length) {
              pushToast("error", `Merge paused — ${result.conflicts.length} conflicted file(s).`);
            } else {
              pushToast("success", `Merged ${name}.`);
            }
          })(),
      },
      {
        id: "rebase",
        label: "Rebase onto…",
        group: "Repository",
        steps: [
          {
            title: `Rebase ${head ?? "HEAD"} onto`,
            placeholder: "Branch to rebase onto",
            choices: branchChoices,
            empty: "No other branch to rebase onto.",
          },
        ],
        run: ([name]) =>
          wrap(async () => {
            await requireNoPausedOperation(repo.path, `rebase onto ${name}`);
            await rebaseStandard(repo.path, name);
          }, `Rebased onto ${name}`)(),
      },
      {
        id: "delete-branch",
        label: "Delete a local branch…",
        group: "Repository",
        steps: [
          {
            title: "Delete branch",
            placeholder: "Local branch to delete",
            choices: () =>
              (refs?.local ?? [])
                .filter((b) => !b.isHead)
                .map((b) => ({ id: b.name, label: b.name, hint: b.upstream ?? undefined })),
            empty: "There is no other local branch.",
          },
        ],
        run: ([name]) =>
          wrap(async () => {
            if (
              await confirmDialog({
                title: "Delete branch",
                message: `Delete the local branch "${name}"?`,
                confirmLabel: "Delete",
                danger: true,
              })
            ) {
              await deleteBranch(repo.path, name, false);
            }
          }, `Deleted ${name}`)(),
      },
      {
        id: "newbranch",
        label: "Create branch…",
        group: "Repository",
        run: wrap(async () => {
          const name = await promptDialog({
            title: "Create branch",
            label: "Branch name",
            placeholder: "feature/x",
            confirmLabel: "Create",
            validate: validateRefName,
          });
          if (name) await createBranch(repo.path, name, undefined, true);
        }, "Branch created"),
      },
      {
        id: "newtag",
        label: "Create tag at HEAD…",
        group: "Repository",
        run: wrap(async () => {
          if (!repo.head.oid) throw new Error("There is no commit to tag.");
          const name = await promptDialog({
            title: "Create tag",
            label: "Tag name",
            placeholder: "v1.0.0",
            confirmLabel: "Create",
            validate: validateRefName,
          });
          if (name) await createTag(repo.path, name, repo.head.oid, undefined);
        }, "Tag created"),
      },
      { id: "term", label: "Toggle terminal", group: "Application", keys: "terminal.toggle", run: () => { setOpen(false); toggleTerminal(); } },
      {
        id: "search",
        label: "Search commits…",
        group: "Graph",
        keys: "search.focus",
        run: () => {
          setOpen(false);
          // Seeds and focuses the graph header's field rather than opening a
          // search of its own — one search surface (overview §7).
          seedSearch(repo.path, "", true);
        },
      },
    );
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, refs, remotes]);

  // Either a list of commands, or the current step's choices.
  const step = active ? active.command.steps?.[active.values.length] : undefined;
  const rows: Choice[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Choice[] = step
      ? step.choices()
      : commands.map((c) => ({
          id: c.id,
          label: c.label,
          hint: c.keys ? formatChord(chordFor(c.keys)) : undefined,
        }));
    return q ? all.filter((row) => row.label.toLowerCase().includes(q)) : all;
  }, [commands, step, query]);

  // Group headers only make sense for the command list; a step's choices are
  // one kind of thing by construction.
  const groupOf = useMemo(
    () => new Map(commands.map((c) => [c.id, c.group] as const)),
    [commands],
  );

  useEffect(() => setCursor(0), [query, open, active]);
  useEffect(() => {
    if (!open) {
      setActive(null);
      setQuery("");
    }
  }, [open]);

  function choose(row: Choice) {
    const value = row.value ?? row.id;
    if (!step) {
      const command = commands.find((c) => c.id === row.id);
      if (!command) return;
      if (command.steps?.length) {
        setActive({ command, values: [] });
        setQuery("");
        return;
      }
      void command.run([]);
      return;
    }
    const values = [...active!.values, value];
    if (values.length < (active!.command.steps?.length ?? 0)) {
      setActive({ command: active!.command, values });
      setQuery("");
      return;
    }
    void active!.command.run(values);
  }

  /** Undo the last choice, or close when there is nothing to undo. */
  function back() {
    if (!active) {
      setOpen(false);
      return;
    }
    if (active.values.length === 0) {
      setActive(null);
      setQuery("");
      return;
    }
    setActive({ command: active.command, values: active.values.slice(0, -1) });
    setQuery("");
  }

  if (!open) return null;

  const crumbs = active
    ? [active.command.label.replace(/…$/, ""), ...active.values]
    : [];

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        {crumbs.length > 0 && (
          <div className="palette-crumbs">
            <button onClick={back} title="Back (Escape)">
              ‹
            </button>
            {crumbs.map((crumb, i) => (
              <span key={i} className="palette-crumb">
                {crumb}
              </span>
            ))}
            {step && <span className="palette-crumb pending">{step.title}</span>}
          </div>
        )}
        <input
          autoFocus
          ref={inputRef}
          className="palette-input"
          placeholder={step ? step.placeholder : "Type a command…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              back();
            } else if (e.key === "Backspace" && query === "" && active) {
              // Only with an empty field: Backspace must edit the text first.
              e.preventDefault();
              back();
            } else if (e.key === "ArrowDown") setCursor((c) => Math.min(rows.length - 1, c + 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
            else if (e.key === "Enter" && rows[cursor]) choose(rows[cursor]);
          }}
        />
        <div className="palette-list">
          {rows.map((row, i) => {
            const group = step ? undefined : groupOf.get(row.id);
            const newGroup = group && group !== (step ? undefined : groupOf.get(rows[i - 1]?.id ?? ""));
            return (
              <div key={row.id}>
                {newGroup && <div className="palette-group">{group}</div>}
                <div
                  className={`palette-item${i === cursor ? " active" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(row)}
                >
                  <span className="palette-label">{row.label}</span>
                  {row.hint && <span className="palette-hint">{row.hint}</span>}
                </div>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="palette-empty">
              {step?.empty ?? "No matching commands"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
