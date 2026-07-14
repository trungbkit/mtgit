//! Programmatic fixture repositories for unit tests. Building history with
//! git2 (rather than shelling out) keeps tests fast and deterministic.

#![cfg(test)]

use git2::{Oid, Repository, Signature, Time};
use std::cell::Cell;
use tempfile::TempDir;

pub struct TestRepo {
    #[allow(dead_code)]
    pub dir: TempDir,
    pub repo: Repository,
    counter: Cell<u32>,
}

impl TestRepo {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        TestRepo { dir, repo, counter: Cell::new(0) }
    }

    /// Deterministic, strictly-increasing signature so topological+time order
    /// matches creation order (newest commit created last).
    fn sig(&self, n: u32) -> Signature<'static> {
        Signature::new(
            "Test User",
            "test@example.com",
            &Time::new(1_600_000_000 + i64::from(n) * 60, 0),
        )
        .unwrap()
    }

    fn make_tree(&self, content: &str) -> Oid {
        let blob = self.repo.blob(content.as_bytes()).unwrap();
        let mut tb = self.repo.treebuilder(None).unwrap();
        tb.insert("file.txt", blob, 0o100644).unwrap();
        tb.write().unwrap()
    }

    /// Create a commit with the given parents and point a fresh branch at it so
    /// the revwalk always reaches it. Returns the new oid.
    pub fn commit(&self, summary: &str, parents: &[Oid]) -> Oid {
        self.commit_with_message(summary, parents)
    }

    /// Like [`commit`], but the full message (summary + body) is used verbatim.
    pub fn commit_with_message(&self, message: &str, parents: &[Oid]) -> Oid {
        let n = self.counter.get() + 1;
        self.counter.set(n);

        let tree_oid = self.make_tree(&format!("{message}-{n}"));
        let tree = self.repo.find_tree(tree_oid).unwrap();
        let sig = self.sig(n);

        let parent_commits: Vec<_> =
            parents.iter().map(|p| self.repo.find_commit(*p).unwrap()).collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();

        let oid = self
            .repo
            .commit(None, &sig, &sig, message, &tree, &parent_refs)
            .unwrap();

        let commit = self.repo.find_commit(oid).unwrap();
        self.repo.branch(&format!("b{n}"), &commit, true).unwrap();
        oid
    }

    /// Create a parentless root on a distinctly named branch (a second history).
    pub fn commit_orphan(&self, summary: &str, branch: &str) -> Oid {
        let oid = self.commit(summary, &[]);
        let commit = self.repo.find_commit(oid).unwrap();
        self.repo.branch(branch, &commit, true).unwrap();
        oid
    }
}
