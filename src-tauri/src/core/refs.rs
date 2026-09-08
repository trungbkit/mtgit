use crate::error::{Error, Result};
use git2::{BranchType, Oid, Repository};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    Head,
}

/// A ref pointing at a commit, rendered as a badge on the graph row.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefBadge {
    pub name: String,
    pub kind: RefKind,
    /// True for the ref that HEAD currently points at.
    pub is_head: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub oid: String,
    pub is_head: bool,
    /// e.g. "origin/main" for a local branch's upstream, else None.
    pub upstream: Option<String>,
    /// Commits ahead / behind the upstream (local branches with an upstream).
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<BranchInfo>,
}

/// Build a map from commit oid -> badges pointing at it, for the graph.
pub fn badges_by_oid(repo: &Repository) -> HashMap<Oid, Vec<RefBadge>> {
    let mut map: HashMap<Oid, Vec<RefBadge>> = HashMap::new();

    let head_oid = repo.head().ok().and_then(|h| h.target());
    let head_shorthand = repo.head().ok().and_then(|h| h.shorthand().map(str::to_string));

    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            // Peel to the commit the ref ultimately resolves to (annotated
            // tags resolve through their tag object).
            let target = match r.peel_to_commit() {
                Ok(c) => c.id(),
                Err(_) => continue,
            };

            let (kind, name) = if r.is_branch() {
                (RefKind::LocalBranch, r.shorthand().unwrap_or("").to_string())
            } else if r.is_remote() {
                (RefKind::RemoteBranch, r.shorthand().unwrap_or("").to_string())
            } else if r.is_tag() {
                (RefKind::Tag, r.shorthand().unwrap_or("").to_string())
            } else {
                continue;
            };

            if name.is_empty() {
                continue;
            }

            let is_head = kind == RefKind::LocalBranch
                && head_shorthand.as_deref() == Some(name.as_str());

            map.entry(target).or_default().push(RefBadge { name, kind, is_head });
        }
    }

    // Detached HEAD: add an explicit HEAD badge so the user can see where it is.
    if repo.head_detached().unwrap_or(false) {
        if let Some(oid) = head_oid {
            map.entry(oid).or_default().push(RefBadge {
                name: "HEAD".to_string(),
                kind: RefKind::Head,
                is_head: true,
            });
        }
    }

    map
}

/// List branches (local + remote) and tags for the sidebar.
pub fn list(repo: &Repository) -> Result<RefList> {
    let mut out = RefList::default();
    let head_shorthand = repo.head().ok().and_then(|h| h.shorthand().map(str::to_string));

    for (branch, bt) in repo.branches(None)?.flatten() {
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue,
        };
        let oid = match branch.get().peel_to_commit() {
            Ok(c) => c.id().to_string(),
            Err(_) => continue,
        };
        let upstream_branch = branch.upstream().ok();
        let upstream = upstream_branch
            .as_ref()
            .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));

        // Ahead/behind counts for local branches that track an upstream.
        let (mut ahead, mut behind) = (None, None);
        if bt == BranchType::Local {
            if let Some(up) = &upstream_branch {
                if let (Ok(local_oid), Ok(up_oid)) = (
                    branch.get().peel_to_commit().map(|c| c.id()),
                    up.get().peel_to_commit().map(|c| c.id()),
                ) {
                    if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        ahead = Some(a);
                        behind = Some(b);
                    }
                }
            }
        }

        let is_head = bt == BranchType::Local && head_shorthand.as_deref() == Some(name.as_str());
        let info = BranchInfo { name, oid, is_head, upstream, ahead, behind };
        match bt {
            BranchType::Local => out.local.push(info),
            BranchType::Remote => out.remote.push(info),
        }
    }

    repo.tag_foreach(|oid, name_bytes| {
        let full = String::from_utf8_lossy(name_bytes);
        let name = full.strip_prefix("refs/tags/").unwrap_or(&full).to_string();
        // Resolve to the pointed-at commit for consistency.
        let target = repo
            .find_object(oid, None)
            .and_then(|o| o.peel_to_commit())
            .map(|c| c.id())
            .unwrap_or(oid);
        out.tags.push(BranchInfo {
            name,
            oid: target.to_string(),
            is_head: false,
            upstream: None,
            ahead: None,
            behind: None,
        });
        true
    })?;

    out.local.sort_by(|a, b| a.name.cmp(&b.name));
    out.remote.sort_by(|a, b| a.name.cmp(&b.name));
    out.tags.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Create a tag at `target`. `message = None` makes a lightweight tag; `Some`
/// makes an annotated tag signed by the current git identity.
pub fn create_tag(repo: &Repository, name: &str, target: &str, message: Option<&str>) -> Result<()> {
    let oid = Oid::from_str(target).map_err(|_| Error::Msg(format!("bad oid: {target}")))?;
    let obj = repo.find_object(oid, None)?;
    match message {
        Some(msg) => {
            let sig = repo
                .signature()
                .map_err(|_| Error::Msg("no git identity configured".into()))?;
            repo.tag(name, &obj, &sig, msg, false)?;
        }
        None => {
            repo.tag_lightweight(name, &obj, false)?;
        }
    }
    Ok(())
}

pub fn delete_tag(repo: &Repository, name: &str) -> Result<()> {
    repo.tag_delete(name)?;
    Ok(())
}

/// Everything the push flow needs to decide whether it can just push.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PushTarget {
    /// Current branch shorthand; `None` on a detached or unborn HEAD.
    pub branch: Option<String>,
    /// Remote to push to, in GitKraken's order of preference: the branch's
    /// configured upstream remote, else `origin`, else the sole remote.
    /// `None` means there is nothing to push to.
    pub remote: Option<String>,
    /// Is an upstream *configured* for the current branch? This is the
    /// condition git tests before refusing with "has no upstream branch", so
    /// it is read from config rather than from the remote-tracking ref, which
    /// may not exist yet.
    pub has_upstream: bool,
}

/// Resolve the push target for the current branch (D5): a branch with no
/// upstream must be pushed with `--set-upstream <remote> <branch>`, and the
/// remote is not always called "origin".
pub fn push_target(repo: &Repository) -> Result<PushTarget> {
    let branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(str::to_string));
    let full = branch.as_ref().map(|b| format!("refs/heads/{b}"));

    let has_upstream = full
        .as_ref()
        .is_some_and(|r| repo.branch_upstream_name(r).is_ok());

    let upstream_remote = full.as_ref().and_then(|r| {
        repo.branch_upstream_remote(r)
            .ok()
            .and_then(|buf| buf.as_str().map(str::to_string))
            .filter(|s| !s.is_empty())
    });

    let remote = match upstream_remote {
        Some(r) => Some(r),
        None => {
            let remotes = repo.remotes()?;
            let names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
            if names.iter().any(|n| n == "origin") {
                Some("origin".to_string())
            } else if names.len() == 1 {
                Some(names[0].clone())
            } else {
                None
            }
        }
    };

    Ok(PushTarget { branch, remote, has_upstream })
}

/// URL of a named remote (e.g. "origin"), if it exists.
pub fn remote_url(repo: &Repository, name: &str) -> Option<String> {
    repo.find_remote(name).ok().and_then(|r| r.url().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn push_target_prefers_origin_then_a_sole_remote() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();

        let target = push_target(&t.repo).unwrap();
        assert_eq!(target.branch.as_deref(), Some("main"));
        assert_eq!(target.remote, None, "no remotes -> nothing to push to");
        assert!(!target.has_upstream);

        t.repo.remote("upstream", "https://example.com/u.git").unwrap();
        assert_eq!(
            push_target(&t.repo).unwrap().remote.as_deref(),
            Some("upstream"),
            "a single remote is the target even when not named origin",
        );

        t.repo.remote("origin", "https://example.com/o.git").unwrap();
        assert_eq!(push_target(&t.repo).unwrap().remote.as_deref(), Some("origin"));
    }

    #[test]
    fn push_target_reports_a_configured_upstream() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        t.repo.remote("origin", "https://example.com/o.git").unwrap();
        t.repo.remote("fork", "https://example.com/f.git").unwrap();

        // Configure the upstream the way `git push -u fork main` would.
        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("branch.main.remote", "fork").unwrap();
        cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();

        let target = push_target(&t.repo).unwrap();
        assert!(target.has_upstream, "config alone establishes the upstream");
        assert_eq!(target.remote.as_deref(), Some("fork"), "upstream remote wins over origin");
    }

    #[test]
    fn push_target_on_detached_head_has_no_branch() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.set_head_detached(a).unwrap();

        let target = push_target(&t.repo).unwrap();
        assert_eq!(target.branch, None);
        assert!(!target.has_upstream);
    }

    #[test]
    fn create_and_delete_lightweight_tag() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        create_tag(&t.repo, "v1", &a.to_string(), None).unwrap();
        let refs = list(&t.repo).unwrap();
        assert!(refs.tags.iter().any(|tag| tag.name == "v1"));

        delete_tag(&t.repo, "v1").unwrap();
        let refs = list(&t.repo).unwrap();
        assert!(!refs.tags.iter().any(|tag| tag.name == "v1"));
    }

    #[test]
    fn create_annotated_tag() {
        let t = TestRepo::new();
        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@e.com").unwrap();
        let a = t.commit("a", &[]);
        create_tag(&t.repo, "rel-1", &a.to_string(), Some("release one")).unwrap();
        let refs = list(&t.repo).unwrap();
        assert!(refs.tags.iter().any(|tag| tag.name == "rel-1"));
    }
}
