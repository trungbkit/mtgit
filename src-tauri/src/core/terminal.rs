//! Resolving tokens printed in the terminal panel back to the graph (G19).
//!
//! MTGit already has a pty panel and a graph that can select any commit; what
//! was missing was the bridge. `git log --oneline`, `git rebase`'s progress,
//! a `git status` branch line and a pasted `a..b` range all print references
//! the user then has to hunt for by hand.
//!
//! Resolution is deliberately *strict about shape and lenient about kind*: a
//! token only becomes a link when this repository can actually resolve it, so
//! a word that merely looks like a branch name is inert. Nothing here touches
//! a command line — it is all git2 — so there is no injection surface.

use crate::core::refs::RefKind;
use crate::error::Result;
use git2::{BranchType, Repository};
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalToken {
    /// The text as it appeared in the terminal, so the frontend can match it
    /// back to the range it highlighted.
    pub token: String,
    pub kind: RefKind,
    /// The commit to reveal. For a range this is its *right* end: `a..b` is
    /// read as "what b has that a does not", and b is where the answer is.
    pub oid: String,
    /// Short human label for the hover.
    pub label: String,
}

/// Shortest prefix we will treat as a possible object id.
///
/// Six is git's own default abbreviation floor, but at six a bare decimal
/// number like `123456` resolves often enough to make prose clickable.
const MIN_HEX: usize = 7;

fn is_hex_ish(token: &str) -> bool {
    token.len() >= MIN_HEX
        && token.len() <= 40
        && token.chars().all(|c| c.is_ascii_hexdigit())
}

/// Split `a..b` / `a...b`, if that is what this is.
fn as_range(token: &str) -> Option<(&str, &str)> {
    let (left, right) = match token.find("...") {
        Some(i) => (&token[..i], &token[i + 3..]),
        None => {
            let i = token.find("..")?;
            (&token[..i], &token[i + 2..])
        }
    };
    // `..b` and `a..` are both legal to git and both name a real endpoint.
    if left.is_empty() && right.is_empty() {
        return None;
    }
    Some((left, right))
}

fn peel(repo: &Repository, spec: &str) -> Option<String> {
    repo.revparse_single(spec)
        .ok()?
        .peel_to_commit()
        .ok()
        .map(|c| c.id().to_string())
}

/// Resolve one terminal token, or `None` when this repository does not know it.
pub fn resolve(repo: &Repository, token: &str) -> Option<TerminalToken> {
    // Trailing sentence punctuation is the sentence's, not the ref's — but a
    // trailing '.' cannot be trimmed yet, because `a..` is a legal range and
    // trimming it first turns "everything since a" into "a itself".
    let token = token.trim_end_matches([',', ':', ';', ')', ']', '"', '\'']);
    if token.is_empty() {
        return None;
    }

    if let Some((left, right)) = as_range(token) {
        // The right end is the interesting one, and `a..` means "a to HEAD".
        let target = if right.is_empty() { "HEAD" } else { right };
        let oid = peel(repo, target)?;
        // Both ends must resolve, or this is a filename with dots in it.
        if !left.is_empty() && peel(repo, left).is_none() {
            return None;
        }
        return Some(TerminalToken {
            token: token.to_string(),
            kind: RefKind::Head,
            oid,
            label: format!("range {token}"),
        });
    }

    let token = token.trim_end_matches('.');
    if token.is_empty() {
        return None;
    }

    if repo.find_branch(token, BranchType::Local).is_ok() {
        return peel(repo, token).map(|oid| TerminalToken {
            token: token.to_string(),
            kind: RefKind::LocalBranch,
            oid,
            label: format!("branch {token}"),
        });
    }
    if repo.find_branch(token, BranchType::Remote).is_ok() {
        return peel(repo, token).map(|oid| TerminalToken {
            token: token.to_string(),
            kind: RefKind::RemoteBranch,
            oid,
            label: format!("remote branch {token}"),
        });
    }
    if repo.find_reference(&format!("refs/tags/{token}")).is_ok() {
        return peel(repo, token).map(|oid| TerminalToken {
            token: token.to_string(),
            kind: RefKind::Tag,
            oid,
            label: format!("tag {token}"),
        });
    }

    // Object ids, and the revision syntax git prints in its own messages
    // (`HEAD`, `HEAD~2`, `main@{1}`). A bare word that is none of the above
    // must *not* fall through to revparse: `README` resolves to a tree entry
    // on some repos, and a link to a file is not what the user asked for.
    let revish = is_hex_ish(token)
        || token.starts_with("HEAD")
        || token.contains(['~', '^', '@']);
    if !revish {
        return None;
    }
    peel(repo, token).map(|oid| TerminalToken {
        token: token.to_string(),
        kind: RefKind::Head,
        label: format!("commit {}", oid.chars().take(7).collect::<String>()),
        oid,
    })
}

/// Resolve a line's worth of candidates in one call — the terminal hands over
/// every plausible token on the hovered line, and only the real ones come back.
pub fn resolve_many(repo: &Repository, tokens: &[String]) -> Result<Vec<TerminalToken>> {
    let mut out = Vec::new();
    for token in tokens {
        if let Some(resolved) = resolve(repo, token) {
            out.push(resolved);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    fn repo() -> (TestRepo, String, String) {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.repo.branch("main", &t.repo.find_commit(b).unwrap(), true).unwrap();
        t.repo.set_head("refs/heads/main").unwrap();
        t.repo
            .tag_lightweight("v1.0", &t.repo.find_object(a, None).unwrap(), true)
            .unwrap();
        t.repo.reference("refs/remotes/origin/main", b, true, "").unwrap();
        (t, a.to_string(), b.to_string())
    }

    #[test]
    fn resolves_the_four_kinds_a_terminal_actually_prints() {
        let (t, a, b) = repo();

        let sha = resolve(&t.repo, &a[..8]).expect("abbreviated sha");
        assert_eq!(sha.oid, a);
        assert_eq!(sha.kind, RefKind::Head);

        assert_eq!(resolve(&t.repo, "main").unwrap().oid, b);
        assert_eq!(resolve(&t.repo, "main").unwrap().kind, RefKind::LocalBranch);
        assert_eq!(resolve(&t.repo, "origin/main").unwrap().kind, RefKind::RemoteBranch);
        assert_eq!(resolve(&t.repo, "v1.0").unwrap().oid, a);
        assert_eq!(resolve(&t.repo, "v1.0").unwrap().kind, RefKind::Tag);
    }

    /// `a..b` reveals *b*: the range means "what b has that a does not", and
    /// jumping to a would land the user at the commit they already have.
    #[test]
    fn a_range_reveals_its_right_end() {
        let (t, a, b) = repo();
        let range = resolve(&t.repo, &format!("{}..{}", &a[..8], &b[..8])).unwrap();
        assert_eq!(range.oid, b);
        assert!(range.label.starts_with("range "), "{}", range.label);

        assert_eq!(resolve(&t.repo, "main...origin/main").unwrap().oid, b);
        // `a..` is "a to HEAD", which git accepts and so must we.
        assert_eq!(resolve(&t.repo, &format!("{}..", &a[..8])).unwrap().oid, b);
    }

    /// The whole point of resolving in Rust is that prose stays prose. A word
    /// that is not a ref, a short hex run, and a filename that merely contains
    /// dots must all come back `None`.
    #[test]
    fn prose_and_filenames_do_not_become_links() {
        let (t, a, _) = repo();
        assert!(resolve(&t.repo, "rebase").is_none(), "a plain word");
        assert!(resolve(&t.repo, "feature").is_none(), "a branch that does not exist");
        assert!(resolve(&t.repo, &a[..4]).is_none(), "too short to be a sha");
        assert!(resolve(&t.repo, "README.md").is_none(), "a filename is not a range");
        assert!(resolve(&t.repo, "src/lib.rs").is_none());
        assert!(resolve(&t.repo, "").is_none());
        assert!(resolve(&t.repo, "..").is_none());
        // 7 hex digits that are not an object must not resolve either.
        assert!(resolve(&t.repo, "0000000").is_none());
    }

    /// Terminals print refs inside sentences; the trailing punctuation is the
    /// sentence's, not the ref's.
    #[test]
    fn trailing_punctuation_is_not_part_of_the_token() {
        let (t, _, b) = repo();
        // e.g. "Switched to branch 'main'." / "up to date with 'origin/main'."
        assert_eq!(resolve(&t.repo, "main.").unwrap().oid, b);
        assert_eq!(resolve(&t.repo, "main,").unwrap().oid, b);
        assert_eq!(resolve(&t.repo, "main)").unwrap().oid, b);
    }

    #[test]
    fn resolve_many_drops_what_it_cannot_resolve() {
        let (t, _, b) = repo();
        let tokens: Vec<String> = ["main", "nonsense", "v1.0"].iter().map(|s| s.to_string()).collect();
        let out = resolve_many(&t.repo, &tokens).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].oid, b);
        assert_eq!(out[1].token, "v1.0");
    }
}
