import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDetail,
  ConflictResult,
  FileDiff,
  GitOpResult,
  GraphPage,
  MergeMode,
  MergeResult,
  RebaseResult,
  RefList,
  RepoInfo,
  ResetMode,
  StashEntry,
  StatusReport,
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

// M3
export const getStatus = (path: string) => invoke<StatusReport>("get_status", { path });
export const stagePaths = (path: string, paths: string[]) => invoke<void>("stage_paths", { path, paths });
export const unstagePaths = (path: string, paths: string[]) => invoke<void>("unstage_paths", { path, paths });
export const discardPaths = (path: string, paths: string[]) => invoke<void>("discard_paths", { path, paths });
export const commit = (path: string, message: string, amend: boolean) =>
  invoke<string>("commit", { path, message, amend });
export const watchRepo = (path: string) => invoke<void>("watch_repo", { path });

// M4
export const createBranch = (path: string, name: string, target: string | undefined, checkout: boolean) =>
  invoke<void>("create_branch", { path, name, target, checkout });
export const deleteBranch = (path: string, name: string) => invoke<void>("delete_branch", { path, name });
export const renameBranch = (path: string, oldName: string, newName: string) =>
  invoke<void>("rename_branch", { path, old: oldName, new: newName });
export const checkout = (path: string, refname: string) => invoke<void>("checkout", { path, refname });
export const mergeRef = (path: string, theirRef: string, mode: MergeMode = "default") =>
  invoke<MergeResult>("merge_ref", { path, theirRef, mode });
export const cherryPick = (path: string, oid: string) =>
  invoke<ConflictResult>("cherry_pick", { path, oid });
export const resetTo = (path: string, oid: string, mode: ResetMode) =>
  invoke<void>("reset_to", { path, oid, mode });
export const rebaseOnto = (path: string, onto: string) =>
  invoke<RebaseResult>("rebase_onto", { path, onto });
export const stashSave = (path: string, message: string | undefined, includeUntracked: boolean) =>
  invoke<string>("stash_save", { path, message, includeUntracked });
export const stashList = (path: string) => invoke<StashEntry[]>("stash_list", { path });
export const stashApply = (path: string, index: number) => invoke<void>("stash_apply", { path, index });
export const stashPop = (path: string, index: number) => invoke<void>("stash_pop", { path, index });
export const stashDrop = (path: string, index: number) => invoke<void>("stash_drop", { path, index });
export const gitNetwork = (path: string, op: "fetch" | "pull" | "push", remote?: string, extra?: string[]) =>
  invoke<GitOpResult>("git_network", { path, op, remote, extra });

// M5
export const ptySpawn = (cwd: string, rows: number, cols: number) =>
  invoke<string>("pty_spawn", { cwd, rows, cols });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  invoke<void>("pty_resize", { id, rows, cols });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });
