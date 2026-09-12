import { invoke } from "@tauri-apps/api/core";
import { settings } from "../stores/settings";
import type {
  AutolinkPattern,
  BlameLine,
  CommitDetail,
  CommitStats,
  CommandResult,
  Contributor,
  CheckoutRecovery,
  CheckoutResult,
  ConflictFile,
  ConflictResult,
  ConflictSet,
  CopyResult,
  FileContent,
  FileDiff,
  GhostRef,
  GitOpResult,
  GraphPage,
  HistoryEntry,
  IdentityInfo,
  IdentityScope,
  HistoryStatus,
  PathCompletion,
  PushTarget,
  MergeMode,
  MergeResult,
  MergeRelation,
  MergeTarget,
  RebaseResult,
  RebasePlanItem,
  RebaseCommit,
  RewriteInfo,
  OperationInfo,
  PredictedConflict,
  RefList,
  RemoteInfo,
  RepoInfo,
  ResetMode,
  SearchOptions,
  SearchResults,
  Settings,
  StashEntry,
  StatusReport,
  SubmoduleInfo,
  TerminalToken,
  WipRow,
  WorktreeInfo,
} from "./types";

/** Thin, typed wrappers over the Tauri command handlers. */

// M0/M1
export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const gitAvailable = () => invoke<boolean>("git_available");
/** Create a repository and open it (G2). */
export const initRepo = (path: string, bare: boolean) => invoke<RepoInfo>("init_repo", { path, bare });
/**
 * Clone and open (G1). Unlike `gitNetwork`, this *rejects* on failure — a
 * half-finished clone is not a repo the user can be dropped into, so the only
 * useful outcomes are a `RepoInfo` or git's own error message.
 */
export const cloneRepo = (
  url: string,
  dest: string,
  opts: { recurseSubmodules?: boolean; depth?: number; branch?: string } = {},
) =>
  invoke<RepoInfo>("clone_repo", {
    url,
    dest,
    recurseSubmodules: opts.recurseSubmodules ?? false,
    depth: opts.depth,
    branch: opts.branch,
  });
export const listRefs = (path: string) => invoke<RefList>("list_refs", { path });
export const getGraph = (path: string, skip: number, limit: number) =>
  invoke<GraphPage>("get_graph", { path, skip, limit });
/**
 * The digest of the ref set the graph would lay out (`CLAUDE.md` invariant 4).
 *
 * Unchanged digest means `getGraph` would return byte-identical rows, so a
 * refetch can be skipped — see `ipc/repoState.ts`.
 */
export const graphKey = (path: string) => invoke<string>("graph_key", { path });
/** Search history. The grammar is parsed in Rust; `limit` of 0 is unbounded. */
export const searchCommits = (path: string, query: string, opts: SearchOptions, limit: number) =>
  invoke<SearchResults>("search_commits", { path, query, opts, limit });
export const cancelSearch = (path: string) => invoke<void>("cancel_search", { path });

// M2
export const getCommit = (path: string, oid: string) => invoke<CommitDetail>("get_commit", { path, oid });
// `ignoreWhitespace` defaults to the user's setting rather than to `false`,
// so every diff in the app obeys it without each call site remembering to
// pass it. An explicit argument still wins, for a caller that must not.
export const getCommitDiff = (path: string, oid: string, pathFilter?: string, ignoreWhitespace?: boolean) =>
  invoke<FileDiff[]>("get_commit_diff", {
    path,
    oid,
    pathFilter,
    ignoreWhitespace: ignoreWhitespace ?? settings().diffIgnoreWhitespace,
  });
export const getWorktreeDiff = (
  path: string,
  staged: boolean,
  pathFilter?: string,
  ignoreWhitespace?: boolean,
) =>
  invoke<FileDiff[]>("get_worktree_diff", {
    path,
    staged,
    pathFilter,
    ignoreWhitespace: ignoreWhitespace ?? settings().diffIgnoreWhitespace,
  });
export const compareCommits = (path: string, old: string, newOid: string, ignoreWhitespace?: boolean) =>
  invoke<FileDiff[]>("compare_commits", {
    path,
    old,
    new: newOid,
    ignoreWhitespace: ignoreWhitespace ?? settings().diffIgnoreWhitespace,
  });

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
export const unsetUpstream = (path: string, local: string) =>
  invoke<void>("unset_upstream", { path, local });
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
  /** Stash the working tree around the pick (`07-cherry-pick.md` B4). */
  stashFallback = false,
) =>
  invoke<CommandResult>("cherry_pick_many", {
    path,
    oids,
    commitImmediately,
    mainline,
    appendOrigin,
    stashFallback,
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
export const listRemotes = (path: string) => invoke<RemoteInfo[]>("list_remotes", { path });
export const addRemote = (path: string, name: string, url: string) =>
  invoke<void>("add_remote", { path, name, url });
export const removeRemote = (path: string, name: string) =>
  invoke<void>("remove_remote", { path, name });
/** Returns the refspecs git could not rewrite — empty for a default remote. */
export const renameRemote = (path: string, oldName: string, newName: string) =>
  invoke<string[]>("rename_remote", { path, old: oldName, new: newName });
export const setRemoteUrl = (path: string, name: string, url: string) =>
  invoke<void>("set_remote_url", { path, name, url });
/** Branch / remote / upstream facts the push flow needs. */
export const pushTarget = (path: string) => invoke<PushTarget>("push_target", { path });
export const listWorktrees = (path: string) => invoke<WorktreeInfo[]>("list_worktrees", { path });
export const listSubmodules = (path: string) => invoke<SubmoduleInfo[]>("list_submodules", { path });
export const updateSubmodules = (path: string) => invoke<void>("update_submodules", { path });
export const worktreeHolding = (path: string, branch: string) =>
  invoke<WorktreeInfo | null>("worktree_holding", { path, branch });
/** Copy uncommitted changes into another worktree (`01-commit.md` §3.2). */
export const copyChangesToWorktree = (path: string, worktreeName: string, stagedOnly: boolean) =>
  invoke<CopyResult>("copy_changes_to_worktree", { path, worktreeName, stagedOnly });
export const createWorktree = (
  path: string,
  name: string,
  worktreePath: string,
  target?: string,
  /** Leave the worktree on a detached HEAD instead of attaching a branch. */
  detach?: boolean,
) =>
  invoke<void>("create_worktree", { path, name, worktreePath, target, detach });
/** Remove a linked worktree. `force` is needed for a dirty or locked one. */
export const removeWorktree = (path: string, name: string, force = false) =>
  invoke<void>("remove_worktree", { path, name, force });
/** One WIP row per *dirty* worktree, each on its own HEAD's lane (G18). */
export const wipRows = (path: string) => invoke<WipRow[]>("wip_rows", { path });
/**
 * Resolve the candidate tokens on one hovered terminal line (G19). Only the
 * ones this repository actually knows come back, so prose stays prose.
 */
export const resolveTerminalTokens = (path: string, tokens: string[]) =>
  invoke<TerminalToken[]>("resolve_terminal_tokens", { path, tokens });
export const blameFile = (path: string, file: string, oid?: string) =>
  invoke<BlameLine[]>("blame_file", { path, file, oid });
export const fileHistory = (path: string, file: string, limit: number, follow: boolean) =>
  invoke<HistoryEntry[]>("file_history", { path, file, limit, follow });
export const lineHistory = (path: string, file: string, start: number, end: number, limit: number) =>
  invoke<HistoryEntry[]>("line_history", { path, file, start, end, limit });
export const pathAtCommit = (path: string, file: string, oid: string) =>
  invoke<string | null>("path_at_commit", { path, file, oid });
export const listContributors = (path: string, limit?: number) =>
  invoke<Contributor[]>("list_contributors", { path, limit });
export const mergeTarget = (path: string, branch: string) =>
  invoke<MergeTarget | null>("merge_target", { path, branch });
export const mergeRelation = (path: string, target: string, source: string) =>
  invoke<MergeRelation>("merge_relation", { path, target, source });
/** Refs that contain `oid` without pointing at it — ghost refs (overview §1.2). */
export const containingRefs = (path: string, oid: string, limit?: number) =>
  invoke<GhostRef[]>("containing_refs", { path, oid, limit });
/** Path completion for `file:` values, from `oid`'s tree (or HEAD's). */
export const completePaths = (path: string, oid: string | null, prefix: string, limit?: number) =>
  invoke<PathCompletion[]>("complete_paths", { path, oid, prefix, limit });
export const autolinkPatterns = (path: string) =>
  invoke<AutolinkPattern[]>("autolink_patterns", { path });
export const commitTemplate = (path: string) =>
  invoke<string | null>("commit_template", { path });
export const commitStats = (path: string, oids: string[]) =>
  invoke<CommitStats[]>("commit_stats", { path, oids });
export const conflictSet = (path: string) => invoke<ConflictSet | null>("conflict_set", { path });
export const predictRebaseConflicts = (path: string, onto: string, plan: RebasePlanItem[]) =>
  invoke<PredictedConflict[]>("predict_rebase_conflicts", { path, onto, plan });
export const fileAtCommit = (path: string, oid: string, file: string) =>
  invoke<FileContent>("file_at_commit", { path, oid, file });
export const stashSave = (path: string, message: string | undefined, includeUntracked: boolean) =>
  invoke<string>("stash_save", { path, message, includeUntracked });
/** Stash only what is staged (`01-commit.md` §3.2). Needs git 2.35. */
export const stashSaveStaged = (path: string, message?: string) =>
  invoke<void>("stash_save_staged", { path, message });
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
export const ptySpawn = (cwd: string, rows: number, cols: number, shell?: string | null) =>
  invoke<string>("pty_spawn", { cwd, rows, cols, shell: shell || undefined });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  invoke<void>("pty_resize", { id, rows, cols });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

// P6 — settings and identity
export const getSettings = () => invoke<Settings>("get_settings");
/** Returns what was stored: the clamped values, not what was asked for. */
export const saveSettings = (settings: Settings) => invoke<Settings>("save_settings", { settings });
export const getIdentity = (path?: string) => invoke<IdentityInfo>("get_identity", { path });
export const setIdentity = (scope: IdentityScope, name: string, email: string, path?: string) =>
  invoke<IdentityInfo>("set_identity", { scope, path, name, email });
