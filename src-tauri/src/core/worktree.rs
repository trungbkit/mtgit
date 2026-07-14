//! Linked worktrees: list existing ones and add new ones.

use crate::error::{Error, Result};
use git2::{Oid, Repository, WorktreeAddOptions, WorktreeLockStatus};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    /// Branch checked out in the worktree, if resolvable.
    pub branch: Option<String>,
    pub locked: bool,
}

pub fn list(repo: &Repository) -> Result<Vec<WorktreeInfo>> {
    let mut out = Vec::new();
    for name in repo.worktrees()?.iter().flatten() {
        let Ok(wt) = repo.find_worktree(name) else { continue };
        let locked = matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_)));
        let branch = Repository::open_from_worktree(&wt)
            .ok()
            .and_then(|r| r.head().ok().and_then(|h| h.shorthand().map(str::to_string)));
        out.push(WorktreeInfo {
            name: name.to_string(),
            path: wt.path().to_string_lossy().into_owned(),
            branch,
            locked,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Add a linked worktree at `path`. When `target` (an oid) is given, a new
/// branch named `name` is created there and checked out in the worktree.
pub fn add(repo: &Repository, name: &str, path: &str, target: Option<&str>) -> Result<()> {
    let mut opts = WorktreeAddOptions::new();
    match target {
        Some(t) => {
            let oid = Oid::from_str(t).map_err(|_| Error::Msg(format!("bad oid: {t}")))?;
            let commit = repo.find_commit(oid)?;
            let branch = repo.branch(name, &commit, false)?;
            let reference = branch.into_reference();
            opts.reference(Some(&reference));
            repo.worktree(name, Path::new(path), Some(&opts))?;
        }
        None => {
            repo.worktree(name, Path::new(path), Some(&opts))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn add_and_list_worktree() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        // Point HEAD at a real branch so the main repo is not bare/unborn.
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();

        let wt_dir = t.dir.path().parent().unwrap().join("wt-test-xyz");
        add(&t.repo, "wt1", wt_dir.to_str().unwrap(), Some(&a.to_string())).unwrap();

        let list = list(&t.repo).unwrap();
        assert!(list.iter().any(|w| w.name == "wt1"));
        // cleanup
        let _ = std::fs::remove_dir_all(&wt_dir);
    }
}
