import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { checkout, createBranch, gitNetwork, listRefs, openRepo } from "../../ipc/commands";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import "./palette.css";

interface Action {
  id: string;
  label: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useSession((s) => s.paletteOpen);
  const setOpen = useSession((s) => s.setPaletteOpen);
  const repo = useSession((s) => s.repo);
  const setRepo = useSession((s) => s.setRepo);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo && open,
    queryFn: () => listRefs(repo!.path),
  });

  const refresh = () => repo && qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repo.path });
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

  const actions: Action[] = useMemo(() => {
    const list: Action[] = [
      {
        id: "open",
        label: "Open repository…",
        run: wrap(async () => {
          const sel = await openDialog({ directory: true, multiple: false });
          if (typeof sel === "string") setRepo(await openRepo(sel));
        }),
      },
    ];
    if (repo) {
      list.push(
        { id: "fetch", label: "Fetch", run: wrap(() => gitNetwork(repo.path, "fetch"), "Fetched") },
        { id: "pull", label: "Pull", run: wrap(() => gitNetwork(repo.path, "pull"), "Pulled") },
        { id: "push", label: "Push", run: wrap(() => gitNetwork(repo.path, "push"), "Pushed") },
        { id: "term", label: "Toggle terminal", run: () => { setOpen(false); toggleTerminal(); } },
        {
          id: "newbranch",
          label: "Create branch…",
          run: wrap(async () => {
            const name = prompt("New branch name");
            if (name) await createBranch(repo.path, name, undefined, true);
          }, "Branch created"),
        },
      );
      for (const b of refs?.local ?? []) {
        list.push({
          id: `co-${b.name}`,
          label: `Checkout ${b.name}`,
          run: wrap(() => checkout(repo.path, b.name), `Checked out ${b.name}`),
        });
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, refs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
  }, [actions, query]);

  useEffect(() => setCursor(0), [query, open]);

  if (!open) return null;

  return (
    <div className="palette-overlay" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") setCursor((c) => Math.min(filtered.length - 1, c + 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
            else if (e.key === "Enter") filtered[cursor]?.run();
          }}
        />
        <div className="palette-list">
          {filtered.map((a, i) => (
            <div
              key={a.id}
              className={`palette-item${i === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={a.run}
            >
              {a.label}
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-empty">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}
