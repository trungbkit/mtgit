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
}

export type RefKind = "localBranch" | "remoteBranch" | "tag" | "head";

export interface RefBadge {
  name: string;
  kind: RefKind;
  isHead: boolean;
}

export interface BranchInfo {
  name: string;
  oid: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface RefList {
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: BranchInfo[];
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
  author: string;
  email: string;
  timestamp: number;
  lane: number;
  color: number;
  edges: Edge[];
  refs: RefBadge[];
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

// ---- Worktrees, blame, file history, file content ----

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string | null;
  locked: boolean;
}

export interface BlameLine {
  lineNo: number;
  oid: string;
  author: string;
  summary: string;
  timestamp: number;
  content: string;
}

export interface HistoryEntry {
  oid: string;
  summary: string;
  author: string;
  email: string;
  timestamp: number;
}

export interface FileContent {
  text: string;
  binary: boolean;
  isLarge: boolean;
}
