import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { openRepo, watchRepo } from "./commands";
import { refreshRepo, syncOperation } from "./repoState";
import { useSession } from "../stores/session";

/**
 * Start the fs watcher for the active repo and invalidate its queries whenever
 * the backend emits `repo-changed`. This is the loop that makes the UI live.
 */
export function useRepoEvents() {
  const qc = useQueryClient();
  const repoPath = useSession((s) => s.repo?.path);

  // Ask the backend to watch each repo we open (idempotent server-side). The
  // `syncOperation` here is what makes a conflict that survived an app restart
  // produce a banner (overview §5.1).
  useEffect(() => {
    if (repoPath) {
      watchRepo(repoPath).catch(() => {
        /* watching is best-effort */
      });
      void syncOperation(repoPath);
    }
  }, [repoPath]);

  // A single global listener fans out invalidations keyed by the changed path.
  useEffect(() => {
    const unlisten = listen<string>("repo-changed", (event) => {
      const changedPath = event.payload;
      void refreshRepo(qc, changedPath);
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
