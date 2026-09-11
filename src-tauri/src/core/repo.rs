use crate::error::{Error, Result};
use git2::Repository;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    /// Short branch name (e.g. "main"), or None when detached / unborn.
    pub branch: Option<String>,
    /// Full oid of HEAD, or None on an unborn branch (empty repo).
    pub oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Directory name of the working dir / repo root.
    pub name: String,
    /// Absolute path used as the handle for subsequent commands.
    pub path: String,
    pub head: HeadInfo,
    pub is_bare: bool,
    /// Admin name of the linked worktree this handle points at, or `None` for
    /// the repository's main working directory (G18). A user who forgets which
    /// worktree they are in commits to the wrong branch, so the toolbar says.
    pub worktree: Option<String>,
}

/// Open a repository at `path` (searching upward for a `.git`) and return a
/// summary. `path` becomes the handle the frontend passes to every other
/// command.
pub fn open(path: &str) -> Result<RepoInfo> {
    let repo = Repository::discover(path)
        .map_err(|_| Error::Msg(format!("no git repository found at '{path}'")))?;

    let workdir = repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo.path().to_path_buf());

    let name = workdir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repository".to_string());

    let head = head_info(&repo);

    // For a linked worktree `repo.path()` is `<main>/.git/worktrees/<name>/`,
    // and that last segment is the admin name `git worktree remove` wants —
    // which is not necessarily the directory name.
    let worktree = repo
        .is_worktree()
        .then(|| {
            repo.path()
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .flatten();

    Ok(RepoInfo {
        name,
        path: workdir.to_string_lossy().into_owned(),
        head,
        is_bare: repo.is_bare(),
        worktree,
    })
}

/// Create a repository at `path` and return the same summary [`open`] does.
///
/// Refuses a directory that is *already* a repository rather than re-running
/// `git init` over it: git itself treats that as a harmless reinitialise, but
/// in a GUI it reads as "create", and a user who picked the wrong folder
/// deserves to be told rather than handed the repo they already had.
pub fn init(path: &str, bare: bool) -> Result<RepoInfo> {
    let dir = Path::new(path);
    if dir.exists() && !dir.is_dir() {
        return Err(Error::Msg(format!("'{path}' is not a directory")));
    }
    if Repository::open(dir).is_ok() {
        return Err(Error::Msg(format!("'{path}' is already a git repository")));
    }
    std::fs::create_dir_all(dir)?;

    let mut opts = git2::RepositoryInitOptions::new();
    opts.bare(bare).no_reinit(true);
    Repository::init_opts(dir, &opts)?;

    // Re-open through the normal path so the result is byte-identical to what
    // the frontend gets from `open_repo` — including the canonical workdir,
    // which on macOS differs from the picked path (/var vs /private/var).
    open(path)
}

pub fn head_info(repo: &Repository) -> HeadInfo {
    match repo.head() {
        Ok(reference) => {
            let detached = repo.head_detached().unwrap_or(false);
            let branch = if detached {
                None
            } else {
                reference.shorthand().map(str::to_string)
            };
            let oid = reference.target().map(|o| o.to_string());
            HeadInfo {
                branch,
                oid,
                detached,
                unborn: false,
            }
        }
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => HeadInfo {
            branch: reference_shorthand_from_unborn(repo),
            oid: None,
            detached: false,
            unborn: true,
        },
        Err(_) => HeadInfo {
            branch: None,
            oid: None,
            detached: false,
            unborn: true,
        },
    }
}

/// On an unborn branch `repo.head()` fails, but the symbolic ref still names
/// the branch that a first commit will create (usually "main"/"master").
fn reference_shorthand_from_unborn(repo: &Repository) -> Option<String> {
    let reference = repo.find_reference("HEAD").ok()?;
    let target = reference.symbolic_target()?;
    Some(target.strip_prefix("refs/heads/").unwrap_or(target).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_creates_a_repo_and_reports_its_unborn_head() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh");
        let info = init(path.to_str().unwrap(), false).unwrap();
        assert_eq!(info.name, "fresh");
        assert!(!info.is_bare);
        assert!(info.head.unborn, "a fresh repo has no commit yet");
        assert!(info.head.oid.is_none());
        // The symbolic HEAD still names the branch a first commit will create.
        assert!(info.head.branch.is_some());
    }

    #[test]
    fn init_refuses_a_directory_that_is_already_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        init(path, false).unwrap();
        let err = init(path, false).unwrap_err();
        assert!(err.to_string().contains("already a git repository"), "{err}");
    }

    #[test]
    fn open_reports_the_linked_worktree_it_was_pointed_at() {
        use crate::core::worktree;
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        init(main.to_str().unwrap(), false).unwrap();
        let repo = Repository::open(&main).unwrap();
        // One commit, so a worktree can be added.
        let tree = repo.find_tree(repo.treebuilder(None).unwrap().write().unwrap()).unwrap();
        let sig = git2::Signature::new("T", "t@e", &git2::Time::new(1_600_000_000, 0)).unwrap();
        let oid = repo.commit(Some("HEAD"), &sig, &sig, "first", &tree, &[]).unwrap();

        let wt_dir = dir.path().join("side");
        worktree::add(&repo, "side", wt_dir.to_str().unwrap(), Some(&oid.to_string())).unwrap();

        assert_eq!(open(main.to_str().unwrap()).unwrap().worktree, None);
        assert_eq!(open(wt_dir.to_str().unwrap()).unwrap().worktree.as_deref(), Some("side"));
    }

    #[test]
    fn init_bare_reports_itself_as_bare() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bare.git");
        let info = init(path.to_str().unwrap(), true).unwrap();
        assert!(info.is_bare);
    }
}
