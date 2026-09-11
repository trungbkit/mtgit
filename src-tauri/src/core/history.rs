//! Per-file commit history (`git log -- <file>`), with the two things that
//! make it correct across a refactor: `--follow` and `-L` (G22).
//!
//! Both matter for the same reason. A plain path filter stops dead at the
//! commit that renamed the file, so history — and the blame reached through
//! it — silently reports "this code was written when it was moved" rather
//! than when it was written. That is a wrong answer presented confidently,
//! which is why `docs/feature-requirements/00-overview.md` treats following
//! as a correctness item and not a feature.
//!
//! ## Following a rename
//!
//! Rename detection needs *both* sides of the pair, so a pathspec — which
//! filters the old name out — makes a rename look like an add. We therefore
//! keep the cheap pathspec walk and only fall back to a full, rename-detected
//! diff at the one commit where the tracked path appears as `Added`. That is
//! the only place a rename can be hiding.
//!
//! ## Following a line range
//!
//! `-L` tracks a line range backwards through history. At each commit we diff
//! against the first parent with zero context and map the range from the
//! child's line numbering into the parent's: hunks entirely above the range
//! shift it by `old_lines - new_lines`, and a hunk that overlaps it both marks
//! the commit as touching the range and widens the range to cover the lines
//! the hunk replaced. A commit is an entry exactly when some hunk overlapped.

use crate::error::{Error, Result};
use git2::{Commit, Delta, Diff, DiffOptions, Oid, Repository, Sort};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    /// The path the file had *at this commit*. Equal to the requested path
    /// until following crosses a rename; after that it is the older name, and
    /// the viewer needs it to ask for the right blob.
    pub path: String,
    /// Set only on the commit that performed a rename: the name the file had
    /// in that commit's parent.
    pub renamed_from: Option<String>,
}

fn entry(commit: &Commit, path: &str, renamed_from: Option<String>) -> HistoryEntry {
    let author = commit.author();
    HistoryEntry {
        oid: commit.id().to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
        author: author.name().unwrap_or("").to_string(),
        email: author.email().unwrap_or("").to_string(),
        timestamp: author.when().seconds(),
        path: path.to_string(),
        renamed_from,
    }
}

/// Diff a commit against its first parent, limited to `path`. The flag says
/// whether there *was* a first parent — a root commit diffs against nothing,
/// and "no deltas" then means the opposite of what it means elsewhere.
fn diff_for_path<'r>(
    repo: &'r Repository,
    commit: &Commit<'r>,
    path: &str,
) -> Result<(Diff<'r>, bool)> {
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    opts.pathspec(path).context_lines(0);
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    Ok((diff, parent_tree.is_some()))
}

/// The old name of `path` if `commit` renamed it into place, else `None`.
///
/// Only called when the pathspec walk reported `path` as `Added`, because a
/// full rename-detected diff of every commit would cost the whole tree.
fn rename_source(repo: &Repository, commit: &Commit, path: &str) -> Option<String> {
    let tree = commit.tree().ok()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok())?;
    let mut diff = repo
        .diff_tree_to_tree(Some(&parent_tree), Some(&tree), Some(DiffOptions::new().context_lines(0)))
        .ok()?;
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).copies(true);
    diff.find_similar(Some(&mut find)).ok()?;

    diff.deltas()
        .find(|d| {
            matches!(d.status(), Delta::Renamed | Delta::Copied)
                && d.new_file().path().and_then(Path::to_str) == Some(path)
        })
        .and_then(|d| d.old_file().path().and_then(Path::to_str).map(str::to_string))
}

/// Commits reachable from HEAD (newest first) whose diff vs the first parent
/// touches `file`, up to `limit` entries.
///
/// With `follow`, the tracked path moves back through renames, so the log
/// continues past the commit that moved the file.
pub fn file_log(repo: &Repository, file: &str, limit: usize, follow: bool) -> Result<Vec<HistoryEntry>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;
    walk.push_head()?;

    let mut current = file.to_string();
    let mut out = Vec::new();

    for oid in walk {
        let commit = repo.find_commit(oid?)?;
        let (diff, has_parent) = diff_for_path(repo, &commit, &current)?;

        let touched = if has_parent {
            diff.deltas().len() > 0
        } else {
            // Root commit: it introduced the file if the file is in its tree.
            commit.tree()?.get_path(Path::new(&current)).is_ok()
        };
        if !touched {
            continue;
        }

        let added = diff.deltas().next().map(|d| d.status()) == Some(Delta::Added);
        let renamed_from = if follow && added { rename_source(repo, &commit, &current) } else { None };

        out.push(entry(&commit, &current, renamed_from.clone()));
        if let Some(old) = renamed_from {
            current = old;
        }
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// One `@@` hunk, reduced to the four numbers the range mapping needs.
#[derive(Clone, Copy, Debug)]
struct Span {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
}

fn spans(diff: &Diff) -> Vec<Span> {
    let mut out = Vec::new();
    let _ = diff.foreach(
        &mut |_, _| true,
        None,
        Some(&mut |_, hunk| {
            out.push(Span {
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
            });
            true
        }),
        None,
    );
    out.sort_by_key(|s| s.new_start);
    out
}

/// Map `range` (inclusive, 1-based, in the child's numbering) back into the
/// parent's, and report whether any hunk overlapped it.
///
/// Returns `(touched, parent_range)`.
fn map_range_to_parent(spans: &[Span], range: (u32, u32)) -> (bool, (u32, u32)) {
    let (lo, hi) = range;
    let mut offset: i64 = 0;
    let mut touched = false;
    let mut out: Option<(u32, u32)> = None;

    for s in spans {
        // A hunk that adds nothing sits *between* two new-side lines; git
        // numbers it by the line before, so it abuts both `new_start` and
        // `new_start + 1` and must count as touching either.
        let (h_lo, h_hi) = if s.new_lines == 0 {
            (s.new_start, s.new_start.saturating_add(1))
        } else {
            (s.new_start, s.new_start + s.new_lines - 1)
        };

        if h_hi < lo {
            offset += i64::from(s.old_lines) - i64::from(s.new_lines);
            continue;
        }
        if h_lo > hi {
            break;
        }

        touched = true;
        let (o_lo, o_hi) = if s.old_lines == 0 {
            (s.old_start, s.old_start.saturating_add(1))
        } else {
            (s.old_start, s.old_start + s.old_lines - 1)
        };
        out = Some(match out {
            Some((a, b)) => (a.min(o_lo), b.max(o_hi)),
            None => (o_lo, o_hi),
        });
    }

    let shift = |n: u32| -> u32 { (i64::from(n) + offset).max(1) as u32 };
    let shifted = (shift(lo), shift(hi));
    let parent = match out {
        Some((a, b)) => (shifted.0.min(a), shifted.1.max(b)),
        None => shifted,
    };
    (touched, parent)
}

/// `git log -L <start>,<end>:<file>` — the commits that changed those lines,
/// with the range tracked backwards (and across renames) as history unwinds.
pub fn line_log(
    repo: &Repository,
    file: &str,
    start: u32,
    end: u32,
    limit: usize,
) -> Result<Vec<HistoryEntry>> {
    if start == 0 || end < start {
        return Err(Error::Msg(format!("bad line range: {start},{end}")));
    }

    let mut current = file.to_string();
    let mut range = (start, end);
    let mut commit = match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();

    loop {
        let (diff, has_parent) = diff_for_path(repo, &commit, &current)?;

        if !has_parent {
            if commit.tree()?.get_path(Path::new(&current)).is_ok() {
                out.push(entry(&commit, &current, None));
            }
            break;
        }

        let (touched, parent_range) = map_range_to_parent(&spans(&diff), range);
        if touched {
            let added = diff.deltas().next().map(|d| d.status()) == Some(Delta::Added);
            let renamed_from = if added { rename_source(repo, &commit, &current) } else { None };
            out.push(entry(&commit, &current, renamed_from.clone()));
            if let Some(old) = renamed_from {
                current = old;
            }
            if out.len() >= limit {
                break;
            }
        }
        range = parent_range;

        commit = match commit.parent(0) {
            Ok(p) => p,
            Err(_) => break,
        };
    }
    Ok(out)
}

/// Resolve the blob of `file` as of `oid`, following renames backwards from
/// HEAD so the file viewer can show a revision from before the rename.
pub fn path_at(repo: &Repository, file: &str, oid: &str) -> Result<Option<String>> {
    let target = Oid::from_str(oid).map_err(|_| Error::Msg(format!("bad oid: {oid}")))?;
    for e in file_log(repo, file, 10_000, true)? {
        if e.oid == target.to_string() {
            return Ok(Some(e.path));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn file_log_finds_commits_touching_file() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        // Point HEAD at the tip so revwalk reaches both commits.
        t.repo.branch("main", &t.repo.find_commit(b).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();

        let log = file_log(&t.repo, "file.txt", 100, false).unwrap();
        // TestRepo rewrites file.txt every commit, so both should appear.
        assert!(log.len() >= 2);
        assert_eq!(log[0].oid, b.to_string());
    }

    /// The rule G22 exists for: without following, history stops at the rename
    /// and the code's real author is lost.
    #[test]
    fn follow_continues_past_a_rename_and_plain_history_stops_at_it() {
        let t = TestRepo::new();
        let a = t.commit_files("write old", &[], &[("old.rs", "one\ntwo\n")]);
        let b = t.commit_files("edit old", &[a], &[("old.rs", "one\ntwo\nthree\n")]);
        let c = t.commit_files("rename", &[b], &[("new.rs", "one\ntwo\nthree\n")]);
        let d = t.commit_files("edit new", &[c], &[("new.rs", "one\ntwo\nthree\nfour\n")]);
        t.set_head_to(d);

        let plain = file_log(&t.repo, "new.rs", 100, false).unwrap();
        assert_eq!(
            plain.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(),
            ["edit new", "rename"]
        );

        let followed = file_log(&t.repo, "new.rs", 100, true).unwrap();
        assert_eq!(
            followed.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(),
            ["edit new", "rename", "edit old", "write old"]
        );
        assert_eq!(followed[1].renamed_from.as_deref(), Some("old.rs"));
        // Entries before the rename carry the name the file had then, which is
        // what the viewer needs to fetch the blob.
        assert_eq!(followed[2].path, "old.rs");
        assert_eq!(followed[0].path, "new.rs");
    }

    #[test]
    fn line_log_reports_only_commits_that_touched_the_range() {
        let t = TestRepo::new();
        let a = t.commit_files("create", &[], &[("f.txt", "1\n2\n3\n4\n5\n")]);
        // Touches line 5 only — outside the range we ask about.
        let b = t.commit_files("tail", &[a], &[("f.txt", "1\n2\n3\n4\nFIVE\n")]);
        // Touches line 2 — inside it.
        let c = t.commit_files("head", &[b], &[("f.txt", "1\nTWO\n3\n4\nFIVE\n")]);
        t.set_head_to(c);

        let log = line_log(&t.repo, "f.txt", 1, 3, 100).unwrap();
        assert_eq!(
            log.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(),
            ["head", "create"]
        );
    }

    /// The mapping, not the overlap test, is what makes `-L` more than a
    /// fixed-window filter: an insertion above the range moves the range.
    #[test]
    fn line_log_shifts_the_range_when_lines_are_inserted_above_it() {
        let t = TestRepo::new();
        let a = t.commit_files("create", &[], &[("f.txt", "a\nb\nTARGET\n")]);
        // Two lines prepended: TARGET is line 3 now, line 5 after this commit.
        let b = t.commit_files("prepend", &[a], &[("f.txt", "x\ny\na\nb\nTARGET\n")]);
        let c = t.commit_files("edit target", &[b], &[("f.txt", "x\ny\na\nb\nCHANGED\n")]);
        t.set_head_to(c);

        // Line 5 at HEAD is TARGET; only "edit target" and "create" touched it.
        let log = line_log(&t.repo, "f.txt", 5, 5, 100).unwrap();
        assert_eq!(
            log.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(),
            ["edit target", "create"]
        );
    }

    #[test]
    fn line_log_follows_the_range_across_a_rename() {
        let t = TestRepo::new();
        let a = t.commit_files("create", &[], &[("old.txt", "a\nb\nc\n")]);
        let b = t.commit_files("rename", &[a], &[("new.txt", "a\nb\nc\n")]);
        let c = t.commit_files("edit", &[b], &[("new.txt", "a\nB\nc\n")]);
        t.set_head_to(c);

        let log = line_log(&t.repo, "new.txt", 2, 2, 100).unwrap();
        assert_eq!(
            log.iter().map(|e| e.summary.as_str()).collect::<Vec<_>>(),
            ["edit", "rename", "create"]
        );
        assert_eq!(log[2].path, "old.txt");
    }

    #[test]
    fn line_log_rejects_an_inverted_range() {
        let t = TestRepo::new();
        let a = t.commit_files("create", &[], &[("f.txt", "a\n")]);
        t.set_head_to(a);
        assert!(line_log(&t.repo, "f.txt", 5, 2, 10).is_err());
    }
}
