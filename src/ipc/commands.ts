import { invoke } from "@tauri-apps/api/core";
import type {
  BlameLine,
  CommitDetail,
  CommandResult,
  CheckoutRecovery,
  CheckoutResult,
  ConflictFile,
  ConflictResult,
  FileContent,
  FileDiff,
  GitOpResult,
  GraphPage,
  HistoryEntry,
  HistoryStatus,
  MergeMode,
  MergeResult,
  RebaseResult,
  RebasePlanItem,
  RebaseCommit,
  RewriteInfo,
  OperationInfo,
  RefList,
  RepoInfo,
  ResetMode,
  StashEntry,
  StatusReport,
  SubmoduleInfo,
  WorktreeInfo,
} from "./types";

/** Thin, typed wrappers over the Tauri command handlers. */

// M0/M1
export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const gitAvailable = () => invoke<boolean>("git_available");
export const listRefs = (path: string) => invoke<RefList>("list_refs", { path });
export const getGraph = (path: string, skip: number, limit: number) =>
  invoke<GraphPage>("get_graph", { path, skip, limit });

// M2
export const getCommit = (path: string, oid: string) => invoke<CommitDetail>("get_commit", { path, oid });
export const getCommitDiff = (path: string, oid: string, pathFilter?: string) =>
  invoke<FileDiff[]>("get_commit_diff", { path, oid, pathFilter });
export const getWorktreeDiff = (path: string, staged: boolean, pathFilter?: string) =>
  invoke<FileDiff[]>("get_worktree_diff", { path, staged, pathFilter });
export const compareCommits = (path: string, old: string, newOid: string) =>
  invoke<FileDiff[]>("compare_commits", { path, old, new: newOid });

// M3
export const getStatus = (path: string) => invoke<StatusReport>("get_status", { path });
export const stagePaths = (path: string, paths: string[]) => invoke<void>("stage_paths", { path, paths });
export const unstagePaths = (path: string, paths: string[]) => invoke<void>("unstage_paths", { path, paths });
export const discardPaths = (path: string, paths: string[]) => invoke<void>("discard_paths", { path, paths });
export const ignorePath = (path: string, file: string) => invoke<void>("ignore_path", { path, file });
export const commit = (path: string, message: string, amend: boolean) =>
  invoke<string>("commit", { path, message, amend });
export const commitAdvanced = (
  path: string,
  summary: string,
  description: string,
  amend: boolean,
  noVerify = false,
) => invoke<CommandResult>("commit_advanced", { path, summary, description, amend, noVerify });
export const getHeadMessage = (path: string) => invoke<string>("get_head_message", { path });
export const setUpstream = (path: string, local: string, upstream: string) =>
  invoke<void>("set_upstream", { path, local, upstream });
export const applyPatch = (path: string, patch: string, cached: boolean, reverse = false) =>
  invoke<void>("apply_patch", { path, patch, cached, reverse });
export const watchRepo = (path: string) => invoke<void>("watch_repo", { path });

// M4
export const createBranch = (path: string, name: string, target: string | undefined, checkout: boolean) =>
  invoke<void>("create_branch", { path, name, target, checkout });
export const deleteBranch = (path: string, name: string, force = false) =>
  invoke<void>("delete_branch", { path, name, force });
export const renameBranch = (path: string, oldName: string, newName: string) =>
  invoke<void>("rename_branch", { path, old: oldName, new: newName });
export const checkout = (path: string, refname: string) => invoke<void>("checkout", { path, refname });
export const checkoutAdvanced = (
  path: string,
  refname: string,
  recovery: CheckoutRecovery = "normal",
  localName?: string,
) => invoke<CheckoutResult>("checkout_advanced", { path, refname, recovery, localName });
export const mergeRef = (path: string, theirRef: string, mode: MergeMode = "default") =>
  invoke<MergeResult>("merge_ref", { path, theirRef, mode });
export const mergeAdvanced = (path: string, theirRef: string, mode: MergeMode = "default") =>
  invoke<MergeResult>("merge_advanced", { path, theirRef, mode });
export const cherryPick = (path: string, oid: string) =>
  invoke<ConflictResult>("cherry_pick", { path, oid });
export const cherryPickMany = (
  path: string,
  oids: string[],
  commitImmediately: boolean,
  mainline?: number,
  appendOrigin = false,
) =>
  invoke<CommandResult>("cherry_pick_many", {
    path,
    oids,
    commitImmediately,
    mainline,
    appendOrigin,
  });
export const resetTo = (path: string, oid: string, mode: ResetMode) =>
  invoke<void>("reset_to", { path, oid, mode });
export const rebaseOnto = (path: string, onto: string) =>
  invoke<RebaseResult>("rebase_onto", { path, onto });
export const rebaseContinue = (path: string) => invoke<RebaseResult>("rebase_continue", { path });
export const rebaseAbort = (path: string) => invoke<void>("rebase_abort", { path });
export const rewriteInfo = (path: string, base: string) =>
  invoke<RewriteInfo>("rewrite_info", { path, base });
export const rebaseCommits = (path: string, base: string) =>
  invoke<RebaseCommit[]>("rebase_commits", { path, base });
export const rebaseStandard = (path: string, onto: string) =>
  invoke<CommandResult>("rebase_standard", { path, onto });
export const interactiveRebase = (path: string, base: string, plan: RebasePlanItem[]) =>
  invoke<CommandResult>("interactive_rebase", { path, base, plan });
export const operationInfo = (path: string) =>
  invoke<OperationInfo | null>("operation_info", { path });
export const operationContinue = (path: string) =>
  invoke<CommandResult>("operation_continue", { path });
export const operationSkip = (path: string) =>
  invoke<CommandResult>("operation_skip", { path });
export const operationAbort = (path: string) => invoke<void>("operation_abort", { path });
export const getConflictFile = (path: string, file: string) =>
  invoke<ConflictFile>("get_conflict_file", { path, file });
export const resolveConflictContent = (path: string, file: string, content: string) =>
  invoke<void>("resolve_conflict_content", { path, file, content });
export const resolveConflictSide = (path: string, file: string, side: "ours" | "theirs") =>
  invoke<void>("resolve_conflict_side", { path, file, side });
/** Abort a pending merge / cherry-pick / revert, restoring HEAD. */
export const abortOperation = (path: string) => invoke<void>("abort_operation", { path });
export const revertCommit = (path: string, oid: string) =>
  invoke<ConflictResult>("revert_commit", { path, oid });
export const createPatch = (path: string, oid: string, outPath: string) =>
  invoke<void>("create_patch", { path, oid, outPath });
export const createTag = (path: string, name: string, target: string, message?: string) =>
  invoke<void>("create_tag", { path, name, target, message });
export const deleteTag = (path: string, name: string) => invoke<void>("delete_tag", { path, name });
export const getRemoteUrl = (path: string, remote: string) =>
  invoke<string | null>("get_remote_url", { path, remote });
export const listWorktrees = (path: string) => invoke<WorktreeInfo[]>("list_worktrees", { path });
export const listSubmodules = (path: string) => invoke<SubmoduleInfo[]>("list_submodules", { path });
export const updateSubmodules = (path: string) => invoke<void>("update_submodules", { path });
export const createWorktree = (path: string, name: string, worktreePath: string, target?: string) =>
  invoke<void>("create_worktree", { path, name, worktreePath, target });
export const blameFile = (path: string, file: string, oid?: string) =>
  invoke<BlameLine[]>("blame_file", { path, file, oid });
export const fileHistory = (path: string, file: string, limit: number) =>
  invoke<HistoryEntry[]>("file_history", { path, file, limit });
export const fileAtCommit = (path: string, oid: string, file: string) =>
  invoke<FileContent>("file_at_commit", { path, oid, file });
export const stashSave = (path: string, message: string | undefined, includeUntracked: boolean) =>
  invoke<string>("stash_save", { path, message, includeUntracked });
export const stashList = (path: string) => invoke<StashEntry[]>("stash_list", { path });
export const stashApply = (path: string, index: number) => invoke<void>("stash_apply", { path, index });
export const stashPop = (path: string, index: number) => invoke<void>("stash_pop", { path, index });
export const stashDrop = (path: string, index: number) => invoke<void>("stash_drop", { path, index });
export const gitNetwork = (path: string, op: "fetch" | "pull" | "push", remote?: string, extra?: string[]) =>
  invoke<GitOpResult>("git_network", { path, op, remote, extra });
export const gitAutoFetch = (path: string) => invoke<GitOpResult>("git_auto_fetch", { path });
export const cancelGitNetwork = (path: string) => invoke<void>("cancel_git_network", { path });
export const historyStatus = (path: string) => invoke<HistoryStatus>("history_status", { path });
export const clearHistory = (path: string) => invoke<void>("clear_history", { path });
export const undo = (path: string) => invoke<HistoryStatus>("undo", { path });
export const redo = (path: string) => invoke<HistoryStatus>("redo", { path });

/** Delete a branch on a remote: `git push <remote> --delete <branch>`. */
export const deleteRemoteBranch = (path: string, remote: string, branch: string) =>
  gitNetwork(path, "push", remote, ["--delete", branch]);

// M5
export const ptySpawn = (cwd: string, rows: number, cols: number) =>
  invoke<string>("pty_spawn", { cwd, rows, cols });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  invoke<void>("pty_resize", { id, rows, cols });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });
