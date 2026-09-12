//! The path source `file:` autocomplete waits on (`08-search-and-filter.md`
//! §4, §7.1).
//!
//! Completion is **per path segment**, not a substring match over every
//! tracked file. A repository of any size has tens of thousands of paths, and
//! a flat list of the eight that happen to contain "co" answers a question
//! nobody asked — the useful reply to `file:src/fe` is `src/features/`, one
//! directory the user can then descend into. That is how every shell completes
//! a path, and it is the only shape that stays useful at 50k files.
//!
//! The tree is the *selected commit's*, falling back to HEAD: `file:` filters
//! history, and the paths worth offering are the ones that existed where the
//! user is looking. A repository with an unborn HEAD falls back to the index,
//! which is the only place a brand-new repo's paths exist at all.

use crate::error::Result;
use git2::{Repository, Tree};
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathCompletion {
    /// The full path to substitute into the query. Directories keep their
    /// trailing slash so accepting one leaves the caret ready to descend.
    pub path: String,
    pub is_dir: bool,
}

/// Complete `prefix` against the tree of `oid` (or HEAD).
///
/// `prefix` is a partial path as typed: everything up to the last `/` selects
/// the directory to list, and what follows filters its entries.
pub fn complete(
    repo: &Repository,
    oid: Option<&str>,
    prefix: &str,
    limit: usize,
) -> Result<Vec<PathCompletion>> {
    let (dir, leaf) = match prefix.rfind('/') {
        Some(at) => (&prefix[..=at], &prefix[at + 1..]),
        None => ("", prefix),
    };
    let leaf = leaf.to_lowercase();

    let Some(root) = tree_of(repo, oid) else {
        return Ok(index_fallback(repo, dir, &leaf, limit));
    };
    let subtree = if dir.is_empty() {
        Some(root)
    } else {
        root.get_path(std::path::Path::new(dir.trim_end_matches('/')))
            .ok()
            .and_then(|entry| entry.to_object(repo).ok())
            .and_then(|object| object.into_tree().ok())
    };
    let Some(subtree) = subtree else {
        return Ok(Vec::new());
    };

    let mut out: Vec<PathCompletion> = subtree
        .iter()
        .filter_map(|entry| {
            let name = entry.name()?;
            if !name.to_lowercase().starts_with(&leaf) {
                return None;
            }
            let is_dir = entry.kind() == Some(git2::ObjectType::Tree);
            Some(PathCompletion {
                path: format!("{dir}{name}{}", if is_dir { "/" } else { "" }),
                is_dir,
            })
        })
        .collect();

    // Directories first: they are the ones that lead somewhere, and at the
    // top level of most repositories they are also the shorter list.
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.path.cmp(&b.path)));
    out.truncate(limit);
    Ok(out)
}

fn tree_of<'r>(repo: &'r Repository, oid: Option<&str>) -> Option<Tree<'r>> {
    match oid {
        Some(oid) => repo.revparse_single(oid).ok()?.peel_to_commit().ok()?.tree().ok(),
        None => repo.head().ok()?.peel_to_commit().ok()?.tree().ok(),
    }
}

/// An unborn HEAD has no tree; the index is where a first commit's paths live.
fn index_fallback(repo: &Repository, dir: &str, leaf: &str, limit: usize) -> Vec<PathCompletion> {
    let Ok(index) = repo.index() else {
        return Vec::new();
    };
    let mut seen: Vec<PathCompletion> = Vec::new();
    for entry in index.iter() {
        let Ok(path) = String::from_utf8(entry.path.clone()) else {
            continue;
        };
        let Some(rest) = path.strip_prefix(dir) else {
            continue;
        };
        // Collapse to the next segment, so the index answers in the same
        // shape a tree does rather than listing every file under `src/`.
        let (name, is_dir) = match rest.split_once('/') {
            Some((head, _)) => (head.to_string(), true),
            None => (rest.to_string(), false),
        };
        if !name.to_lowercase().starts_with(leaf) {
            continue;
        }
        let completion = PathCompletion {
            path: format!("{dir}{name}{}", if is_dir { "/" } else { "" }),
            is_dir,
        };
        if !seen.contains(&completion) {
            seen.push(completion);
        }
    }
    seen.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.path.cmp(&b.path)));
    seen.truncate(limit);
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn completion_descends_one_segment_at_a_time() {
        let t = TestRepo::new();
        let a = t.commit_files(
            "a",
            &[],
            &[
                ("src/features/graph.rs", "g"),
                ("src/features/sidebar.rs", "s"),
                ("src/lib.rs", "l"),
                ("README.md", "r"),
            ],
        );

        let top = complete(&t.repo, Some(&a.to_string()), "", 10).unwrap();
        assert_eq!(
            top,
            vec![
                PathCompletion { path: "src/".into(), is_dir: true },
                PathCompletion { path: "README.md".into(), is_dir: false },
            ],
            "one entry per top-level segment, directories first"
        );

        let inside = complete(&t.repo, Some(&a.to_string()), "src/", 10).unwrap();
        let names: Vec<&str> = inside.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(names, vec!["src/features/", "src/lib.rs"]);

        let filtered = complete(&t.repo, Some(&a.to_string()), "src/features/si", 10).unwrap();
        let names: Vec<&str> = filtered.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(names, vec!["src/features/sidebar.rs"]);
    }

    #[test]
    fn a_path_that_only_exists_in_another_commit_is_not_offered() {
        // The reason completion reads the *selection's* tree: offering a path
        // that the commit under the cursor never had produces a `file:` search
        // with no hits and no explanation.
        let t = TestRepo::new();
        let old = t.commit_files("old", &[], &[("gone.rs", "x")]);
        let new = t.commit_files("new", &[old], &[("kept.rs", "x")]);

        let at_new = complete(&t.repo, Some(&new.to_string()), "", 10).unwrap();
        assert_eq!(at_new.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(), vec!["kept.rs"]);
        let at_old = complete(&t.repo, Some(&old.to_string()), "", 10).unwrap();
        assert_eq!(at_old.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(), vec!["gone.rs"]);
    }

    #[test]
    fn an_unborn_head_completes_from_the_index() {
        let t = TestRepo::new();
        std::fs::create_dir_all(t.dir.path().join("src")).unwrap();
        std::fs::write(t.dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        let mut index = t.repo.index().unwrap();
        index.add_path(std::path::Path::new("src/main.rs")).unwrap();
        index.write().unwrap();

        let top = complete(&t.repo, None, "", 10).unwrap();
        assert_eq!(top, vec![PathCompletion { path: "src/".into(), is_dir: true }]);
        let inside = complete(&t.repo, None, "src/", 10).unwrap();
        assert_eq!(inside, vec![PathCompletion { path: "src/main.rs".into(), is_dir: false }]);
    }
}
