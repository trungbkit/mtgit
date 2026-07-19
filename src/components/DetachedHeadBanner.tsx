import { checkoutAdvanced, createBranch } from "../ipc/commands";
import { useSession } from "../stores/session";
import { promptDialog } from "../stores/dialog";
import { validateRefName } from "../lib/refname";
import { toastError, useToasts } from "../stores/toasts";
import "./detached-head.css";

export function DetachedHeadBanner() {
  const repo = useSession((state) => state.repo);
  const pushToast = useToasts((state) => state.push);
  if (!repo?.head.detached) return null;

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
      await createBranch(repo.path, name, repo.head.oid ?? undefined, true);
      pushToast("success", `Created and checked out ${name}.`);
    } catch (error) {
      toastError(error);
    }
  };

  const goBack = async () => {
    try {
      await checkoutAdvanced(repo.path, "@{-1}");
      pushToast("success", "Returned to the previous branch.");
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
