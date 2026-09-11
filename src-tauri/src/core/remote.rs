//! Remote management (G4).
//!
//! Reads and writes live in git2 — these are config edits, not network calls,
//! so the "network ops shell out" rule (`CLAUDE.md` invariant 6) does not
//! apply. Only `fetch`/`pull`/`push` need the user's credential helpers.

use crate::error::{Error, Result};
use git2::Repository;
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// Fetch URL. `None` for a remote configured without one (rare but legal).
    pub url: Option<String>,
    /// `remote.<name>.pushurl`, when it differs from `url`.
    pub push_url: Option<String>,
    /// Number of remote-tracking branches under `refs/remotes/<name>/`.
    pub branches: usize,
}

/// Reject a name git itself would reject, *before* writing it to config.
///
/// `Remote::is_valid_name` is git's own check, but it accepts the empty string
/// on some libgit2 builds and says nothing about why a name failed, so the
/// message is ours.
fn check_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::Msg("remote name cannot be empty".into()));
    }
    if !git2::Remote::is_valid_name(name) {
        return Err(Error::Msg(format!("'{name}' is not a valid remote name")));
    }
    Ok(())
}

/// A URL is not validated for reachability here — that is `git clone`'s job —
/// but a leading `-` must never reach a command line as a bare word.
pub fn check_url(url: &str) -> Result<()> {
    let url = url.trim();
    if url.is_empty() {
        return Err(Error::Msg("remote URL cannot be empty".into()));
    }
    if url.starts_with('-') {
        return Err(Error::Msg("remote URL cannot start with '-'".into()));
    }
    Ok(())
}

pub fn list(repo: &Repository) -> Result<Vec<RemoteInfo>> {
    let names = repo.remotes()?;
    let mut out = Vec::new();
    for name in names.iter().flatten() {
        let remote = match repo.find_remote(name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let url = remote.url().map(str::to_string);
        let push_url = remote.pushurl().map(str::to_string).filter(|p| Some(p) != url.as_ref());
        out.push(RemoteInfo {
            name: name.to_string(),
            url,
            push_url,
            branches: count_branches(repo, name),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn count_branches(repo: &Repository, remote: &str) -> usize {
    let prefix = format!("refs/remotes/{remote}/");
    repo.references()
        .map(|refs| {
            refs.flatten()
                .filter(|r| r.name().is_some_and(|n| n.starts_with(&prefix)))
                .count()
        })
        .unwrap_or(0)
}

pub fn add(repo: &Repository, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_url(url)?;
    if repo.find_remote(name).is_ok() {
        return Err(Error::Msg(format!("remote '{name}' already exists")));
    }
    repo.remote(name, url.trim())?;
    Ok(())
}

pub fn remove(repo: &Repository, name: &str) -> Result<()> {
    check_name(name)?;
    repo.remote_delete(name)?;
    Ok(())
}

/// Rename a remote. git2 reports refspecs it could not rewrite rather than
/// failing; a caller that ignores them leaves the user with a remote whose
/// fetch refspec still names the old remote, so they are surfaced.
pub fn rename(repo: &Repository, old: &str, new: &str) -> Result<Vec<String>> {
    check_name(old)?;
    check_name(new)?;
    if old == new {
        return Ok(Vec::new());
    }
    if repo.find_remote(new).is_ok() {
        return Err(Error::Msg(format!("remote '{new}' already exists")));
    }
    let problems = repo.remote_rename(old, new)?;
    Ok(problems.iter().flatten().map(str::to_string).collect())
}

pub fn set_url(repo: &Repository, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_url(url)?;
    repo.remote_set_url(name, url.trim())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn list_reports_urls_and_tracking_branch_counts() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        add(&t.repo, "origin", "https://example.com/a.git").unwrap();
        add(&t.repo, "fork", "git@example.com:b.git").unwrap();
        let commit = t.repo.find_commit(a).unwrap();
        t.repo.reference("refs/remotes/origin/main", a, true, "").unwrap();
        t.repo.reference("refs/remotes/origin/dev", commit.id(), true, "").unwrap();

        let remotes = list(&t.repo).unwrap();
        let names: Vec<_> = remotes.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["fork", "origin"], "sorted by name");
        let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
        assert_eq!(origin.url.as_deref(), Some("https://example.com/a.git"));
        assert_eq!(origin.branches, 2);
        assert_eq!(remotes.iter().find(|r| r.name == "fork").unwrap().branches, 0);
    }

    #[test]
    fn adding_a_duplicate_remote_is_refused_rather_than_silently_replacing_it() {
        let t = TestRepo::new();
        add(&t.repo, "origin", "https://example.com/a.git").unwrap();
        let err = add(&t.repo, "origin", "https://example.com/other.git").unwrap_err();
        assert!(err.to_string().contains("already exists"), "{err}");
        // The original URL must survive the refusal.
        assert_eq!(
            list(&t.repo).unwrap()[0].url.as_deref(),
            Some("https://example.com/a.git")
        );
    }

    #[test]
    fn rename_moves_the_remote_tracking_refs_with_it() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        add(&t.repo, "origin", "https://example.com/a.git").unwrap();
        t.repo.reference("refs/remotes/origin/main", a, true, "").unwrap();

        let problems = rename(&t.repo, "origin", "upstream").unwrap();
        assert!(problems.is_empty(), "default refspec rewrites cleanly: {problems:?}");
        assert!(t.repo.find_remote("origin").is_err());
        assert!(t.repo.find_reference("refs/remotes/upstream/main").is_ok());
        assert_eq!(list(&t.repo).unwrap()[0].branches, 1);
    }

    #[test]
    fn a_url_that_looks_like_an_option_is_rejected_before_it_reaches_config() {
        // The same class as the search guard: this value ends up on a `git`
        // command line, where a leading '-' is an option, not a URL.
        let t = TestRepo::new();
        assert!(add(&t.repo, "origin", "--upload-pack=evil").is_err());
        assert!(add(&t.repo, "origin", "  ").is_err());
        assert!(add(&t.repo, "", "https://example.com/a.git").is_err());
        assert!(list(&t.repo).unwrap().is_empty());
    }
}
