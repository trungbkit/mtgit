//! History-editing operations: cherry-pick, reset, rebase.

use crate::error::{Error, Result};
use git2::{CherrypickOptions, Index, Oid, RebaseOptions, Repository, ResetType};
use serde::{Deserialize, Serialize};

/// Result of an operation that may leave the index in a conflicted state.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResult {
    pub conflicts: Vec<String>,
    /// New commit oid on success, None when conflicted.
    pub oid: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

pub fn conflict_paths(index: &Index) -> Vec<String> {
    match index.conflicts() {
        Ok(conflicts) => conflicts
            .flatten()
            .filter_map(|c| {
                c.our
                    .or(c.their)
                    .or(c.ancestor)
                    .and_then(|e| String::from_utf8(e.path).ok())
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Apply `oid` on top of HEAD, preserving the original author. On conflict the
/// working tree is left in the cherry-pick state for external resolution.
pub fn cherry_pick(repo: &Repository, oid: &str) -> Result<ConflictResult> {
    let commit = repo.find_commit(parse_oid(oid)?)?;
    let mut opts = CherrypickOptions::new();
    repo.cherrypick(&commit, Some(&mut opts))?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Ok(ConflictResult { conflicts: conflict_paths(&index), oid: None });
    }

    let committer = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let head = repo.head()?.peel_to_commit()?;
    let message = commit.message().unwrap_or("");
    let new_oid = repo.commit(Some("HEAD"), &commit.author(), &committer, message, &tree, &[&head])?;
    repo.cleanup_state()?;

    Ok(ConflictResult { conflicts: vec![], oid: Some(new_oid.to_string()) })
}

/// Move the current branch to `oid`. Soft keeps index+worktree, mixed resets
/// the index, hard discards working-tree changes too.
pub fn reset(repo: &Repository, oid: &str, mode: ResetMode) -> Result<()> {
    let object = repo.find_object(parse_oid(oid)?, None)?;
    let kind = match mode {
        ResetMode::Soft => ResetType::Soft,
        ResetMode::Mixed => ResetType::Mixed,
        ResetMode::Hard => ResetType::Hard,
    };
    repo.reset(&object, kind, None)?;
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    /// Number of commits successfully replayed.
    pub applied: usize,
    pub conflicts: Vec<String>,
    pub done: bool,
}

/// Rebase the current branch onto `onto` (a ref or oid). Replays each commit;
/// on the first conflict it aborts (restoring the pre-rebase state) and reports
/// the conflicting files.
pub fn rebase(repo: &Repository, onto: &str) -> Result<RebaseResult> {
    let onto_commit = repo.revparse_single(onto)?.peel_to_commit()?;
    let onto_annotated = repo.find_annotated_commit(onto_commit.id())?;

    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;

    let mut opts = RebaseOptions::new();
    let mut rebase = repo.rebase(None, Some(&onto_annotated), None, Some(&mut opts))?;

    let mut applied = 0;
    while let Some(op) = rebase.next() {
        op?;
        let index = repo.index()?;
        if index.has_conflicts() {
            let conflicts = conflict_paths(&index);
            rebase.abort()?;
            return Ok(RebaseResult { applied, conflicts, done: false });
        }
        // Empty commits (already applied) can't be committed; skip those.
        match rebase.commit(None, &sig, None) {
            Ok(_) => applied += 1,
            Err(e) if e.code() == git2::ErrorCode::Applied => {}
            Err(e) => {
                rebase.abort()?;
                return Err(e.into());
            }
        }
    }
    rebase.finish(Some(&sig))?;
    Ok(RebaseResult { applied, conflicts: vec![], done: true })
}

fn parse_oid(oid: &str) -> Result<Oid> {
    Oid::from_str(oid).map_err(|_| Error::Msg(format!("bad oid: {oid}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;
    use git2::BranchType;

    fn configure(repo: &Repository) {
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@e.com").unwrap();
    }

    #[test]
    fn reset_soft_moves_branch_only() {
        let t = TestRepo::new();
        configure(&t.repo);
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.repo.branch("main", &t.repo.find_commit(b).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();

        reset(&t.repo, &a.to_string(), ResetMode::Soft).unwrap();
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id(), a);
    }

    #[test]
    fn cherry_pick_applies_commit_onto_head() {
        // main: base -> x ; side commit `pick` on base. Cherry-pick pick onto x.
        let t = TestRepo::new();
        configure(&t.repo);
        let base = t.commit("base", &[]);
        let x = t.commit("x on main", &[base]);
        // A commit on a side branch that touches a *different* file so it
        // applies cleanly on top of x.
        let side = {
            let blob = t.repo.blob(b"side content\n").unwrap();
            let mut tb = t.repo.treebuilder(Some(&t.repo.find_commit(base).unwrap().tree().unwrap())).unwrap();
            tb.insert("side.txt", blob, 0o100644).unwrap();
            let tree = t.repo.find_tree(tb.write().unwrap()).unwrap();
            let sig = git2::Signature::new("T", "t@e.com", &git2::Time::new(1_600_009_000, 0)).unwrap();
            let parent = t.repo.find_commit(base).unwrap();
            t.repo.commit(None, &sig, &sig, "pick me", &tree, &[&parent]).unwrap()
        };

        t.repo.branch("main", &t.repo.find_commit(x).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        t.repo.checkout_head(Some(&mut co)).unwrap();

        let res = cherry_pick(&t.repo, &side.to_string()).unwrap();
        assert!(res.conflicts.is_empty(), "conflicts: {:?}", res.conflicts);
        assert!(res.oid.is_some());
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary(), Some("pick me"));
        assert_eq!(head.parent(0).unwrap().id(), x);
        // main branch advanced.
        assert!(t.repo.find_branch("main", BranchType::Local).is_ok());
    }
}
