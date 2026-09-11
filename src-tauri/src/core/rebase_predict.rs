//! Predicting which steps of an interactive rebase will conflict (G26).
//!
//! The plan editor lets you reorder, squash and drop commits before anything
//! happens. What it could not tell you is the one thing you actually want to
//! know: *which of these is going to stop and ask me to resolve a conflict.*
//! This answers that by replaying the plan as a sequence of in-memory
//! three-way merges.
//!
//! ## The algorithm
//!
//! Carry a `base` tree, starting at `onto`'s tree. For each step, cherry-pick
//! the commit onto `base` with `merge_trees(ancestor = commit^, ours = base,
//! theirs = commit)` — the same three trees git uses. If the resulting index
//! has conflicts, the step is predicted to conflict and the conflicted paths
//! are reported. To keep predicting past that point we then redo the merge
//! favouring the incoming side, which models "the user resolved it and
//! carried on"; without that, one early conflict would make every later
//! prediction meaningless.
//!
//! `squash` and `fixup` apply to the same carried tree that a `pick` would,
//! which is exactly what git does (it picks, then amends), so they need no
//! special case for *content*. `drop` skips the commit — and dropping is
//! where prediction earns its keep, because the commits after it now apply to
//! a tree that never received its change.
//!
//! ## What it touches
//!
//! **No ref moves, no index writes, no `ORIG_HEAD`, no working tree.** It does
//! write *tree and blob objects* to the object database, because git2's
//! three-way merge takes `Tree` handles and the only way to turn a merged
//! index back into a tree is to write it. Those objects are unreferenced and
//! `git gc` prunes them; nothing in the repository points at them, and no
//! state a user can see changes. Being unable to say "writes nothing at all"
//! is the honest version of the plan's promise, and worth stating plainly
//! rather than hiding behind "read-only".
//!
//! ## Conflicts cascade, and that is not a bug
//!
//! Reordering two commits that touch the same line predicts *two* conflicts,
//! not one — which is what git does too: step one clashes, and once it is
//! resolved step two clashes against the resolution. The carried-forward
//! guess is what makes the second prediction possible at all, and it is also
//! why a later prediction is weaker than an earlier one: it rests on a
//! resolution the user has not made yet.
//!
//! ## It is an estimate
//!
//! Git's own rebase applies *patches*, with rename detection and its own
//! conflict-style rendering; this applies tree merges. They agree on the
//! common cases and can disagree at the edges, so the UI must label the
//! result an estimate and must never gate Start Rebase on it.

use crate::core::advanced::{RebaseAction, RebasePlanItem};
use crate::error::{Error, Result};
use git2::{MergeOptions, Oid, Repository, Tree};
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PredictedConflict {
    /// Index of the step in the plan as it was given.
    pub index: usize,
    pub oid: String,
    /// Paths that collide, sorted, so the UI's list is stable across reruns.
    pub files: Vec<String>,
}

/// Trial-apply `plan` onto `onto` and report the steps that will conflict.
pub fn predict(repo: &Repository, onto: &str, plan: &[RebasePlanItem]) -> Result<Vec<PredictedConflict>> {
    let onto_oid = repo
        .revparse_single(onto)
        .map_err(|_| Error::Msg(format!("cannot resolve {onto}")))?
        .peel_to_commit()?
        .id();
    let mut base: Tree<'_> = repo.find_commit(onto_oid)?.tree()?;
    let mut out = Vec::new();

    for (index, item) in plan.iter().enumerate() {
        if item.action == RebaseAction::Drop {
            continue;
        }
        let oid = Oid::from_str(&item.oid).map_err(|_| Error::Msg(format!("bad oid: {}", item.oid)))?;
        let commit = repo.find_commit(oid)?;
        // A merge commit has no single "the change it made", so there is
        // nothing to trial-apply. Git refuses to replay one in a plan anyway.
        if commit.parent_count() > 1 {
            continue;
        }
        let theirs = commit.tree()?;
        let ancestor = match commit.parent(0) {
            Ok(parent) => parent.tree()?,
            // A root commit has no ancestor; merging against the empty tree is
            // the same thing git does when it diffs one.
            Err(_) => repo.find_tree(empty_tree(repo)?)?,
        };

        let merged = repo.merge_trees(&ancestor, &base, &theirs, None)?;
        if merged.has_conflicts() {
            let mut files: Vec<String> = merged
                .conflicts()?
                .flatten()
                .filter_map(|c| {
                    c.our
                        .as_ref()
                        .or(c.their.as_ref())
                        .or(c.ancestor.as_ref())
                        .map(|entry| String::from_utf8_lossy(&entry.path).to_string())
                })
                .collect();
            files.sort_unstable();
            files.dedup();
            out.push(PredictedConflict { index, oid: item.oid.clone(), files });

            // Carry on from a plausible resolution so later steps still say
            // something. Favouring the incoming side is the resolution a
            // rebase most often ends in — the commit being replayed is the
            // change the user is trying to keep.
            let mut opts = MergeOptions::new();
            opts.file_favor(git2::FileFavor::Theirs);
            let mut resolved = repo.merge_trees(&ancestor, &base, &theirs, Some(&opts))?;
            base = repo.find_tree(resolved.write_tree_to(repo)?)?;
        } else {
            let mut merged = merged;
            base = repo.find_tree(merged.write_tree_to(repo)?)?;
        }
    }
    Ok(out)
}

fn empty_tree(repo: &Repository) -> Result<Oid> {
    Ok(repo.treebuilder(None)?.write()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::advanced::RebaseAction;
    use crate::testutil::TestRepo;

    fn item(oid: Oid, action: RebaseAction) -> RebasePlanItem {
        RebasePlanItem { oid: oid.to_string(), action, message: None }
    }

    #[test]
    fn a_plan_that_replays_cleanly_predicts_nothing() {
        let t = TestRepo::new();
        let base = t.commit_files("base", &[], &[("a.txt", "a\n")]);
        let one = t.commit_files("one", &[base], &[("a.txt", "a\n"), ("b.txt", "b\n")]);
        let two = t.commit_files("two", &[one], &[("a.txt", "a\n"), ("b.txt", "b\n"), ("c.txt", "c\n")]);

        let plan = vec![item(one, RebaseAction::Pick), item(two, RebaseAction::Pick)];
        assert!(predict(&t.repo, &base.to_string(), &plan).unwrap().is_empty());
    }

    /// The case the feature exists for: a reorder that puts a commit before
    /// the change it depends on.
    #[test]
    fn reordering_two_edits_to_the_same_line_predicts_a_conflict() {
        let t = TestRepo::new();
        let base = t.commit_files("base", &[], &[("f.txt", "one\n")]);
        let first = t.commit_files("first", &[base], &[("f.txt", "two\n")]);
        let second = t.commit_files("second", &[first], &[("f.txt", "three\n")]);

        // In order: clean.
        let ordered = vec![item(first, RebaseAction::Pick), item(second, RebaseAction::Pick)];
        assert!(predict(&t.repo, &base.to_string(), &ordered).unwrap().is_empty());

        // Swapped: `second` expects "two" on that line and finds "one".
        let swapped = vec![item(second, RebaseAction::Pick), item(first, RebaseAction::Pick)];
        let predicted = predict(&t.repo, &base.to_string(), &swapped).unwrap();
        assert_eq!(predicted[0].index, 0, "the moved commit clashes first");
        assert_eq!(predicted[0].files, vec!["f.txt"]);
        // And it cascades, as git does: once step 0 is resolved to "three",
        // step 1 tries to turn "one" into "two" and finds neither.
        assert_eq!(predicted.len(), 2);
        assert_eq!(predicted[1].index, 1);
    }

    /// Dropping a commit is the other way a plan turns clean history into a
    /// conflict, and a naive per-commit check cannot see it: each commit on
    /// its own is fine, the *plan* is not.
    #[test]
    fn dropping_a_prerequisite_predicts_a_conflict_in_the_commit_that_needed_it() {
        let t = TestRepo::new();
        let base = t.commit_files("base", &[], &[("f.txt", "one\n")]);
        let middle = t.commit_files("middle", &[base], &[("f.txt", "two\n")]);
        let top = t.commit_files("top", &[middle], &[("f.txt", "three\n")]);

        let plan = vec![item(middle, RebaseAction::Drop), item(top, RebaseAction::Pick)];
        let predicted = predict(&t.repo, &base.to_string(), &plan).unwrap();
        assert_eq!(predicted.len(), 1);
        assert_eq!(predicted[0].oid, top.to_string());
    }

    /// Prediction must not stop at the first conflict: a plan with two bad
    /// steps has to report both, or fixing the first reveals the second only
    /// after the rebase has started.
    #[test]
    fn prediction_continues_past_the_first_conflict() {
        let t = TestRepo::new();
        let base = t.commit_files("base", &[], &[("f.txt", "0\n"), ("g.txt", "0\n")]);
        let f1 = t.commit_files("f1", &[base], &[("f.txt", "1\n"), ("g.txt", "0\n")]);
        let f2 = t.commit_files("f2", &[f1], &[("f.txt", "2\n"), ("g.txt", "0\n")]);
        let g1 = t.commit_files("g1", &[f2], &[("f.txt", "2\n"), ("g.txt", "1\n")]);
        let g2 = t.commit_files("g2", &[g1], &[("f.txt", "2\n"), ("g.txt", "2\n")]);

        // Both pairs reordered: two independent clashes, in two files.
        let plan = vec![
            item(f2, RebaseAction::Pick),
            item(f1, RebaseAction::Pick),
            item(g2, RebaseAction::Pick),
            item(g1, RebaseAction::Pick),
        ];
        let predicted = predict(&t.repo, &base.to_string(), &plan).unwrap();
        // The point is that the walk does not stop: the g-file clash is found
        // even though the f-file clash came first, two steps earlier.
        let touched: Vec<&str> =
            predicted.iter().flat_map(|c| c.files.iter().map(String::as_str)).collect();
        assert!(touched.contains(&"f.txt"));
        assert!(touched.contains(&"g.txt"), "prediction did not stop at the first conflict");
        assert!(predicted.iter().any(|c| c.index >= 2), "later steps were still evaluated");
    }

    /// A squash applies to the same carried tree a pick would, so it is
    /// predicted like one — including when what it squashes into is a commit
    /// whose own prerequisite was dropped.
    #[test]
    fn a_squash_is_predicted_like_the_pick_it_collapses_into() {
        let t = TestRepo::new();
        let base = t.commit_files("base", &[], &[("f.txt", "one\n"), ("g.txt", "g\n")]);
        let middle = t.commit_files("middle", &[base], &[("f.txt", "two\n"), ("g.txt", "g\n")]);
        let top = t.commit_files("top", &[middle], &[("f.txt", "three\n"), ("g.txt", "g\n")]);
        let unrelated = t.commit_files("unrelated", &[top], &[("f.txt", "three\n"), ("g.txt", "G\n")]);

        // `unrelated` squashes cleanly; `top` clashes because `middle` is gone.
        let plan = vec![
            item(middle, RebaseAction::Drop),
            item(top, RebaseAction::Pick),
            item(unrelated, RebaseAction::Squash),
        ];
        let predicted = predict(&t.repo, &base.to_string(), &plan).unwrap();
        assert_eq!(predicted.len(), 1);
        assert_eq!(predicted[0].index, 1);
        assert_eq!(predicted[0].files, vec!["f.txt"]);
    }

    /// Nothing may leak into the repository: the whole point of predicting is
    /// that you can do it before deciding.
    #[test]
    fn prediction_moves_no_refs_and_leaves_the_worktree_alone() {
        let t = TestRepo::new();
        let base = t.commit_files("base", &[], &[("f.txt", "one\n")]);
        let first = t.commit_files("first", &[base], &[("f.txt", "two\n")]);
        let second = t.commit_files("second", &[first], &[("f.txt", "three\n")]);
        t.set_head_to(second);

        let before: Vec<String> = t
            .repo
            .references()
            .unwrap()
            .flatten()
            .map(|r| format!("{}:{:?}", r.name().unwrap_or(""), r.target()))
            .collect();
        let head_before = t.repo.head().unwrap().target();

        let plan = vec![item(second, RebaseAction::Pick), item(first, RebaseAction::Pick)];
        predict(&t.repo, &base.to_string(), &plan).unwrap();

        let after: Vec<String> = t
            .repo
            .references()
            .unwrap()
            .flatten()
            .map(|r| format!("{}:{:?}", r.name().unwrap_or(""), r.target()))
            .collect();
        assert_eq!(before, after, "no ref moved");
        assert_eq!(head_before, t.repo.head().unwrap().target());
        assert_eq!(t.repo.state(), git2::RepositoryState::Clean);
        assert!(!t.repo.index().unwrap().has_conflicts());
    }

    #[test]
    fn an_unresolvable_onto_is_an_error_rather_than_an_empty_prediction() {
        let t = TestRepo::new();
        let a = t.commit_files("a", &[], &[("f.txt", "a\n")]);
        assert!(predict(&t.repo, "no-such-ref", &[item(a, RebaseAction::Pick)]).is_err());
    }
}
