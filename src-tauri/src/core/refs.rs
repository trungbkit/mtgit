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
    /// An upstream is *configured* but its remote-tracking ref is gone —
    /// almost always a `fetch --prune` after the branch was merged and deleted
    /// on the remote (`04-pull.md` §5, STATUS C8). Distinct from "no upstream":
    /// this branch thinks it has one.
    pub upstream_gone: bool,
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

        // `branch.upstream()` fails when the tracking ref is missing, so the
        // configured name has to be read from config to tell "orphaned" apart
        // from "never had one".
        let configured_upstream = if bt == BranchType::Local {
            repo.branch_upstream_name(&format!("refs/heads/{name}"))
                .ok()
                .and_then(|buf| buf.as_str().map(|s| s.trim_start_matches("refs/remotes/").to_string()))
        } else {
            None
        };
        let upstream_gone = upstream.is_none() && configured_upstream.is_some();
        let upstream = upstream.or(configured_upstream);

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
        let info = BranchInfo { name, oid, is_head, upstream, ahead, behind, upstream_gone };
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
            upstream_gone: false,
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

/// Where a branch is heading (G23) — the branch it will eventually merge into.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeTarget {
    /// Shorthand of the target ref, e.g. `origin/main` or `develop`.
    #[serde(rename = "ref")]
    pub reference: String,
    pub oid: String,
    /// Commits on the branch that the target does not have.
    pub ahead: usize,
    /// Commits on the target that the branch does not have — what a merge or
    /// rebase would bring in, and the number that makes this worth showing.
    pub behind: usize,
    /// How the target was decided: `"config"`, `"remoteHead"` or
    /// `"conventional"`. Surfaced so a surprising answer is explainable
    /// rather than magic.
    pub source: String,
}

/// Branch names we will fall back to, in order, when nothing else says.
const CONVENTIONAL: [&str; 4] = ["main", "master", "develop", "trunk"];

/// Resolve the merge target for `branch`.
///
/// Git has no standard config for this, so the rule is ours and is documented
/// here rather than spread across the UI:
///
/// 1. `branch.<name>.mtgit-mergetarget`, then repo-wide `mtgit.mergeTarget` —
///    an explicit answer always wins.
/// 2. `refs/remotes/<remote>/HEAD`, where `<remote>` is the branch's upstream
///    remote or `origin`. This is the remote's own default branch, which is
///    the right answer whenever the repo has one.
/// 3. The first of `main`, `master`, `develop`, `trunk` that exists locally.
///
/// Returns `None` when nothing resolves, and also when the target resolves to
/// `branch` itself: "merge main into main" is not a target, and a panel that
/// showed `main → main · 0 ahead 0 behind` would be noise on the one branch
/// most users sit on.
pub fn merge_target(repo: &Repository, branch: &str) -> Result<Option<MergeTarget>> {
    let cfg = repo.config()?;
    let candidates: Vec<(String, &str)> = [
        cfg.get_string(&format!("branch.{branch}.mtgit-mergetarget")).ok().map(|v| (v, "config")),
        cfg.get_string("mtgit.mergeTarget").ok().map(|v| (v, "config")),
        remote_head(repo, branch).map(|v| (v, "remoteHead")),
        CONVENTIONAL
            .iter()
            .find(|n| **n != branch && repo.find_branch(n, BranchType::Local).is_ok())
            .map(|n| ((*n).to_string(), "conventional")),
    ]
    .into_iter()
    .flatten()
    .collect();

    let branch_oid = match repo.find_branch(branch, BranchType::Local) {
        Ok(b) => match b.get().peel_to_commit() {
            Ok(c) => c.id(),
            Err(_) => return Ok(None),
        },
        Err(_) => return Ok(None),
    };

    for (name, source) in candidates {
        if name == branch {
            continue;
        }
        let Some(target_oid) = resolve_shorthand(repo, &name) else { continue };
        if target_oid == branch_oid && source == "conventional" {
            // Same tip under a different name; nothing to merge either way.
            continue;
        }
        let (ahead, behind) = repo.graph_ahead_behind(branch_oid, target_oid)?;
        return Ok(Some(MergeTarget {
            reference: name,
            oid: target_oid.to_string(),
            ahead,
            behind,
            source: source.to_string(),
        }));
    }
    Ok(None)
}

/// The default branch the remote advertises, as `<remote>/<branch>`.
fn remote_head(repo: &Repository, branch: &str) -> Option<String> {
    let remote = repo
        .branch_upstream_remote(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|buf| buf.as_str().map(str::to_string))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "origin".to_string());

    let head = repo.find_reference(&format!("refs/remotes/{remote}/HEAD")).ok()?;
    let target = head.symbolic_target()?;
    target.strip_prefix("refs/remotes/").map(str::to_string)
}

/// Resolve a branch shorthand the way the user typed it: local first, then
/// remote-tracking, so `main` means the local branch and `origin/main` the
/// remote one without needing a prefix.
fn resolve_shorthand(repo: &Repository, name: &str) -> Option<Oid> {
    for kind in [BranchType::Local, BranchType::Remote] {
        if let Ok(b) = repo.find_branch(name, kind) {
            if let Ok(c) = b.get().peel_to_commit() {
                return Some(c.id());
            }
        }
    }
    repo.revparse_single(name).ok().and_then(|o| o.peel_to_commit().ok()).map(|c| c.id())
}

/// How two refs stand to each other, for the drop menu (STATUS C6).
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeRelation {
    /// `target` can be fast-forwarded to `source`: target's tip is an ancestor
    /// of source's.
    pub can_fast_forward: bool,
    /// `source` is already contained in `target`; there is nothing to merge.
    pub up_to_date: bool,
    /// Commits on `target` that `source` lacks, and vice versa.
    pub ahead: usize,
    pub behind: usize,
}

/// Resolve the relation between two refs.
///
/// Offering "Fast-forward" for a pair that cannot fast-forward is worse than
/// hiding it: the user picks it, git refuses, and the drop looks broken. So
/// the menu asks first (`05-merge.md` §2, §6).
pub fn merge_relation(repo: &Repository, target: &str, source: &str) -> Result<MergeRelation> {
    let resolve = |name: &str| -> Result<Oid> {
        resolve_shorthand(repo, name).ok_or_else(|| Error::Msg(format!("cannot resolve {name}")))
    };
    let target_oid = resolve(target)?;
    let source_oid = resolve(source)?;
    let (ahead, behind) = repo.graph_ahead_behind(target_oid, source_oid)?;
    Ok(MergeRelation {
        // Nothing to fast-forward *to* when the tips are equal, and nothing to
        // fast-forward *over* when target has commits of its own.
        can_fast_forward: ahead == 0 && behind > 0,
        up_to_date: behind == 0,
        ahead,
        behind,
    })
}

/// A ref that does not point at a commit but *contains* it — what the row
/// would be labelled if it were a tip (overview §1.2, "ghost refs").
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GhostRef {
    pub name: String,
    pub kind: RefKind,
    /// Commits between this ref's tip and the commit — 1 for its parent.
    pub distance: usize,
}

/// How many refs a single ghost lookup will interrogate.
///
/// Containment is a merge-base per ref, and a repository with a thousand
/// remote-tracking branches would spend a visible fraction of a second
/// answering a question the user asked by moving the mouse. Answering from
/// the first `GHOST_REF_SCAN_LIMIT` refs is wrong only in the case where every
/// one of them is a dead end, and being briefly wrong about a dimmed hint is
/// cheaper than a hover that stutters.
const GHOST_REF_SCAN_LIMIT: usize = 300;

/// The nearest refs containing `oid`, nearest first.
///
/// Refs that point *at* `oid` are excluded: the row already carries a real
/// badge for those, and a ghost duplicate of a pill sitting beside it reads as
/// a rendering bug. Local branches win ties over remote ones and remote ones
/// over tags, because that is the order in which a name answers "which branch
/// am I looking at".
pub fn containing_refs(repo: &Repository, oid: &str, limit: usize) -> Result<Vec<GhostRef>> {
    let target = repo.revparse_single(oid)?.peel_to_commit()?.id();
    let mut found: Vec<GhostRef> = Vec::new();

    let references = match repo.references() {
        Ok(references) => references,
        Err(_) => return Ok(found),
    };
    for r in references.flatten().take(GHOST_REF_SCAN_LIMIT) {
        let (kind, name) = if r.is_branch() {
            (RefKind::LocalBranch, r.shorthand().unwrap_or("").to_string())
        } else if r.is_remote() {
            (RefKind::RemoteBranch, r.shorthand().unwrap_or("").to_string())
        } else if r.is_tag() {
            (RefKind::Tag, r.shorthand().unwrap_or("").to_string())
        } else {
            continue;
        };
        if name.is_empty() || name.ends_with("/HEAD") {
            continue;
        }
        let Ok(tip) = r.peel_to_commit().map(|c| c.id()) else {
            continue;
        };
        if tip == target || !repo.graph_descendant_of(tip, target).unwrap_or(false) {
            continue;
        }
        // Only for the refs that actually contain it: `graph_ahead_behind`
        // walks the difference, so asking it of every ref would pay the walk
        // for the ones already ruled out by the cheaper merge-base above.
        let distance = repo.graph_ahead_behind(tip, target).map(|(ahead, _)| ahead).unwrap_or(usize::MAX);
        found.push(GhostRef { name, kind, distance });
    }

    found.sort_by(|a, b| {
        a.distance
            .cmp(&b.distance)
            .then_with(|| kind_rank(&a.kind).cmp(&kind_rank(&b.kind)))
            .then_with(|| a.name.cmp(&b.name))
    });
    found.truncate(limit);
    Ok(found)
}

fn kind_rank(kind: &RefKind) -> u8 {
    match kind {
        RefKind::LocalBranch => 0,
        RefKind::RemoteBranch => 1,
        RefKind::Tag => 2,
        RefKind::Head => 3,
    }
}

/// URL of a named remote (e.g. "origin"), if it exists.
pub fn remote_url(repo: &Repository, name: &str) -> Option<String> {
    repo.find_remote(name).ok().and_then(|r| r.url().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    /// `TestRepo::commit` points a fresh `bN` branch at every commit so a
    /// revwalk always reaches it. Ghost refs are *about* which branches
    /// contain a commit, so those would drown the assertion.
    fn drop_scaffold_branches(t: &TestRepo) {
        let names: Vec<String> = t
            .repo
            .branches(Some(BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
            .filter(|name| name.starts_with('b') && name[1..].chars().all(|c| c.is_ascii_digit()))
            .collect();
        for name in names {
            t.repo.find_branch(&name, BranchType::Local).unwrap().delete().unwrap();
        }
    }

    #[test]
    fn a_ghost_ref_names_the_nearest_branch_containing_the_commit() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        let c = t.commit("c", &[b]);
        drop_scaffold_branches(&t);
        t.repo.branch("mid", &t.repo.find_commit(b).unwrap(), true).unwrap();
        t.repo.branch("feature", &t.repo.find_commit(c).unwrap(), true).unwrap();

        let ghosts = containing_refs(&t.repo, &a.to_string(), 5).unwrap();
        let names: Vec<&str> = ghosts.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["mid", "feature"], "nearest first");
        assert_eq!(ghosts[0].distance, 1);
        assert_eq!(ghosts[1].distance, 2);

        // A ref that points *at* the commit is a real badge, not a ghost —
        // rendering both would put the same name on the row twice.
        let ghosts = containing_refs(&t.repo, &b.to_string(), 5).unwrap();
        let names: Vec<&str> = ghosts.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["feature"], "`mid` points at b, so it is not a ghost");
    }

    #[test]
    fn a_commit_no_ref_contains_has_no_ghost_refs() {
        // The case a "nearest ref" search gets wrong by answering anyway: a
        // tip on a parallel history is not what this commit is labelled by.
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let orphan = t.commit_orphan("elsewhere", "elsewhere");
        drop_scaffold_branches(&t);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();

        assert!(containing_refs(&t.repo, &orphan.to_string(), 5).unwrap().is_empty());
    }

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

    /// STATUS C8: after a `fetch --prune` the branch still *thinks* it tracks
    /// something. Reporting that as "no upstream" would hide the orphan, and
    /// reporting it as a live upstream would make ahead/behind lie.
    #[test]
    fn an_upstream_whose_tracking_ref_is_gone_is_reported_as_orphaned() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        t.repo.remote("origin", "https://example.com/o.git").unwrap();
        t.repo.reference("refs/remotes/origin/main", a, true, "test").unwrap();
        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("branch.main.remote", "origin").unwrap();
        cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();

        let before = list(&t.repo).unwrap();
        let main = before.local.iter().find(|b| b.name == "main").unwrap();
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert!(!main.upstream_gone);
        assert_eq!(main.ahead, Some(0));

        // What `git fetch --prune` does when the branch is deleted upstream.
        t.repo.find_reference("refs/remotes/origin/main").unwrap().delete().unwrap();

        let after = list(&t.repo).unwrap();
        let main = after.local.iter().find(|b| b.name == "main").unwrap();
        assert!(main.upstream_gone, "the branch still has the config, not the ref");
        assert_eq!(main.upstream.as_deref(), Some("origin/main"), "so the UI can name it");
        assert_eq!(main.ahead, None, "there is nothing to be ahead of any more");
    }

    #[test]
    fn a_branch_with_no_upstream_is_not_reported_as_orphaned() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("solo", &t.repo.find_commit(a).unwrap(), true).unwrap();
        let solo = list(&t.repo).unwrap().local.into_iter().find(|b| b.name == "solo").unwrap();
        assert!(!solo.upstream_gone);
        assert_eq!(solo.upstream, None);
    }

    #[test]
    fn merge_relation_only_allows_a_fast_forward_when_one_is_possible() {
        let t = TestRepo::new();
        let base = t.commit("base", &[]);
        let ahead = t.commit("ahead", &[base]);
        let side = t.commit("side", &[base]);
        t.repo.branch("base", &t.repo.find_commit(base).unwrap(), true).unwrap();
        t.repo.branch("ahead", &t.repo.find_commit(ahead).unwrap(), true).unwrap();
        t.repo.branch("side", &t.repo.find_commit(side).unwrap(), true).unwrap();

        // base -> ahead: a clean fast-forward.
        let ff = merge_relation(&t.repo, "base", "ahead").unwrap();
        assert!(ff.can_fast_forward);
        assert!(!ff.up_to_date);
        assert_eq!((ff.ahead, ff.behind), (0, 1));

        // ahead -> base: already contains it, so there is nothing to do.
        let done = merge_relation(&t.repo, "ahead", "base").unwrap();
        assert!(!done.can_fast_forward);
        assert!(done.up_to_date);

        // Diverged: a merge, never a fast-forward.
        let diverged = merge_relation(&t.repo, "ahead", "side").unwrap();
        assert!(!diverged.can_fast_forward);
        assert!(!diverged.up_to_date);
        assert_eq!((diverged.ahead, diverged.behind), (1, 1));
    }

    #[test]
    fn merge_relation_rejects_a_ref_that_does_not_exist() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        assert!(merge_relation(&t.repo, "main", "nope").is_err());
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
    fn merge_target_prefers_the_remotes_default_branch() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        let main = t.repo.find_commit(a).unwrap();
        t.repo.branch("main", &main, true).unwrap();
        t.repo.branch("feature", &t.repo.find_commit(b).unwrap(), true).unwrap();
        t.repo.remote("origin", "https://example.com/o.git").unwrap();
        // What `git remote set-head origin main` writes.
        t.repo
            .reference("refs/remotes/origin/main", a, true, "test")
            .unwrap();
        t.repo
            .reference_symbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/main", true, "test")
            .unwrap();

        let target = merge_target(&t.repo, "feature").unwrap().unwrap();
        assert_eq!(target.reference, "origin/main");
        assert_eq!(target.source, "remoteHead");
        assert_eq!(target.ahead, 1, "feature has one commit main does not");
        assert_eq!(target.behind, 0);
    }

    #[test]
    fn an_explicit_config_override_beats_the_remote_head() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.repo.branch("develop", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.branch("feature", &t.repo.find_commit(b).unwrap(), true).unwrap();
        t.repo
            .reference("refs/remotes/origin/main", a, true, "test")
            .unwrap();
        t.repo
            .reference_symbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/main", true, "test")
            .unwrap();

        let mut cfg = t.repo.config().unwrap();
        cfg.set_str("branch.feature.mtgit-mergetarget", "develop").unwrap();

        let target = merge_target(&t.repo, "feature").unwrap().unwrap();
        assert_eq!(target.reference, "develop");
        assert_eq!(target.source, "config");
    }

    /// The row a panel must not render: a branch is never its own merge target.
    #[test]
    fn a_branch_is_not_its_own_merge_target() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        t.repo.branch("main", &t.repo.find_commit(a).unwrap(), true).unwrap();
        assert!(merge_target(&t.repo, "main").unwrap().is_none());
    }

    #[test]
    fn merge_target_falls_back_to_a_conventional_branch() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.repo.branch("master", &t.repo.find_commit(a).unwrap(), true).unwrap();
        t.repo.branch("feature", &t.repo.find_commit(b).unwrap(), true).unwrap();

        let target = merge_target(&t.repo, "feature").unwrap().unwrap();
        assert_eq!(target.reference, "master");
        assert_eq!(target.source, "conventional");
        assert_eq!(target.ahead, 1);
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
