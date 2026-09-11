//! Linked worktrees: list, add, remove (G18).
//!
//! GitLens treats a worktree as the default answer to "look at another
//! branch", which only works if the UI can see them all — including the *main*
//! worktree, which `Repository::worktrees()` deliberately omits because it is
//! not a linked one. [`list`] puts it back at the head of the list, because
//! "which one am I in" is the question the section exists to answer.

use crate::error::{Error, Result};
use git2::{Oid, Repository, WorktreeAddOptions, WorktreeLockStatus, WorktreePruneOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    /// Branch checked out in the worktree, if resolvable.
    pub branch: Option<String>,
    /// Commit the worktree's HEAD points at, if resolvable.
    pub head_oid: Option<String>,
    pub locked: bool,
    /// The repository's own working directory, not a linked worktree. It has
    /// no `git worktree remove`, and it is where `path` equals the repo handle.
    pub is_main: bool,
    /// True for the worktree the open tab is looking at.
    pub is_current: bool,
    /// Changed files in that worktree (staged + unstaged + conflicted), or
    /// `None` when it could not be opened — a worktree on an unmounted disk
    /// must render as "unknown", not as "clean".
    pub changed: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: String,
    pub url: Option<String>,
    pub oid: Option<String>,
}

/// Count the working-tree changes in `repo`, the way the WIP row counts them.
fn changed_files(repo: &Repository) -> Option<usize> {
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true).renames_head_to_index(true);
    Some(
        repo.statuses(Some(&mut opts))
            .ok()?
            .iter()
            .filter(|entry| !entry.status().is_ignored())
            .count(),
    )
}

fn describe(repo: &Repository, name: &str, path: String, locked: bool, is_main: bool) -> WorktreeInfo {
    let head = repo.head().ok();
    WorktreeInfo {
        name: name.to_string(),
        branch: head
            .as_ref()
            .filter(|h| h.is_branch())
            .and_then(|h| h.shorthand().map(str::to_string)),
        head_oid: head.and_then(|h| h.target()).map(|o| o.to_string()),
        locked,
        is_main,
        // Filled in by `list`, which is the only caller that knows which
        // worktree the open tab is.
        is_current: false,
        changed: changed_files(repo),
        path,
    }
}

/// Every worktree of this repository, main first, then linked ones by name.
///
/// `repo` may itself *be* a linked worktree — that is what opening a worktree
/// as a tab does — so "current" is decided by comparing working directories,
/// not by assuming the handle is the main one.
pub fn list(repo: &Repository) -> Result<Vec<WorktreeInfo>> {
    let here = repo.workdir().map(Path::to_path_buf);
    let mut out = Vec::new();

    // The main worktree. `commondir` is the shared `.git`; its parent is the
    // main working directory, which is the one `worktrees()` never lists.
    if let Some(main_dir) = repo.commondir().parent().map(Path::to_path_buf) {
        let main = if Some(&main_dir) == here.as_ref() {
            None
        } else {
            Repository::open(&main_dir).ok()
        };
        let main_repo = main.as_ref().unwrap_or(repo);
        let name = main_dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "main".to_string());
        out.push(describe(
            main_repo,
            &name,
            main_dir.to_string_lossy().into_owned(),
            false,
            true,
        ));
    }

    for name in repo.worktrees()?.iter().flatten() {
        let Ok(wt) = repo.find_worktree(name) else { continue };
        let locked = matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_)));
        let path = wt.path().to_string_lossy().into_owned();
        match Repository::open_from_worktree(&wt) {
            Ok(wt_repo) => out.push(describe(&wt_repo, name, path, locked, false)),
            // A worktree whose directory is gone still has an admin entry. It
            // must still be listed — it is the one the user needs to prune.
            Err(_) => out.push(WorktreeInfo {
                name: name.to_string(),
                path,
                branch: None,
                head_oid: None,
                locked,
                is_main: false,
                is_current: false,
                changed: None,
            }),
        }
    }

    out.sort_by(|a, b| b.is_main.cmp(&a.is_main).then(a.name.cmp(&b.name)));
    if let Some(here) = here {
        for wt in &mut out {
            wt.is_current = Path::new(&wt.path) == here;
        }
    }
    Ok(out)
}

pub fn list_submodules(repo: &Repository) -> Result<Vec<SubmoduleInfo>> {
    Ok(repo
        .submodules()?
        .into_iter()
        .map(|submodule| SubmoduleInfo {
            name: submodule.name().unwrap_or("submodule").to_string(),
            path: submodule.path().to_string_lossy().to_string(),
            url: submodule.url().map(str::to_string),
            oid: submodule.head_id().map(|oid| oid.to_string()),
        })
        .collect())
}

/// Add a linked worktree at `path`, checking out `target`.
///
/// `target` is whatever the caller had to hand, resolved in the order the UI
/// offers it:
///
/// - an **existing local branch** — attached as-is, so "Open `main` in a
///   worktree" gives you `main`, not a copy of it called something else;
/// - a **remote-tracking branch** — a local branch of the same short name is
///   created at its tip and set to track it, which is what `git worktree add`
///   does and what checkout already does for a remote branch;
/// - anything else (an **oid**) — a new branch named `name` is created there.
///
/// `None` checks out a new branch named `name` at HEAD, git2's own default.
pub fn add(
    repo: &Repository,
    name: &str,
    path: &str,
    target: Option<&str>,
    detach: bool,
) -> Result<()> {
    let mut opts = WorktreeAddOptions::new();
    let Some(target) = target else {
        repo.worktree(name, Path::new(path), Some(&opts))?;
        return Ok(());
    };

    // `git worktree add --detach <path> <commit>` (`02-checkout.md` B8).
    //
    // git2's `WorktreeAddOptions` has no detach mode and insists on a
    // reference, which is why this used to leave a branch named after the
    // worktree folder — a branch the user never asked for, which then blocks
    // the name and shows up in every branch list. The way out is to create it
    // *through* a scratch reference and then move the worktree's own HEAD off
    // it, which is precisely what git does internally.
    if detach {
        let commit = repo
            .revparse_single(target)
            .map_err(|_| Error::Msg(format!("bad target: {target}")))?
            .peel_to_commit()?;
        let scratch_name = format!("mtgit-worktree-{name}");
        let scratch = repo.branch(&scratch_name, &commit, true)?;
        let oid = commit.id();
        opts.reference(Some(scratch.get()));
        let wt = repo.worktree(name, Path::new(path), Some(&opts))?;

        // Detach first, delete second: deleting the branch while the worktree
        // still points at it leaves the worktree with a broken HEAD.
        let wt_repo = Repository::open_from_worktree(&wt)?;
        wt_repo.set_head_detached(oid)?;
        drop(wt_repo);
        repo.find_branch(&scratch_name, git2::BranchType::Local)?.delete()?;
        return Ok(());
    }

    let reference = if let Ok(branch) = repo.find_branch(target, git2::BranchType::Local) {
        branch.into_reference()
    } else if let Ok(remote) = repo.find_branch(target, git2::BranchType::Remote) {
        let short = target.split_once('/').map(|(_, rest)| rest).unwrap_or(target);
        let commit = remote.get().peel_to_commit()?;
        let mut local = match repo.find_branch(short, git2::BranchType::Local) {
            Ok(existing) => existing,
            Err(_) => repo.branch(short, &commit, false)?,
        };
        local.set_upstream(Some(target))?;
        local.into_reference()
    } else {
        let oid = Oid::from_str(target).map_err(|_| Error::Msg(format!("bad target: {target}")))?;
        let commit = repo.find_commit(oid)?;
        repo.branch(name, &commit, false)?.into_reference()
    };

    opts.reference(Some(&reference));
    repo.worktree(name, Path::new(path), Some(&opts))?;
    Ok(())
}

/// The worktree that already has `branch` checked out, if any.
///
/// `02-checkout.md` §7: git refuses a checkout of a branch another worktree
/// holds, with a message naming a path and nothing else. Knowing *which*
/// worktree it is turns that refusal into a choice — switch to it, or take a
/// new worktree of your own.
pub fn holder_of(repo: &Repository, branch: &str) -> Result<Option<WorktreeInfo>> {
    Ok(list(repo)?
        .into_iter()
        .find(|wt| !wt.is_current && wt.branch.as_deref() == Some(branch)))
}

/// Remove a linked worktree: delete its working directory, then prune the
/// admin entry.
///
/// Order matters. Pruning first orphans the directory — git no longer knows
/// about it, so nothing will ever clean it up and re-adding at the same path
/// fails on "already exists". Deleting first means a failed prune leaves an
/// entry `git worktree prune` will clear, which is the recoverable half.
///
/// `force` is required for a worktree with uncommitted changes, exactly as
/// `git worktree remove` requires it — the check is ours because
/// `Worktree::prune` does not look at the working tree at all.
pub fn remove(repo: &Repository, name: &str, force: bool) -> Result<()> {
    let wt = repo
        .find_worktree(name)
        .map_err(|_| Error::Msg(format!("no worktree named '{name}'")))?;

    if matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_))) && !force {
        return Err(Error::Msg(format!("worktree '{name}' is locked")));
    }
    if !force {
        if let Ok(wt_repo) = Repository::open_from_worktree(&wt) {
            if changed_files(&wt_repo).unwrap_or(0) > 0 {
                return Err(Error::Msg(format!(
                    "worktree '{name}' has uncommitted changes"
                )));
            }
        }
    }

    let dir = wt.path().to_path_buf();
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }

    let mut opts = WorktreePruneOptions::new();
    opts.valid(true).locked(force).working_tree(true);
    wt.prune(Some(&mut opts))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;
    use tempfile::TempDir;

    /// A fixture with one commit on `main`, HEAD attached, plus a scratch
    /// directory to put worktrees in.
    ///
    /// The scratch directory is its own `TempDir`, not a fixed name under the
    /// system temp root. A worktree cannot live inside the repository's own
    /// working directory, which is why the first version of these tests
    /// reached for `t.dir.parent()` — but that is shared, so two `cargo test`
    /// binaries running at once collided on it and one failed with "already
    /// exists". A `TempDir` is unique per run and cleans itself up.
    fn fixture() -> (TestRepo, Oid, TempDir) {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        (t, a, tempfile::tempdir().unwrap())
    }

    #[test]
    fn list_includes_the_main_worktree_and_marks_the_current_one() {
        let (t, a, scratch) = fixture();
        let wt_dir = scratch.path().join("wt-list-main");
        add(&t.repo, "wt-list-main", wt_dir.to_str().unwrap(), Some(&a.to_string()), false).unwrap();

        let list = list(&t.repo).unwrap();
        assert_eq!(list.len(), 2, "main + one linked: {list:?}");
        assert!(list[0].is_main, "the main worktree sorts first");
        assert!(list[0].is_current, "the handle points at the main worktree");
        assert!(!list[1].is_main);
        assert!(!list[1].is_current);
        assert_eq!(list[1].branch.as_deref(), Some("wt-list-main"));
        assert_eq!(list[1].head_oid.as_deref(), Some(a.to_string().as_str()));
    }

    /// Opening a worktree as its own tab is the whole point of G18, so `list`
    /// has to answer "which one am I in" from a worktree handle too — not just
    /// from the main repository.
    #[test]
    fn current_is_decided_by_working_directory_not_by_the_handle() {
        let (t, a, scratch) = fixture();
        let wt_dir = scratch.path().join("wt-from-inside");
        add(&t.repo, "wt-from-inside", wt_dir.to_str().unwrap(), Some(&a.to_string()), false).unwrap();

        let from_worktree = Repository::discover(&wt_dir).unwrap();
        let list = list(&from_worktree).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main && !list[0].is_current, "main is listed but not current");
        assert!(list[1].is_current, "the linked worktree we opened is current");
    }

    /// "Open `main` in a worktree" must give you `main`. Passing a branch
    /// name used to fall into the oid branch and fail on `bad oid`, and the
    /// near-miss — creating a *copy* under the worktree's name — would be
    /// worse than failing.
    #[test]
    fn add_attaches_an_existing_local_branch_rather_than_copying_it() {
        let (t, a, scratch) = fixture();
        t.repo.branch("topic", &t.repo.find_commit(a).unwrap(), true).unwrap();
        let wt_dir = scratch.path().join("wt-attach-local");

        add(&t.repo, "wt-attach-local", wt_dir.to_str().unwrap(), Some("topic"), false).unwrap();

        let listed = list(&t.repo).unwrap();
        let linked = listed.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(linked.branch.as_deref(), Some("topic"), "the branch itself, not a copy");
        assert!(
            t.repo.find_branch("wt-attach-local", git2::BranchType::Local).is_err(),
            "no branch named after the worktree should have been invented"
        );
    }

    /// A remote branch gets a local one of the same short name, tracking it —
    /// the same rule checkout already applies.
    #[test]
    fn add_on_a_remote_branch_creates_a_tracking_local_branch() {
        let (t, a, scratch) = fixture();
        t.repo.remote("origin", "https://example.com/r.git").unwrap();
        t.repo.reference("refs/remotes/origin/feature", a, true, "").unwrap();
        let wt_dir = scratch.path().join("wt-attach-remote");

        add(&t.repo, "wt-attach-remote", wt_dir.to_str().unwrap(), Some("origin/feature"), false).unwrap();

        let local = t.repo.find_branch("feature", git2::BranchType::Local).unwrap();
        assert_eq!(local.upstream().unwrap().name().unwrap(), Some("origin/feature"));
        let listed = list(&t.repo).unwrap();
        assert_eq!(
            listed.iter().find(|w| !w.is_main).unwrap().branch.as_deref(),
            Some("feature")
        );
    }

    #[test]
    fn remove_deletes_the_directory_and_the_admin_entry() {
        let (t, a, scratch) = fixture();
        let wt_dir = scratch.path().join("wt-remove-ok");
        add(&t.repo, "wt-remove-ok", wt_dir.to_str().unwrap(), Some(&a.to_string()), false).unwrap();

        remove(&t.repo, "wt-remove-ok", false).unwrap();
        assert!(!wt_dir.exists(), "the working directory must be gone");
        assert!(t.repo.find_worktree("wt-remove-ok").is_err(), "and the admin entry with it");
        assert_eq!(list(&t.repo).unwrap().len(), 1, "only the main worktree is left");
    }

    /// `Worktree::prune` does not look at the working tree, so without our own
    /// check an unforced remove would silently delete uncommitted work.
    #[test]
    fn remove_refuses_a_dirty_worktree_unless_forced() {
        let (t, a, scratch) = fixture();
        let wt_dir = scratch.path().join("wt-remove-dirty");
        add(&t.repo, "wt-remove-dirty", wt_dir.to_str().unwrap(), Some(&a.to_string()), false).unwrap();
        std::fs::write(wt_dir.join("scratch.txt"), "unsaved\n").unwrap();

        let err = remove(&t.repo, "wt-remove-dirty", false).unwrap_err();
        assert!(err.to_string().contains("uncommitted"), "{err}");
        assert!(wt_dir.exists(), "a refused remove must not have deleted anything");

        remove(&t.repo, "wt-remove-dirty", true).unwrap();
        assert!(!wt_dir.exists());
    }

    /// `02-checkout.md` B8: a worktree made from a bare commit gets a
    /// detached HEAD, not a branch named after the folder. The stray branch
    /// was the visible symptom — it occupied the name and showed up in every
    /// branch list — but the real cost was that "a worktree at this commit"
    /// silently became "a new branch", which is a different request.
    #[test]
    fn a_worktree_from_a_bare_commit_is_detached_and_leaves_no_branch() {
        let (t, a, scratch) = fixture();
        let wt_dir = scratch.path().join("wt-detached");
        add(&t.repo, "wt-detached", wt_dir.to_str().unwrap(), Some(&a.to_string()), true).unwrap();

        let wt = t.repo.find_worktree("wt-detached").unwrap();
        let wt_repo = Repository::open_from_worktree(&wt).unwrap();
        assert!(wt_repo.head_detached().unwrap(), "HEAD is detached in the worktree");
        assert_eq!(wt_repo.head().unwrap().target(), Some(a));

        let names: Vec<String> = t
            .repo
            .branches(Some(git2::BranchType::Local))
            .unwrap()
            .flatten()
            .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
            .collect();
        assert!(!names.iter().any(|n| n == "wt-detached"), "no branch named after the folder");
        assert!(
            !names.iter().any(|n| n.starts_with("mtgit-worktree-")),
            "the scratch reference is cleaned up: {names:?}",
        );

        // And it still lists, with no branch to report.
        let entry = list(&t.repo).unwrap().into_iter().find(|w| w.name == "wt-detached").unwrap();
        assert_eq!(entry.branch, None);
        assert_eq!(entry.head_oid.as_deref(), Some(a.to_string().as_str()));
    }

    /// The refusal git gives is a path and nothing else; naming the worktree
    /// is what lets the UI offer to switch to it (`02-checkout.md` §7).
    #[test]
    fn holder_of_names_the_worktree_that_already_has_the_branch() {
        let (t, a, scratch) = fixture();
        t.repo.branch("topic", &t.repo.find_commit(a).unwrap(), true).unwrap();
        assert!(holder_of(&t.repo, "topic").unwrap().is_none(), "nothing holds it yet");

        let wt_dir = scratch.path().join("wt-holder");
        add(&t.repo, "wt-holder", wt_dir.to_str().unwrap(), Some("topic"), false).unwrap();

        let holder = holder_of(&t.repo, "topic").unwrap().expect("the worktree holds it");
        assert_eq!(holder.name, "wt-holder");
        assert!(!holder.is_current);
        // The worktree you are *in* is not a blocker for you.
        assert!(holder_of(&t.repo, "main").unwrap().is_none());
    }

    #[test]
    fn add_and_list_worktree() {
        let (t, a, scratch) = fixture();
        let wt_dir = scratch.path().join("wt1");
        add(&t.repo, "wt1", wt_dir.to_str().unwrap(), Some(&a.to_string()), false).unwrap();

        let list = list(&t.repo).unwrap();
        assert!(list.iter().any(|w| w.name == "wt1"));
    }
}
