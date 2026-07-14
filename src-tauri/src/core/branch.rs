//! Branch lifecycle (create / rename / delete / checkout) and merge.

use crate::core::ops::conflict_paths;
use crate::error::{Error, Result};
use git2::{build::CheckoutBuilder, BranchType, MergeOptions, Repository};
use serde::{Deserialize, Serialize};

/// Create a branch at `target` (a ref name or oid; empty = current HEAD).
pub fn create_branch(repo: &Repository, name: &str, target: Option<&str>, checkout: bool) -> Result<()> {
    let commit = match target {
        Some(t) if !t.is_empty() => repo.revparse_single(t)?.peel_to_commit()?,
        _ => repo.head()?.peel_to_commit()?,
    };
    repo.branch(name, &commit, false)?;
    if checkout {
        checkout_ref(repo, name)?;
    }
    Ok(())
}

/// Delete a local branch. Refuses to delete the checked-out branch, and (unless
/// `force`) refuses to delete a branch not fully merged into HEAD, mirroring
/// `git branch -d` vs `-D`.
pub fn delete_branch(repo: &Repository, name: &str, force: bool) -> Result<()> {
    let mut branch = repo.find_branch(name, BranchType::Local)?;
    if branch.is_head() {
        return Err(Error::Msg("cannot delete the checked-out branch".into()));
    }
    if !force && !is_merged_into_head(repo, &branch)? {
        return Err(Error::Msg(format!(
            "branch '{name}' is not fully merged — deleting it will lose commits"
        )));
    }
    branch.delete()?;
    Ok(())
}

/// Is `branch`'s tip reachable from HEAD (i.e. already merged)?
fn is_merged_into_head(repo: &Repository, branch: &git2::Branch<'_>) -> Result<bool> {
    let tip = branch.get().peel_to_commit()?.id();
    let head = match repo.head().ok().and_then(|h| h.target()) {
        Some(h) => h,
        None => return Ok(false),
    };
    Ok(head == tip || repo.graph_descendant_of(head, tip)?)
}

pub fn rename_branch(repo: &Repository, old: &str, new: &str) -> Result<()> {
    let mut branch = repo.find_branch(old, BranchType::Local)?;
    branch.rename(new, false)?;
    Ok(())
}

/// Checkout a branch, remote-tracking branch, tag, or commit. Uses a safe
/// checkout so it refuses to clobber uncommitted changes.
///
/// Checking out a remote-tracking branch (e.g. `origin/feat`) with no matching
/// local branch creates a local branch tracking it and switches to that, rather
/// than detaching HEAD — the behaviour users expect from `git checkout feat`.
pub fn checkout_ref(repo: &Repository, refname: &str) -> Result<()> {
    if let Ok(remote_branch) = repo.find_branch(refname, BranchType::Remote) {
        let local_name = refname.split_once('/').map(|(_, n)| n).unwrap_or(refname).to_string();
        if repo.find_branch(&local_name, BranchType::Local).is_err() {
            let commit = remote_branch.get().peel_to_commit()?;
            let mut local = repo.branch(&local_name, &commit, false)?;
            let _ = local.set_upstream(Some(refname));
        }
        return checkout_object(repo, &local_name);
    }
    checkout_object(repo, refname)
}

/// Resolve `refname` (branch / tag / commit) and check it out, updating HEAD.
fn checkout_object(repo: &Repository, refname: &str) -> Result<()> {
    let (object, reference) = repo.revparse_ext(refname)?;

    let mut co = CheckoutBuilder::new();
    co.safe();
    repo.checkout_tree(&object, Some(&mut co))?;

    match reference {
        Some(r) => {
            let name = r.name().ok_or_else(|| Error::Msg("invalid ref name".into()))?;
            repo.set_head(name)?;
        }
        None => repo.set_head_detached(object.id())?,
    }
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub kind: MergeKind,
    pub conflicts: Vec<String>,
    pub oid: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Normal,
    Conflicts,
}

/// How to merge: allow fast-forward (default), require it (`FfOnly`), or always
/// create a merge commit (`NoFf`).
#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    Default,
    FfOnly,
    NoFf,
}

/// Merge `their_ref` into the current branch. On conflicts the working tree is
/// left in the conflicted state (resolve in an external tool for MVP) and the
/// conflicting paths are returned.
pub fn merge(repo: &Repository, their_ref: &str, mode: MergeMode) -> Result<MergeResult> {
    let their_commit = repo.revparse_single(their_ref)?.peel_to_commit()?;
    let annotated = repo.find_annotated_commit(their_commit.id())?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeResult { kind: MergeKind::UpToDate, conflicts: vec![], oid: None });
    }

    if mode == MergeMode::FfOnly && !analysis.is_fast_forward() {
        return Err(Error::Msg("not possible to fast-forward — merge aborted".into()));
    }

    if analysis.is_fast_forward() && mode != MergeMode::NoFf {
        let refname = {
            let head = repo.head()?;
            head.name().unwrap_or("HEAD").to_string()
        };
        let mut reference = repo.find_reference(&refname)?;
        reference.set_target(their_commit.id(), "fast-forward merge")?;
        repo.set_head(&refname)?;
        let mut co = CheckoutBuilder::new();
        co.force();
        repo.checkout_head(Some(&mut co))?;
        return Ok(MergeResult {
            kind: MergeKind::FastForward,
            conflicts: vec![],
            oid: Some(their_commit.id().to_string()),
        });
    }

    // Normal merge.
    let mut merge_opts = MergeOptions::new();
    let mut co = CheckoutBuilder::new();
    co.safe();
    repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut co))?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        let conflicts = conflict_paths(&index);
        return Ok(MergeResult { kind: MergeKind::Conflicts, conflicts, oid: None });
    }

    // No conflicts: create the merge commit.
    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let msg = format!("Merge {their_ref}");
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &[&head_commit, &their_commit])?;
    repo.cleanup_state()?;

    Ok(MergeResult { kind: MergeKind::Normal, conflicts: vec![], oid: Some(oid.to_string()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn create_and_delete_branch() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        create_branch(&t.repo, "topic", Some(&a.to_string()), false).unwrap();
        assert!(t.repo.find_branch("topic", BranchType::Local).is_ok());
        delete_branch(&t.repo, "topic", true).unwrap();
        assert!(t.repo.find_branch("topic", BranchType::Local).is_err());
    }

    #[test]
    fn delete_unmerged_branch_requires_force() {
        // main at `a`; topic at descendant `b` (not merged into main).
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        t.repo.branch("topic", &t.repo.find_commit(b).unwrap(), true).unwrap();

        assert!(delete_branch(&t.repo, "topic", false).is_err(), "unmerged delete must be refused");
        assert!(t.repo.find_branch("topic", BranchType::Local).is_ok());
        delete_branch(&t.repo, "topic", true).unwrap();
        assert!(t.repo.find_branch("topic", BranchType::Local).is_err());
    }

    #[test]
    fn checkout_remote_branch_creates_local_tracking() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        let mut co = CheckoutBuilder::new();
        co.force();
        t.repo.checkout_head(Some(&mut co)).unwrap();

        // Simulate a fetched remote-tracking branch with no local counterpart.
        t.repo.remote("origin", "https://example.com/repo.git").unwrap();
        t.repo.reference("refs/remotes/origin/feat", a, true, "test").unwrap();

        checkout_ref(&t.repo, "origin/feat").unwrap();

        let feat = t.repo.find_branch("feat", BranchType::Local).unwrap();
        assert!(feat.is_head(), "new local branch should be checked out");
        let upstream = feat.upstream().unwrap();
        assert_eq!(upstream.name().unwrap().unwrap(), "origin/feat");
    }

    #[test]
    fn fast_forward_merge() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        // main at `a`, topic at `b` (descendant) => merging topic fast-forwards.
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        t.repo.branch("topic", &t.repo.find_commit(b).unwrap(), true).unwrap();

        let res = merge(&t.repo, "topic", MergeMode::Default).unwrap();
        assert_eq!(res.kind, MergeKind::FastForward);
    }
}
