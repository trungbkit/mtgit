// Types mirroring the Rust structs across the IPC boundary. Kept in sync by
// hand for now; the plan calls for generating these via tauri-specta (TODO).

export interface HeadInfo {
  branch: string | null;
  oid: string | null;
  detached: boolean;
  unborn: boolean;
}

export interface RepoInfo {
  name: string;
  path: string;
  head: HeadInfo;
  isBare: boolean;
  /** Admin name of the linked worktree this handle is, or null for the main one. */
  worktree: string | null;
}

export type RefKind = "localBranch" | "remoteBranch" | "tag" | "head";

export interface RefBadge {
  name: string;
  kind: RefKind;
  isHead: boolean;
}

/**
 * A ref that contains a commit without pointing at it — what the row *would*
 * be labelled (overview §1.2). Mirrors `core::refs::GhostRef`.
 */
export interface GhostRef {
  name: string;
  kind: RefKind;
  /** Commits between the ref's tip and this commit; 1 for its parent. */
  distance: number;
}

export interface BranchInfo {
  name: string;
  oid: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Upstream configured but its remote-tracking ref is gone (STATUS C8). */
  upstreamGone: boolean;
}

export interface RefList {
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: BranchInfo[];
}

/** A configured remote. Mirrors `core::remote::RemoteInfo`. */
export interface RemoteInfo {
  name: string;
  /** Fetch URL; null for a remote configured without one. */
  url: string | null;
  /** `remote.<name>.pushurl`, present only when it differs from `url`. */
  pushUrl: string | null;
  /** Remote-tracking branches under `refs/remotes/<name>/`. */
  branches: number;
}

/** What `push_target` reports about the current branch. */
export interface PushTarget {
  /** Current branch shorthand; null on a detached or unborn HEAD. */
  branch: string | null;
  /** Remote to push to: upstream remote, else origin, else the sole remote. */
  remote: string | null;
  /** Is an upstream configured? (Read from config, as git does.) */
  hasUpstream: boolean;
}

/**
 * A ref / sha / range found in the terminal panel and resolved against this
 * repository (G19). Mirrors `core::terminal::TerminalToken`.
 */
export interface TerminalToken {
  /** The text exactly as the terminal printed it. */
  token: string;
  kind: RefKind;
  /** The commit to reveal. For a range, its right-hand end. */
  oid: string;
  label: string;
}

export type EdgeKind = "continue" | "branch" | "merge";

export interface Edge {
  fromLane: number;
  toLane: number;
  kind: EdgeKind;
  color: number;
}

export interface GraphRow {
  oid: string;
  parents: string[];
  summary: string;
  /**
   * First paragraph of the body, flattened and truncated by `core/graph.rs`.
   * Drawn dimmed after the summary; empty when there is nothing to show.
   */
  bodyPreview: string;
  author: string;
  email: string;
  timestamp: number;
  lane: number;
  color: number;
  edges: Edge[];
  refs: RefBadge[];
  /** On this branch but not its upstream — a push would send it. */
  unpushed: boolean;
  /** On the upstream but not this branch — a pull would bring it in. */
  unpulled: boolean;
}

/**
 * One `file:` autocomplete candidate. Mirrors `core::paths::PathCompletion`.
 * Completion is per path segment, so a directory arrives with its trailing
 * slash and is meant to be descended into rather than searched for.
 */
export interface PathCompletion {
  path: string;
  isDir: boolean;
}

/** Modifiers beside the search field. Mirrors `core::search::SearchOptions`. */
export interface SearchOptions {
  matchCase: boolean;
  /** AND the message terms together instead of OR-ing them. */
  matchAll: boolean;
  matchRegex: boolean;
  matchWholeWord: boolean;
  /** Must match `PAGE_SIZE` in `GraphView`, or `pageHint` points at the wrong page. */
  pageSize: number;
}

export interface SearchHit {
  oid: string;
  /** Row index in graph order; null for a commit the graph does not contain. */
  index: number | null;
  /** Which `getGraph` page `index` falls on. */
  pageHint: number | null;
}

export interface SearchResults {
  hits: SearchHit[];
  /** The result cap cut the list short — say so, never truncate silently. */
  truncated: boolean;
  cancelled: boolean;
  /** The query read back in prose, for the empty state. */
  summary: string;
  notes: string[];
}

export interface GraphPage {
  rows: GraphRow[];
  total: number;
  head: string | null;
}

// ---- M2: commit detail + diff ----

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "conflicted"
  | "untracked"
  | "unknown";

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitDetail {
  oid: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  parents: string[];
  files: FileChange[];
}

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  isLarge: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

// ---- M3: status ----

export interface StatusEntry {
  path: string;
  status: FileStatus;
  size: number | null;
}

export interface StatusReport {
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  conflicted: StatusEntry[];
  isDirty: boolean;
}

// ---- M4: merge, stash, network ----

export type MergeKind = "upToDate" | "fastForward" | "normal" | "conflicts";

export interface MergeResult {
  kind: MergeKind;
  conflicts: string[];
  oid: string | null;
}

export type MergeMode = "default" | "ffOnly" | "noFf";
export type ResetMode = "soft" | "mixed" | "hard";

export interface ConflictResult {
  conflicts: string[];
  oid: string | null;
}

export interface RebaseResult {
  applied: number;
  conflicts: string[];
  done: boolean;
}

export interface StashEntry {
  index: number;
  message: string;
  oid: string;
}

export interface GitOpResult {
  success: boolean;
  code: number | null;
  output: string;
}

export interface CommandResult extends GitOpResult {
  oid: string | null;
  conflicts: string[];
  skipped: number;
  /** The operation stashed the working tree to get started (`07-cherry-pick.md` B4). */
  autoStashed: boolean;
  /** The stash was kept rather than popped — a pause, or a conflicting pop. */
  stashKept: boolean;
}

export type CheckoutRecovery = "normal" | "stash" | "discard";

export interface CheckoutResult {
  branch: string | null;
  detached: boolean;
  autoStashed: boolean;
  stashConflicts: boolean;
  previousHead: string;
  submodulesChanged: boolean;
}

export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface RebasePlanItem {
  oid: string;
  action: RebaseAction;
  message?: string;
}

export interface RewriteInfo {
  commits: number;
  pushed: number;
  merges: number;
}

export interface RebaseCommit {
  oid: string;
  summary: string;
  author: string;
  email: string;
  /** A merge commit: flagged, not replayed — an interactive rebase flattens it. */
  isMerge: boolean;
}

/** One predicted clash from `predict_rebase_conflicts` (G26). An estimate. */
export interface PredictedConflict {
  /** Index of the step in the plan as it was sent. */
  index: number;
  oid: string;
  files: string[];
}

export interface OperationInfo {
  kind: "merge" | "rebase" | "cherryPick" | "revert" | "operation";
  conflicts: string[];
  currentSha: string | null;
  current: number;
  total: number;
  canContinue: boolean;
  canSkip: boolean;
}

export interface ConflictFile {
  path: string;
  ours: string;
  theirs: string;
  output: string;
  binary: boolean;
}

export interface HistoryStatus {
  undoLabel: string | null;
  redoLabel: string | null;
  restoredMessage: string | null;
}

// ---- Worktrees, blame, file history, file content ----

export interface WorktreeInfo {
  /** Admin name — what `git worktree remove` takes, not necessarily the folder. */
  name: string;
  path: string;
  branch: string | null;
  headOid: string | null;
  locked: boolean;
  /** The repository's own working directory. It cannot be removed. */
  isMain: boolean;
  /** The worktree the active tab is looking at. */
  isCurrent: boolean;
  /** Changed files, or null when the worktree could not be opened. */
  changed: number | null;
}

/** What `copyChangesToWorktree` did. Mirrors `core::worktree::CopyResult`. */
export interface CopyResult {
  files: number;
  /** Changed files the patch could not carry, and so did not copy. */
  skipped: number;
  worktree: string;
  path: string;
}

/**
 * A dirty worktree's uncommitted state, placed on the graph (G18).
 *
 * Deliberately *not* a `GraphRow`: it is not a commit, and inserting it into
 * the row list would shift the indices `searchCommits` returns as page hints.
 */
export interface WipRow {
  worktree: string;
  path: string;
  branch: string | null;
  headOid: string | null;
  /** Lane of this worktree's HEAD — computed in Rust (invariant 5). */
  lane: number;
  color: number;
  /** Row index of HEAD in the full layout, or null when it is not in it. */
  headIndex: number | null;
  changed: number;
  isCurrent: boolean;
}

export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string | null;
  oid: string | null;
}

export interface BlameLine {
  lineNo: number;
  oid: string;
  author: string;
  summary: string;
  timestamp: number;
  content: string;
  /** Heatmap bucket, 0 (oldest change in this file) to 9 (newest) — G21. */
  age: number;
}

export interface HistoryEntry {
  oid: string;
  summary: string;
  author: string;
  email: string;
  timestamp: number;
  /** The name the file had at this commit; differs after a followed rename. */
  path: string;
  /** Set only on the commit that renamed the file: its previous name. */
  renamedFrom: string | null;
}

/** Mirrors `core::contributors::Contributor` (G28). */
export interface Contributor {
  name: string;
  email: string;
  commits: number;
  /** Commits where they appear only in a `Co-authored-by:` trailer. */
  coAuthored: number;
  lastCommit: string;
  lastTimestamp: number;
}

/** Mirrors `core::refs::MergeRelation` — what a ref drop can actually do. */
export interface MergeRelation {
  canFastForward: boolean;
  upToDate: boolean;
  ahead: number;
  behind: number;
}

/** Mirrors `core::refs::MergeTarget` (G23). */
export interface MergeTarget {
  ref: string;
  oid: string;
  ahead: number;
  behind: number;
  /** How it was decided: `config`, `remoteHead` or `conventional`. */
  source: "config" | "remoteHead" | "conventional";
}

/** One `<<<<<<< / ======= / >>>>>>>` block. Mirrors `core::advanced::ConflictRegion`. */
export interface ConflictRegion {
  index: number;
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
}

export interface ConflictFileEntry {
  path: string;
  binary: boolean;
  regions: ConflictRegion[];
}

/**
 * Every conflicted file at once, with both sides named by ref (G25 / C4).
 * Mirrors `commands::ConflictSetView`, which flattens `core::advanced::ConflictSet`.
 */
export interface ConflictSet {
  kind: ConflictKindName;
  /** What "ours" *is* — a branch name or short sha, never the word "ours". */
  oursLabel: string;
  theirsLabel: string;
  oursOid: string | null;
  theirsOid: string | null;
  /** Lane palette index, or null when the side is not in the layout. */
  oursColor: number | null;
  theirsColor: number | null;
  files: ConflictFileEntry[];
}

export type ConflictKindName = "merge" | "rebase" | "cherryPick" | "revert" | "operation";

/** Mirrors `core::autolink::AutolinkPattern` (G20). Link-out only. */
export interface AutolinkPattern {
  prefix: string;
  /** Target URL with `<num>` standing in for the reference. */
  url: string;
  alphanumeric: boolean;
  source: "config" | "builtin";
}

export interface FileContent {
  text: string;
  binary: boolean;
  isLarge: boolean;
}

// ---- P6: settings and identity ---------------------------------------------

export type Theme = "system" | "light" | "dark";
export type Density = "compact" | "normal" | "comfortable";
export type DateStyle = "relative" | "absolute";

/**
 * Mirrors `core::settings::Settings`. Persisted to a JSON file in the app's
 * config directory, not to `localStorage` — see that module's note.
 */
export interface Settings {
  theme: Theme;
  density: Density;
  fontSize: number;
  dateStyle: DateStyle;

  diffMode: DiffViewMode;
  diffIgnoreWhitespace: boolean;
  diffWordWrap: boolean;
  diffTabWidth: number;

  defaultCloneDir: string | null;
  /** Default minutes between background fetches; 0 is off. A repository may
   *  override it, in which case the override wins. */
  autoFetchMinutes: number;
  cherryPickAppendOrigin: boolean;
  /** Follow renames in file history and blame (G22). Defaults on. */
  historyFollowRenames: boolean;
  /** Tint the blame gutter by line age (G21). */
  blameHeatmap: boolean;
  /** Optional graph columns, in display order (G16). */
  graphColumns: GraphColumnId[];
  /** Ref pills shown inline before the rest collapse into `+N` (overview §1.2). */
  graphRefInlineCount: number;

  terminalFontSize: number;
  terminalShell: string | null;

  /** Action id -> chord, for the actions the user has rebound. */
  keybindings: Record<string, string>;

  /** Width of the sidebar and the detail panel, in CSS pixels. */
  sidebarWidth: number;
  detailWidth: number;

  recentRepos: PersistedRecentRepo[];
}

/**
 * The optional graph columns (G16). The message column is not one of them: it
 * is always present and always takes the remaining width.
 */
export type GraphColumnId = "author" | "changes" | "date" | "sha";

/** Mirrors `core::diff::CommitStats` — the Changes column's numbers. */
export interface CommitStats {
  oid: string;
  files: number;
  additions: number;
  deletions: number;
}

/** `diffMode`'s own name, kept distinct from `stores/session`'s `DiffMode`. */
export type DiffViewMode = "inline" | "split";

export interface PersistedRecentRepo {
  path: string;
  name: string;
  lastOpened: number;
  branch: string | null;
}

export type IdentityScope = "global" | "repo";

/** Mirrors `core::identity::IdentityInfo`. */
export interface IdentityInfo {
  globalName: string | null;
  globalEmail: string | null;
  /** The repository's own override; null means "inherited". */
  repoName: string | null;
  repoEmail: string | null;
  /** What git would stamp on a commit made right now. */
  effectiveName: string | null;
  effectiveEmail: string | null;
}
