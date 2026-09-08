import { useQueryClient } from "@tanstack/react-query";
import { checkoutAdvanced, createBranch } from "../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../ipc/repoState";
import { useSession } from "../stores/session";
import { promptDialog } from "../stores/dialog";
import { validateRefName } from "../lib/refname";
import { toastError, useToasts } from "../stores/toasts";
import "./detached-head.css";

export function DetachedHeadBanner() {
  const repo = useSession((state) => state.repo);
  const pushToast = useToasts((state) => state.push);
  const qc = useQueryClient();
  if (!repo?.head.detached) return null;
  const path = repo.path;

  // Both buttons move HEAD, so both need `refreshRepo` rather than the watcher:
  // they run guarded commands, whose 600 ms quiet window swallows the fs event
  // that would otherwise have refreshed the graph (STATUS A2). Without it the
  // banner stays up after it has been resolved, describing a HEAD that moved.
  const create = async () => {
    const name = await promptDialog({
      title: "Keep detached commits",
      label: "New branch name",
      placeholder: "feature/my-work",
      confirmLabel: "Create branch",
      validate: validateRefName,
    });
    if (!name) return;
    try {
      await requireNoPausedOperation(path, `create ${name} here`);
      await createBranch(path, name, repo.head.oid ?? undefined, true);
      pushToast("success", `Created and checked out ${name}.`);
      await refreshRepo(qc, path);
    } catch (error) {
      toastError(error);
    }
  };

  const goBack = async () => {
    try {
      // `@{-1}` is a checkout like any other, so §5.3 applies; `smartCheckout`
      // is deliberately not used, since its collision recovery would offer to
      // stash or discard changes the user came here to keep.
      await requireNoPausedOperation(path, "return to the previous branch");
      await checkoutAdvanced(path, "@{-1}");
      pushToast("success", "Returned to the previous branch.");
      await refreshRepo(qc, path);
    } catch (error) {
      toastError(error);
    }
  };

  return (
    <div className="detached-banner">
      <span>⚠ You are in a detached HEAD state at {repo.head.oid?.slice(0, 7)}.</span>
      <button onClick={create}>Create branch here</button>
      <button onClick={goBack}>Return to previous branch</button>
    </div>
  );
}
