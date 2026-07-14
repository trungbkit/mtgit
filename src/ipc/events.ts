import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { watchRepo } from "./commands";
import { useSession } from "../stores/session";

/**
 * Start the fs watcher for the active repo and invalidate its queries whenever
 * the backend emits `repo-changed`. This is the loop that makes the UI live.
 */
export function useRepoEvents() {
  const qc = useQueryClient();
  const repoPath = useSession((s) => s.repo?.path);

  // Ask the backend to watch each repo we open (idempotent server-side).
  useEffect(() => {
    if (repoPath) {
      watchRepo(repoPath).catch(() => {
        /* watching is best-effort */
      });
    }
  }, [repoPath]);

  // A single global listener fans out invalidations keyed by the changed path.
  useEffect(() => {
    const unlisten = listen<string>("repo-changed", (event) => {
      const changedPath = event.payload;
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === changedPath });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [qc]);
}
