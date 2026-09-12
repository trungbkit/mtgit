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

    /// Point HEAD at `oid` and materialise its tree in the working directory.
    ///
    /// [`commit`] writes objects without moving HEAD, which leaves the fixture
    /// with an unborn HEAD and an empty working tree — fine for pure git2
    /// reads, but the `git` binary refuses to stash, merge or diff there.
    pub fn checkout(&self, oid: Oid) {
        let object = self.repo.find_object(oid, None).unwrap();
        self.repo.reset(&object, git2::ResetType::Hard, None).unwrap();
    }

    /// Commit an explicit set of `(path, content)` entries instead of the
    /// single `file.txt` [`commit`] writes. Paths absent from `files` are
    /// dropped, which is what makes a rename expressible: pass the new name
    /// and omit the old one.
    pub fn commit_files(&self, message: &str, parents: &[Oid], files: &[(&str, &str)]) -> Oid {
        let n = self.counter.get() + 1;
        self.counter.set(n);

        // An in-memory index rather than a treebuilder: a treebuilder inserts
        // one flat entry per call and rejects a `/` in the name, so a fixture
        // with `src/lib.rs` in it could not be written at all. The index is
        // also not the repository's, so building a fixture does not stage
        // anything a later test would read back.
        let mut index = git2::Index::new().unwrap();
        for (path, content) in files {
            let blob = self.repo.blob(content.as_bytes()).unwrap();
            index
                .add(&git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: 0o100644,
                    uid: 0,
                    gid: 0,
                    file_size: content.len() as u32,
                    id: blob,
                    flags: 0,
                    flags_extended: 0,
                    path: path.as_bytes().to_vec(),
                })
                .unwrap();
        }
        let tree_oid = index.write_tree_to(&self.repo).unwrap();
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

    /// Point HEAD (without touching the working tree) at the branch `commit`
    /// created for `oid`, so a revwalk from HEAD reaches it.
    pub fn set_head_to(&self, oid: Oid) {
        let name = self
            .repo
            .branches(Some(git2::BranchType::Local))
            .unwrap()
            .filter_map(|b| b.ok())
            .find(|(b, _)| b.get().target() == Some(oid))
            .and_then(|(b, _)| b.name().unwrap().map(str::to_string))
            .expect("no branch points at that commit");
        self.repo.set_head(&format!("refs/heads/{name}")).unwrap();
    }

    /// Create a parentless root on a distinctly named branch (a second history).
    pub fn commit_orphan(&self, summary: &str, branch: &str) -> Oid {
        let oid = self.commit(summary, &[]);
        let commit = self.repo.find_commit(oid).unwrap();
        self.repo.branch(branch, &commit, true).unwrap();
        oid
    }
}
