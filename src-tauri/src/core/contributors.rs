//! Repository contributors (G28).
//!
//! Doubles as the data behind the `author:` search picker and the co-author
//! picker, which is why co-authorship is counted separately rather than
//! folded into the commit count: someone who has co-authored twenty commits
//! and authored none is a name worth offering in a trailer picker and a
//! misleading entry in a "top committers" list.

use crate::error::Result;
use git2::{Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub name: String,
    pub email: String,
    /// Commits authored by this identity.
    pub commits: usize,
    /// Commits where the identity appears only in a `Co-authored-by:` trailer.
    pub co_authored: usize,
    /// Newest commit (authored or co-authored) this identity appears on.
    pub last_commit: String,
    pub last_timestamp: i64,
}

/// Identities are keyed on the lowercased email, not on the name.
///
/// One person routinely commits as "Ada L", "ada" and "Ada Lovelace" from the
/// same address; the reverse — two people sharing an address — happens only
/// with `noreply` bot addresses, where merging them is the answer anyway. The
/// display name kept is the one from the newest commit, so a rename settles.
fn key(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Walk commits reachable from HEAD, newest first, tallying identities.
pub fn contributors(repo: &Repository, limit_commits: usize) -> Result<Vec<Contributor>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TIME | Sort::TOPOLOGICAL)?;
    if walk.push_head().is_err() {
        // Unborn HEAD: no history, therefore no contributors.
        return Ok(Vec::new());
    }

    let mut by_email: HashMap<String, Contributor> = HashMap::new();

    for oid in walk.take(limit_commits) {
        let commit = repo.find_commit(oid?)?;
        let oid_str = commit.id().to_string();
        let when = commit.author().when().seconds();

        {
            let author = commit.author();
            let entry = touch(
                &mut by_email,
                author.name().unwrap_or(""),
                author.email().unwrap_or(""),
                &oid_str,
                when,
            );
            entry.commits += 1;
        }

        for (name, email) in co_authors(commit.message().unwrap_or("")) {
            let entry = touch(&mut by_email, &name, &email, &oid_str, when);
            entry.co_authored += 1;
        }
    }

    let mut out: Vec<Contributor> = by_email.into_values().collect();
    // Commits first, then co-authorship, then name — so the order is stable
    // across runs even when two contributors have identical counts.
    out.sort_by(|a, b| {
        b.commits
            .cmp(&a.commits)
            .then(b.co_authored.cmp(&a.co_authored))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn touch<'m>(
    map: &'m mut HashMap<String, Contributor>,
    name: &str,
    email: &str,
    oid: &str,
    when: i64,
) -> &'m mut Contributor {
    let entry = map.entry(key(email)).or_insert_with(|| Contributor {
        name: name.to_string(),
        email: email.trim().to_string(),
        commits: 0,
        co_authored: 0,
        last_commit: oid.to_string(),
        last_timestamp: when,
    });
    // The walk is newest-first, so the first sighting is the newest one and
    // later (older) commits must not overwrite the display name or the date.
    if when > entry.last_timestamp {
        entry.name = name.to_string();
        entry.last_commit = oid.to_string();
        entry.last_timestamp = when;
    }
    entry
}

/// Parse `Co-authored-by: Name <email>` trailers out of a commit message.
///
/// Deliberately lenient about the trailer's position: git only recognises
/// trailers in the last paragraph, but a message that puts one mid-body still
/// means it, and we are attributing credit rather than reformatting.
pub fn co_authors(message: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in message.lines() {
        let line = line.trim();
        let Some(rest) = strip_prefix_ci(line, "co-authored-by:") else { continue };
        let rest = rest.trim();
        match (rest.rfind('<'), rest.rfind('>')) {
            (Some(open), Some(close)) if close > open => {
                let name = rest[..open].trim().to_string();
                let email = rest[open + 1..close].trim().to_string();
                if !email.is_empty() {
                    out.push((name, email));
                }
            }
            _ => {}
        }
    }
    out
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    (s.len() >= prefix.len() && s[..prefix.len()].eq_ignore_ascii_case(prefix))
        .then(|| &s[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn contributors_are_ranked_by_commit_count() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.set_head_to(b);

        let list = contributors(&t.repo, 1000).unwrap();
        assert_eq!(list.len(), 1, "TestRepo commits under one identity");
        assert_eq!(list[0].email, "test@example.com");
        assert_eq!(list[0].commits, 2);
        assert_eq!(list[0].last_commit, b.to_string());
    }

    /// A co-author has authored nothing, so counting the trailer as a commit
    /// would make the contributors list disagree with `git shortlog`.
    #[test]
    fn a_co_author_is_listed_without_being_credited_a_commit() {
        let t = TestRepo::new();
        let a = t.commit_with_message(
            "feat: thing\n\nCo-authored-by: Ada L <ada@example.com>\n",
            &[],
        );
        t.set_head_to(a);

        let list = contributors(&t.repo, 1000).unwrap();
        let ada = list.iter().find(|c| c.email == "ada@example.com").expect("ada listed");
        assert_eq!(ada.commits, 0);
        assert_eq!(ada.co_authored, 1);
        assert_eq!(ada.name, "Ada L");
    }

    #[test]
    fn identities_merge_on_email_and_keep_the_newest_name() {
        let t = TestRepo::new();
        let a = t.commit_with_message("one\n\nCo-authored-by: ada <ada@example.com>\n", &[]);
        let b = t.commit_with_message(
            "two\n\nCo-authored-by: Ada Lovelace <ADA@Example.com>\n",
            &[a],
        );
        t.set_head_to(b);

        let list = contributors(&t.repo, 1000).unwrap();
        let matches: Vec<_> = list.iter().filter(|c| c.email.to_lowercase() == "ada@example.com").collect();
        assert_eq!(matches.len(), 1, "case and spelling variants are one person");
        assert_eq!(matches[0].co_authored, 2);
        assert_eq!(matches[0].name, "Ada Lovelace", "the newest commit names them");
    }

    #[test]
    fn a_trailer_without_an_email_is_ignored() {
        assert!(co_authors("x\n\nCo-authored-by: Nobody\n").is_empty());
        assert!(co_authors("x\n\nCo-authored-by: Nobody <>\n").is_empty());
        assert_eq!(
            co_authors("x\n\nco-authored-by: A B <a@b.c>"),
            vec![("A B".to_string(), "a@b.c".to_string())]
        );
    }

    #[test]
    fn an_unborn_head_has_no_contributors() {
        let t = TestRepo::new();
        assert!(contributors(&t.repo, 10).unwrap().is_empty());
    }
}
