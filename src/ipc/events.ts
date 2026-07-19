import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { openRepo, operationInfo, watchRepo } from "./commands";
import { useSession } from "../stores/session";
import { useConflict, type ConflictKind } from "../stores/conflict";

/**
 * Start the fs watcher for the active repo and invalidate its queries whenever
 * the backend emits `repo-changed`. This is the loop that makes the UI live.
 */
export function useRepoEvents() {
  const qc = useQueryClient();
  const repoPath = useSession((s) => s.repo?.path);

  const syncOperation = (path: string) => {
    operationInfo(path)
      .then((info) => {
        if (info && info.kind !== "operation") {
          useConflict.getState().set({
            repoPath: path,
            kind: info.kind as ConflictKind,
            files: info.conflicts,
            currentSha: info.currentSha,
            current: info.current,
            total: info.total,
            canSkip: info.canSkip,
          });
        } else if (useConflict.getState().active?.repoPath === path) {
          useConflict.getState().clear();
        }
      })
      .catch(() => {
        /* operation discovery is best-effort */
      });
  };

  // Ask the backend to watch each repo we open (idempotent server-side).
  useEffect(() => {
    if (repoPath) {
      watchRepo(repoPath).catch(() => {
        /* watching is best-effort */
      });
      syncOperation(repoPath);
    }
  }, [repoPath]);

  // A single global listener fans out invalidations keyed by the changed path.
  useEffect(() => {
    const unlisten = listen<string>("repo-changed", (event) => {
      const changedPath = event.payload;
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === changedPath });
      syncOperation(changedPath);
      if (useSession.getState().repo?.path === changedPath) {
        openRepo(changedPath)
          .then((repo) => useSession.getState().setRepo(repo))
          .catch(() => {
            /* repository may be transiently locked during an operation */
          });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [qc]);
}
