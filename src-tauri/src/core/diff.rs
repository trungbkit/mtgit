//! Commit detail and structured diffs. We hand the frontend fully-parsed hunks
//! (never raw patch text) so it has complete control over inline/split
//! rendering and syntax highlighting.

use crate::error::{Error, Result};
use git2::{Delta, Diff, DiffOptions, Oid, Patch, Repository, Tree};
use serde::Serialize;

/// Files larger than this (either side) skip line-level diffing; the frontend
/// shows a "large file" placeholder instead of choking the WebView.
const LARGE_FILE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub oid: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub parents: Vec<String>,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Typechange,
    Conflicted,
    Untracked,
    Unknown,
}

impl From<Delta> for FileStatus {
    fn from(d: Delta) -> Self {
        match d {
            Delta::Added => FileStatus::Added,
            Delta::Deleted => FileStatus::Deleted,
            Delta::Modified => FileStatus::Modified,
            Delta::Renamed => FileStatus::Renamed,
            Delta::Copied => FileStatus::Copied,
            Delta::Typechange => FileStatus::Typechange,
            Delta::Conflicted => FileStatus::Conflicted,
            Delta::Untracked => FileStatus::Untracked,
            _ => FileStatus::Unknown,
        }
    }
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
    pub is_large: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<Hunk>,
}

fn base_options() -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.context_lines(3).include_typechange(true);
    opts
}

/// Apply the "ignore whitespace changes" preference.
///
/// `ignore_whitespace_change` rather than `ignore_whitespace`: the setting is
/// about reindentation and trailing spaces, and the stronger flag also hides a
/// change that *adds* whitespace where there was none, which in Python or a
/// Makefile is a behaviour change the user must see.
fn apply_whitespace(opts: &mut DiffOptions, ignore_whitespace: bool) {
    if ignore_whitespace {
        opts.ignore_whitespace_change(true);
    }
}

fn enable_rename_detection(diff: &mut Diff) {
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).copies(true);
    let _ = diff.find_similar(Some(&mut find));
}

/// Full metadata + changed-file summary for the right-hand panel.
pub fn commit_detail(repo: &Repository, oid: &str) -> Result<CommitDetail> {
    let oid = Oid::from_str(oid).map_err(|_| Error::Msg(format!("bad oid: {oid}")))?;
    let commit = repo.find_commit(oid)?;
    let author = commit.author();
    let committer = commit.committer();

    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut base_options()))?;
    enable_rename_detection(&mut diff);

    let files = file_changes(&diff)?;

    let message = commit.message().unwrap_or("");
    let (summary, body) = split_message(message);

    Ok(CommitDetail {
        oid: oid.to_string(),
        summary,
        body,
        author_name: author.name().unwrap_or("").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        author_time: author.when().seconds(),
        committer_name: committer.name().unwrap_or("").to_string(),
        committer_email: committer.email().unwrap_or("").to_string(),
        committer_time: committer.when().seconds(),
        parents: commit.parent_ids().map(|o| o.to_string()).collect(),
        files,
    })
}

/// Per-commit change counts for the graph's Changes column (G16).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitStats {
    pub oid: String,
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

/// Counts for a batch of commits.
///
/// Batched deliberately: the column is drawn per visible row, and one IPC call
/// per row would be forty round trips per scroll tick. `git2::Diff::stats` is
/// used rather than a full patch build — the column needs three numbers, not
/// hunks, and asking for hunks would make an expensive column ruinous.
///
/// A commit that cannot be read is skipped rather than failing the batch: one
/// bad oid in a window of forty must not blank the whole column.
pub fn commit_stats(repo: &Repository, oids: &[String]) -> Result<Vec<CommitStats>> {
    let mut out = Vec::with_capacity(oids.len());
    for raw in oids {
        let Ok(oid) = Oid::from_str(raw) else { continue };
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let Ok(tree) = commit.tree() else { continue };
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let mut opts = DiffOptions::new();
        opts.context_lines(0);
        let Ok(diff) = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        else {
            continue;
        };
        let Ok(stats) = diff.stats() else { continue };
        out.push(CommitStats {
            oid: raw.clone(),
            files: stats.files_changed(),
            additions: stats.insertions(),
            deletions: stats.deletions(),
        });
    }
    Ok(out)
}

/// Structured diff of a commit against its first parent (root vs empty tree).
pub fn commit_diff(
    repo: &Repository,
    oid: &str,
    path_filter: Option<&str>,
    ignore_whitespace: bool,
) -> Result<Vec<FileDiff>> {
    let oid = Oid::from_str(oid).map_err(|_| Error::Msg(format!("bad oid: {oid}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = base_options();
    apply_path_filter(&mut opts, path_filter);
    apply_whitespace(&mut opts, ignore_whitespace);
    let mut diff =
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    enable_rename_detection(&mut diff);
    file_diffs(&diff)
}

pub fn compare_commits(
    repo: &Repository,
    old: &str,
    new: &str,
    ignore_whitespace: bool,
) -> Result<Vec<FileDiff>> {
    let old_tree = repo.revparse_single(old)?.peel_to_commit()?.tree()?;
    let new_tree = repo.revparse_single(new)?.peel_to_commit()?.tree()?;
    let mut opts = base_options();
    apply_whitespace(&mut opts, ignore_whitespace);
    let mut diff =
        repo.diff_tree_to_tree(Some(&old_tree), Some(&new_tree), Some(&mut opts))?;
    enable_rename_detection(&mut diff);
    file_diffs(&diff)
}

/// Structured diff of the working tree. `staged=true` diffs HEAD..index,
/// otherwise index..workdir.
pub fn worktree_diff(
    repo: &Repository,
    staged: bool,
    path_filter: Option<&str>,
    ignore_whitespace: bool,
) -> Result<Vec<FileDiff>> {
    let mut opts = base_options();
    opts.include_untracked(!staged).recurse_untracked_dirs(!staged);
    apply_path_filter(&mut opts, path_filter);
    apply_whitespace(&mut opts, ignore_whitespace);

    let mut diff = if staged {
        let head_tree = head_tree(repo)?;
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };
    enable_rename_detection(&mut diff);
    file_diffs(&diff)
}

fn head_tree(repo: &Repository) -> Result<Option<Tree<'_>>> {
    match repo.head() {
        Ok(h) => Ok(Some(h.peel_to_tree()?)),
        Err(_) => Ok(None), // unborn branch: everything staged is "added"
    }
}

fn apply_path_filter(opts: &mut DiffOptions, path_filter: Option<&str>) {
    if let Some(p) = path_filter {
        opts.pathspec(p);
    }
}

fn file_changes(diff: &Diff) -> Result<Vec<FileChange>> {
    let mut out = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let old_path = delta.old_file().path().map(|p| p.to_string_lossy().into_owned());
        let old_path = match delta.status() {
            Delta::Renamed | Delta::Copied => old_path,
            _ => None,
        };
        let binary = delta.flags().is_binary();
        let (additions, deletions) = match Patch::from_diff(diff, idx) {
            Ok(Some(patch)) => {
                let (_, a, d) = patch.line_stats().unwrap_or((0, 0, 0));
                (a, d)
            }
            _ => (0, 0),
        };
        out.push(FileChange {
            path,
            old_path,
            status: delta.status().into(),
            additions,
            deletions,
            binary,
        });
    }
    Ok(out)
}

fn file_diffs(diff: &Diff) -> Result<Vec<FileDiff>> {
    let mut out = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let old_path = match delta.status() {
            Delta::Renamed | Delta::Copied => {
                delta.old_file().path().map(|p| p.to_string_lossy().into_owned())
            }
            _ => None,
        };
        let status: FileStatus = delta.status().into();
        let binary = delta.flags().is_binary();
        let too_big = delta.old_file().size() > LARGE_FILE_BYTES
            || delta.new_file().size() > LARGE_FILE_BYTES;

        let mut hunks = Vec::new();
        let mut additions = 0;
        let mut deletions = 0;

        if !binary && !too_big {
            if let Ok(Some(patch)) = Patch::from_diff(diff, idx) {
                let (_, a, d) = patch.line_stats().unwrap_or((0, 0, 0));
                additions = a;
                deletions = d;
                for h in 0..patch.num_hunks() {
                    let (hunk, line_count) = patch.hunk(h)?;
                    let header = String::from_utf8_lossy(hunk.header()).trim_end().to_string();
                    let mut lines = Vec::with_capacity(line_count);
                    for l in 0..line_count {
                        let line = patch.line_in_hunk(h, l)?;
                        let kind = match line.origin() {
                            '+' => LineKind::Add,
                            '-' => LineKind::Del,
                            _ => LineKind::Context,
                        };
                        lines.push(DiffLine {
                            kind,
                            old_no: line.old_lineno(),
                            new_no: line.new_lineno(),
                            text: String::from_utf8_lossy(line.content()).trim_end_matches('\n').to_string(),
                        });
                    }
                    hunks.push(Hunk { header, lines });
                }
            }
        }

        out.push(FileDiff {
            path,
            old_path,
            status,
            binary,
            is_large: too_big,
            additions,
            deletions,
            hunks,
        });
    }
    Ok(out)
}

/// Full file content at a commit, for the "File View" tab.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    pub binary: bool,
    pub is_large: bool,
}

pub fn file_content(repo: &Repository, oid: &str, file: &str) -> Result<FileContent> {
    let oid = Oid::from_str(oid).map_err(|_| Error::Msg(format!("bad oid: {oid}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let entry = tree
        .get_path(std::path::Path::new(file))
        .map_err(|_| Error::Msg(format!("file not found in commit: {file}")))?;
    let obj = entry.to_object(repo)?;
    let blob = obj.as_blob().ok_or_else(|| Error::Msg("not a file blob".into()))?;
    if blob.size() as u64 > LARGE_FILE_BYTES {
        return Ok(FileContent { text: String::new(), binary: false, is_large: true });
    }
    if blob.is_binary() {
        return Ok(FileContent { text: String::new(), binary: true, is_large: false });
    }
    Ok(FileContent {
        text: String::from_utf8_lossy(blob.content()).into_owned(),
        binary: false,
        is_large: false,
    })
}

fn split_message(message: &str) -> (String, String) {
    let trimmed = message.trim_end();
    match trimmed.split_once("\n\n") {
        Some((s, b)) => (s.replace('\n', " ").trim().to_string(), b.trim().to_string()),
        None => (trimmed.lines().next().unwrap_or("").to_string(), String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn commit_stats_counts_files_and_lines_per_commit() {
        let t = TestRepo::new();
        let a = t.commit_files("one", &[], &[("a.txt", "1\n")]);
        let b = t.commit_files("two", &[a], &[("a.txt", "1\n2\n"), ("b.txt", "x\n")]);

        let stats = commit_stats(&t.repo, &[b.to_string(), a.to_string()]).unwrap();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].oid, b.to_string());
        assert_eq!(stats[0].files, 2, "a.txt modified, b.txt added");
        assert_eq!(stats[0].additions, 2);
        assert_eq!(stats[0].deletions, 0);
        assert_eq!(stats[1].files, 1, "the root commit introduces one file");
    }

    /// One unreadable oid in a scroll window must not blank the column for the
    /// other thirty-nine rows.
    #[test]
    fn commit_stats_skips_an_oid_it_cannot_read() {
        let t = TestRepo::new();
        let a = t.commit_files("one", &[], &[("a.txt", "1\n")]);
        let stats =
            commit_stats(&t.repo, &["nonsense".into(), a.to_string(), "0".repeat(40)]).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].oid, a.to_string());
    }

    #[test]
    fn commit_diff_reports_added_lines() {
        let t = TestRepo::new();
        let a = t.commit("first", &[]);
        let b = t.commit("second", &[a]);

        let diffs = commit_diff(&t.repo, &b.to_string(), None, false).unwrap();
        assert_eq!(diffs.len(), 1);
        let fd = &diffs[0];
        assert_eq!(fd.path, "file.txt");
        // TestRepo rewrites file.txt each commit, so it's a modification.
        assert_eq!(fd.status, FileStatus::Modified);
        assert!(!fd.hunks.is_empty());
        assert!(fd.additions > 0);
    }

    /// Build two commits whose only difference is indentation.
    fn whitespace_only_change(t: &TestRepo) -> String {
        let write = |content: &str, parents: &[git2::Oid]| {
            let blob = t.repo.blob(content.as_bytes()).unwrap();
            let mut tb = t.repo.treebuilder(None).unwrap();
            tb.insert("file.txt", blob, 0o100644).unwrap();
            let tree = t.repo.find_tree(tb.write().unwrap()).unwrap();
            let sig = git2::Signature::new("T", "t@e", &git2::Time::new(1_600_000_000, 0)).unwrap();
            let parent_commits: Vec<_> =
                parents.iter().map(|p| t.repo.find_commit(*p).unwrap()).collect();
            let refs: Vec<&git2::Commit> = parent_commits.iter().collect();
            t.repo.commit(None, &sig, &sig, "c", &tree, &refs).unwrap()
        };
        let first = write("fn main() {\n  let x = 1;\n}\n", &[]);
        write("fn main() {\n      let x = 1;\n}\n", &[first]).to_string()
    }

    #[test]
    fn ignoring_whitespace_hides_a_reindentation() {
        let t = TestRepo::new();
        let oid = whitespace_only_change(&t);

        let shown = commit_diff(&t.repo, &oid, None, false).unwrap();
        assert_eq!(shown.len(), 1, "the change is a real one and is reported by default");
        assert!(shown[0].additions > 0);

        // git2 still reports the *file* as changed — the blob differs — but the
        // hunk that only reindents is gone, which is what the setting promises.
        let hidden = commit_diff(&t.repo, &oid, None, true).unwrap();
        assert!(
            hidden.is_empty() || hidden[0].hunks.is_empty(),
            "a whitespace-only hunk must not survive: {hidden:?}",
        );
    }

    #[test]
    fn ignoring_whitespace_keeps_a_real_change() {
        let t = TestRepo::new();
        let a = t.commit("first", &[]);
        let b = t.commit("second", &[a]);

        let diffs = commit_diff(&t.repo, &b.to_string(), None, true).unwrap();
        assert_eq!(diffs.len(), 1);
        assert!(!diffs[0].hunks.is_empty(), "content changes are still reported");
    }

    #[test]
    fn root_commit_diffs_against_empty_tree() {
        let t = TestRepo::new();
        let a = t.commit("root", &[]);
        let diffs = commit_diff(&t.repo, &a.to_string(), None, false).unwrap();
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].status, FileStatus::Added);
    }

    #[test]
    fn commit_detail_splits_summary_and_body() {
        let t = TestRepo::new();
        let a = t.commit_with_message("fix: thing\n\nLonger explanation here.", &[]);
        let d = commit_detail(&t.repo, &a.to_string()).unwrap();
        assert_eq!(d.summary, "fix: thing");
        assert_eq!(d.body, "Longer explanation here.");
        assert_eq!(d.files.len(), 1);
    }
}
