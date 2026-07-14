//! Creating commits from the staged index.

use crate::error::{Error, Result};
use git2::{Repository, Signature};

/// Commit the current index. When `amend` is set, replace HEAD (keeping its
/// parents) instead of adding a child. Returns the new commit oid.
pub fn commit(repo: &Repository, message: &str, amend: bool) -> Result<String> {
    if message.trim().is_empty() {
        return Err(Error::Msg("commit message is empty".into()));
    }

    let sig = signature(repo)?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    if amend {
        let head = repo
            .head()
            .map_err(|_| Error::Msg("nothing to amend: no HEAD commit".into()))?;
        let head_commit = head.peel_to_commit()?;
        let oid = head_commit.amend(Some("HEAD"), Some(&sig), Some(&sig), None, Some(message), Some(&tree))?;
        return Ok(oid.to_string());
    }

    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(h) => vec![h.peel_to_commit()?],
        Err(_) => Vec::new(), // unborn branch => root commit
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    Ok(oid.to_string())
}

/// The committer/author signature from git config, with a clear error when the
/// user hasn't configured `user.name` / `user.email`.
fn signature(repo: &Repository) -> Result<Signature<'static>> {
    repo.signature().map_err(|_| {
        Error::Msg(
            "no git identity configured — set user.name and user.email (git config)".into(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::status;

    fn write(repo: &git2::Repository, name: &str, content: &str) {
        let p = repo.workdir().unwrap().join(name);
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn stage_and_commit_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }

        write(&repo, "a.txt", "hello\n");
        let st = status::status(&repo).unwrap();
        assert!(st.is_dirty);
        assert_eq!(st.unstaged.len(), 1);

        status::stage_paths(&repo, &["a.txt".into()]).unwrap();
        let st = status::status(&repo).unwrap();
        assert_eq!(st.staged.len(), 1);
        assert_eq!(st.unstaged.len(), 0);

        let oid = commit(&repo, "initial", false).unwrap();
        assert_eq!(oid.len(), 40);
        let st = status::status(&repo).unwrap();
        assert!(!st.is_dirty);

        // HEAD now points at the new commit.
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id().to_string(), oid);
        assert_eq!(head.summary(), Some("initial"));
    }

    #[test]
    fn unstage_moves_back_to_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        write(&repo, "a.txt", "one\n");
        status::stage_paths(&repo, &["a.txt".into()]).unwrap();
        commit(&repo, "c1", false).unwrap();

        write(&repo, "a.txt", "two\n");
        status::stage_paths(&repo, &["a.txt".into()]).unwrap();
        assert_eq!(status::status(&repo).unwrap().staged.len(), 1);

        status::unstage_paths(&repo, &["a.txt".into()]).unwrap();
        let st = status::status(&repo).unwrap();
        assert_eq!(st.staged.len(), 0);
        assert_eq!(st.unstaged.len(), 1);
    }
}
