//! Per-file commit history (a `git log -- <file>` equivalent).

use crate::error::Result;
use git2::{DiffOptions, Repository, Sort};
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
}

/// Commits reachable from HEAD (newest first) whose diff vs the first parent
/// touches `file`, up to `limit` entries. Rename-following is best-effort.
pub fn file_log(repo: &Repository, file: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;
    walk.push_head()?;

    let path = Path::new(file);
    let mut out = Vec::new();

    for oid in walk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

        let touched = match &parent_tree {
            Some(_) => {
                let mut opts = DiffOptions::new();
                opts.pathspec(file);
                let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
                diff.deltas().len() > 0
            }
            // Root commit: it introduced the file if the file exists in its tree.
            None => tree.get_path(path).is_ok(),
        };

        if touched {
            let author = commit.author();
            out.push(HistoryEntry {
                oid: oid.to_string(),
                summary: commit.summary().unwrap_or("").to_string(),
                author: author.name().unwrap_or("").to_string(),
                email: author.email().unwrap_or("").to_string(),
                timestamp: author.when().seconds(),
            });
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
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

        let log = file_log(&t.repo, "file.txt", 100).unwrap();
        // TestRepo rewrites file.txt every commit, so both should appear.
        assert!(log.len() >= 2);
        assert_eq!(log[0].oid, b.to_string());
    }
}
