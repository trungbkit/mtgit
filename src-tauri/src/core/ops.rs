//! History-editing operations: cherry-pick, reset, rebase.

use crate::error::{Error, Result};
use git2::{CherrypickOptions, DiffFormat, Index, Oid, RebaseOptions, Repository, ResetType};
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

/// Abort a pending merge / cherry-pick / revert: discard the half-applied
/// changes by hard-resetting to HEAD and clearing MERGE_HEAD/CHERRY_PICK_HEAD/
/// REVERT_HEAD state. This is the git2 equivalent of `git merge --abort`.
pub fn abort_pending(repo: &Repository) -> Result<()> {
    let head = repo.head()?.peel_to_commit()?;
    repo.reset(head.as_object(), ResetType::Hard, None)?;
    repo.cleanup_state()?;
    Ok(())
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

/// Drive a `git2::Rebase` from its current position to completion, committing
/// each operation with `sig`. On the first conflict it stops and leaves the
/// rebase in progress on disk (so it can be resumed via [`rebase_continue`] or
/// discarded via [`rebase_abort`]), reporting the conflicting files.
fn drive_rebase(
    repo: &Repository,
    rebase: &mut git2::Rebase<'_>,
    sig: &git2::Signature<'_>,
    mut applied: usize,
) -> Result<RebaseResult> {
    while let Some(op) = rebase.next() {
        op?;
        let index = repo.index()?;
        if index.has_conflicts() {
            // Leave the rebase in progress for external/in-app resolution.
            return Ok(RebaseResult { applied, conflicts: conflict_paths(&index), done: false });
        }
        // Empty commits (already applied) can't be committed; skip those.
        match rebase.commit(None, sig, None) {
            Ok(_) => applied += 1,
            Err(e) if e.code() == git2::ErrorCode::Applied => {}
            Err(e) => return Err(e.into()),
        }
    }
    rebase.finish(Some(sig))?;
    Ok(RebaseResult { applied, conflicts: vec![], done: true })
}

/// Rebase the current branch onto `onto` (a ref or oid). Replays each commit;
/// on the first conflict it stops with the rebase left in progress so the user
/// can resolve and continue (or abort). Reports the conflicting files.
pub fn rebase(repo: &Repository, onto: &str) -> Result<RebaseResult> {
    let onto_commit = repo.revparse_single(onto)?.peel_to_commit()?;
    let onto_annotated = repo.find_annotated_commit(onto_commit.id())?;

    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;

    let mut opts = RebaseOptions::new();
    let mut rebase = repo.rebase(None, Some(&onto_annotated), None, Some(&mut opts))?;
    drive_rebase(repo, &mut rebase, &sig, 0)
}

/// Resume a rebase left in progress after the user has resolved and staged the
/// conflicting files. Commits the currently-stopped operation, then continues.
pub fn rebase_continue(repo: &Repository) -> Result<RebaseResult> {
    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;
    let mut rebase = repo.open_rebase(None)?;

    // The resolved files must be staged; refuse if conflicts remain.
    let index = repo.index()?;
    if index.has_conflicts() {
        return Ok(RebaseResult { applied: 0, conflicts: conflict_paths(&index), done: false });
    }

    // Commit the operation that previously conflicted (now resolved).
    match rebase.commit(None, &sig, None) {
        Ok(_) => {}
        Err(e) if e.code() == git2::ErrorCode::Applied => {}
        Err(e) => return Err(e.into()),
    }
    drive_rebase(repo, &mut rebase, &sig, 1)
}

/// Discard a rebase left in progress, restoring the pre-rebase state.
pub fn rebase_abort(repo: &Repository) -> Result<()> {
    let mut rebase = repo.open_rebase(None)?;
    rebase.abort()?;
    Ok(())
}

/// Revert `oid` on top of HEAD, creating a new commit that undoes its changes.
/// On conflict the working tree is left in the revert state for external
/// resolution.
pub fn revert(repo: &Repository, oid: &str) -> Result<ConflictResult> {
    let commit = repo.find_commit(parse_oid(oid)?)?;
    let mut opts = git2::RevertOptions::new();
    repo.revert(&commit, Some(&mut opts))?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Ok(ConflictResult { conflicts: conflict_paths(&index), oid: None });
    }

    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let head = repo.head()?.peel_to_commit()?;
    let summary = commit.summary().unwrap_or("commit");
    let message = format!("Revert \"{summary}\"\n\nThis reverts commit {}.", commit.id());
    let new_oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&head])?;
    repo.cleanup_state()?;

    Ok(ConflictResult { conflicts: vec![], oid: Some(new_oid.to_string()) })
}

/// Write a `git format-patch`-style patch for `oid` (vs its first parent) to
/// `out_path`.
pub fn format_patch(repo: &Repository, oid: &str, out_path: &str) -> Result<()> {
    let commit = repo.find_commit(parse_oid(oid)?)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)?;

    let author = commit.author();
    let summary = commit.summary().unwrap_or("");
    let mut buf = String::new();
    buf.push_str(&format!("From {} Mon Sep 17 00:00:00 2001\n", commit.id()));
    buf.push_str(&format!(
        "From: {} <{}>\n",
        author.name().unwrap_or(""),
        author.email().unwrap_or("")
    ));
    buf.push_str(&format!("Subject: [PATCH] {summary}\n\n"));

    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => buf.push(line.origin()),
            _ => {}
        }
        buf.push_str(&String::from_utf8_lossy(line.content()));
        true
    })?;

    std::fs::write(out_path, buf)?;
    Ok(())
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

    #[test]
    fn revert_creates_inverse_commit() {
        // base -> add-side (adds side.txt). Reverting add-side should remove it.
        let t = TestRepo::new();
        configure(&t.repo);
        let base = t.commit("base", &[]);
        let add_side = {
            let blob = t.repo.blob(b"side content\n").unwrap();
            let mut tb = t
                .repo
                .treebuilder(Some(&t.repo.find_commit(base).unwrap().tree().unwrap()))
                .unwrap();
            tb.insert("side.txt", blob, 0o100644).unwrap();
            let tree = t.repo.find_tree(tb.write().unwrap()).unwrap();
            let sig = git2::Signature::new("T", "t@e.com", &git2::Time::new(1_600_009_000, 0)).unwrap();
            let parent = t.repo.find_commit(base).unwrap();
            t.repo.commit(None, &sig, &sig, "add side", &tree, &[&parent]).unwrap()
        };
        t.repo.branch("main", &t.repo.find_commit(add_side).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        t.repo.checkout_head(Some(&mut co)).unwrap();

        let res = revert(&t.repo, &add_side.to_string()).unwrap();
        assert!(res.conflicts.is_empty(), "conflicts: {:?}", res.conflicts);
        assert!(res.oid.is_some());
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        // side.txt should be gone in the revert commit's tree.
        assert!(head.tree().unwrap().get_path(std::path::Path::new("side.txt")).is_err());
        assert!(head.summary().unwrap().starts_with("Revert"));
    }

    /// Commit `content` to `name`, inheriting the first parent's tree.
    fn commit_blob(repo: &Repository, parents: &[Oid], name: &str, content: &str, msg: &str, n: i64) -> Oid {
        let blob = repo.blob(content.as_bytes()).unwrap();
        let base_tree = parents.first().and_then(|p| repo.find_commit(*p).ok()).and_then(|c| c.tree().ok());
        let mut tb = repo.treebuilder(base_tree.as_ref()).unwrap();
        tb.insert(name, blob, 0o100644).unwrap();
        let tree = repo.find_tree(tb.write().unwrap()).unwrap();
        let sig = git2::Signature::new("T", "t@e.com", &git2::Time::new(1_600_000_000 + n * 60, 0)).unwrap();
        let pc: Vec<_> = parents.iter().map(|p| repo.find_commit(*p).unwrap()).collect();
        let pr: Vec<&git2::Commit> = pc.iter().collect();
        repo.commit(None, &sig, &sig, msg, &tree, &pr).unwrap()
    }

    /// base → main(f=main) and base → topic(f=topic); checkout topic. Rebasing
    /// topic onto main conflicts on f.txt.
    fn conflicting_rebase_setup(t: &TestRepo) -> (Oid, Oid) {
        configure(&t.repo);
        let base = commit_blob(&t.repo, &[], "f.txt", "base\n", "base", 1);
        let main = commit_blob(&t.repo, &[base], "f.txt", "main\n", "main change", 2);
        let topic = commit_blob(&t.repo, &[base], "f.txt", "topic\n", "topic change", 3);
        t.repo.branch("main", &t.repo.find_commit(main).unwrap(), true).unwrap();
        t.repo.branch("topic", &t.repo.find_commit(topic).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/topic").unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        t.repo.checkout_head(Some(&mut co)).unwrap();
        (main, topic)
    }

    #[test]
    fn rebase_stops_on_conflict_then_continues() {
        let t = TestRepo::new();
        let (main, _topic) = conflicting_rebase_setup(&t);

        let r = rebase(&t.repo, "main").unwrap();
        assert!(!r.done, "expected rebase to stop on conflict");
        assert!(r.conflicts.contains(&"f.txt".to_string()));

        // Resolve and stage.
        std::fs::write(t.repo.workdir().unwrap().join("f.txt"), "resolved\n").unwrap();
        let mut idx = t.repo.index().unwrap();
        idx.add_path(std::path::Path::new("f.txt")).unwrap();
        idx.write().unwrap();

        let r2 = rebase_continue(&t.repo).unwrap();
        assert!(r2.done, "continue should finish; conflicts: {:?}", r2.conflicts);
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent(0).unwrap().id(), main, "topic replayed onto main");
    }

    #[test]
    fn rebase_abort_restores_topic() {
        let t = TestRepo::new();
        let (_main, topic) = conflicting_rebase_setup(&t);

        let r = rebase(&t.repo, "main").unwrap();
        assert!(!r.done);
        rebase_abort(&t.repo).unwrap();

        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id(), topic, "HEAD restored to topic tip");
        assert!(!t.repo.index().unwrap().has_conflicts());
    }

    #[test]
    fn abort_pending_clears_cherry_pick_conflict() {
        // main: base → m(f=main), HEAD on main. side(f=side) from base.
        let t = TestRepo::new();
        configure(&t.repo);
        let base = commit_blob(&t.repo, &[], "f.txt", "base\n", "base", 1);
        let m = commit_blob(&t.repo, &[base], "f.txt", "main\n", "main change", 2);
        let side = commit_blob(&t.repo, &[base], "f.txt", "side\n", "side change", 3);
        t.repo.branch("main", &t.repo.find_commit(m).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        t.repo.checkout_head(Some(&mut co)).unwrap();

        let res = cherry_pick(&t.repo, &side.to_string()).unwrap();
        assert!(res.oid.is_none(), "cherry-pick should conflict");
        assert!(!res.conflicts.is_empty());
        assert!(t.repo.index().unwrap().has_conflicts());

        abort_pending(&t.repo).unwrap();
        assert!(!t.repo.index().unwrap().has_conflicts(), "conflicts cleared");
        let head = t.repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id(), m, "HEAD unchanged after abort");
    }
}
