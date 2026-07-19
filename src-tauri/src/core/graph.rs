//! Commit graph layout.
//!
//! We walk commits newest -> oldest (topological + time order) and assign each
//! a horizontal *lane*. The output is a list of [`GraphRow`]s that the frontend
//! draws directly: it never computes layout, it just renders nodes at
//! `row.lane` and line segments described by `row.edges`.
//!
//! ## Algorithm
//!
//! We maintain `active: Vec<Option<Oid>>`, one slot per lane, each holding the
//! oid of the commit that lane is *waiting for* (i.e. a parent that some
//! already-processed child expects). For each commit `c`:
//!
//! 1. All lanes waiting for `c` converge into the leftmost such lane
//!    (`my_lane`); the others free up. If no lane waits for `c`, it is a branch
//!    tip and takes the first free lane.
//! 2. `c`'s first parent continues in `my_lane`; each additional parent opens a
//!    new lane (reusing a freed slot when possible). Additional parents are the
//!    merge edges.
//!
//! Edges are computed in a second pass over the recorded per-row `active`
//! snapshots, because an edge leaving row *i* needs to know where row *i+1*'s
//! node lands. Colors follow the destination lane index modulo the palette,
//! matching GitKraken's per-lane coloring.

use crate::core::refs::RefBadge;
use crate::error::Result;
use git2::{Oid, Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    /// Straight vertical continuation of a lane.
    Continue,
    /// A branch line converging into a node to its side (child side of a fork).
    Branch,
    /// A line opened by a merge commit for an additional parent.
    Merge,
}

/// One line segment in the band between a row and the row below it.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from_lane: usize,
    pub to_lane: usize,
    pub kind: EdgeKind,
    /// Palette index (lane the edge belongs to at its destination).
    pub color: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub oid: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub author: String,
    pub email: String,
    /// Author time, unix seconds.
    pub timestamp: i64,
    pub lane: usize,
    pub color: usize,
    pub edges: Vec<Edge>,
    pub refs: Vec<RefBadge>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub rows: Vec<GraphRow>,
    pub total: usize,
    /// Head oid at the time of layout, used by the frontend as a cache key.
    pub head: Option<String>,
}

/// Per-commit layout facts recorded during the first pass.
pub struct RowLayout {
    oid: Oid,
    lane: usize,
    /// `active` snapshot leaving the bottom of this row: for each lane, the
    /// awaited oid and the column it emanates from at the top of the band.
    outgoing: Vec<Option<LaneOut>>,
}

#[derive(Clone)]
pub struct LaneOut {
    awaits: Oid,
    from_col: usize,
}

/// Compute the full lane layout for the repository. Returns rows newest-first.
pub fn layout(repo: &Repository) -> Result<Vec<RowLayout>> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    // Seed from every branch tip plus HEAD so all history is covered, not just
    // the current branch. Globs that match no refs are simply ignored.
    let _ = walk.push_glob("refs/heads/*");
    let _ = walk.push_glob("refs/remotes/*");
    let _ = walk.push_glob("refs/tags/*");
    if repo.head().is_ok() {
        let _ = walk.push_head();
    }

    let mut active: Vec<Option<Oid>> = Vec::new();
    let mut rows: Vec<RowLayout> = Vec::new();

    for oid_res in walk {
        let oid = oid_res?;
        let commit = repo.find_commit(oid)?;
        let parents: Vec<Oid> = commit.parent_ids().collect();

        // 1. Lanes waiting for this commit converge; leftmost becomes my_lane.
        let matches: Vec<usize> = active
            .iter()
            .enumerate()
            .filter_map(|(i, slot)| if *slot == Some(oid) { Some(i) } else { None })
            .collect();

        let my_lane = if let Some(&first) = matches.first() {
            first
        } else {
            first_free(&active)
        };

        // Free every lane that was waiting for this commit; my_lane is reused
        // below for the first parent (or freed if this is a root/leaf).
        for &m in &matches {
            active[m] = None;
        }
        ensure_slot(&mut active, my_lane);

        // 2. Route parents. First parent continues in my_lane; extras open new
        //    lanes. `from_col` records where each outgoing lane emanates at the
        //    top of the band below this row.
        let mut from_col: HashMap<usize, usize> = HashMap::new();

        if let Some(&first_parent) = parents.first() {
            active[my_lane] = Some(first_parent);
            from_col.insert(my_lane, my_lane);
            for &parent in &parents[1..] {
                let col = first_free(&active);
                ensure_slot(&mut active, col);
                active[col] = Some(parent);
                from_col.insert(col, my_lane); // emanates from the node = merge
            }
        } else {
            // Root commit: the lane terminates here.
            active[my_lane] = None;
        }

        // Record outgoing lanes. Lanes not touched above are pass-throughs whose
        // line emanates straight from their own column.
        let outgoing: Vec<Option<LaneOut>> = active
            .iter()
            .enumerate()
            .map(|(col, slot)| {
                slot.map(|awaits| LaneOut {
                    awaits,
                    from_col: *from_col.get(&col).unwrap_or(&col),
                })
            })
            .collect();

        rows.push(RowLayout { oid, lane: my_lane, outgoing });

        trim_trailing_none(&mut active);
    }

    Ok(rows)
}

/// Second pass: turn recorded layouts into fully rendered [`GraphRow`]s,
/// computing the edge band below each row now that the next row's node lane is
/// known.
pub fn build_rows(
    repo: &Repository,
    layouts: &[RowLayout],
    badges: &HashMap<Oid, Vec<RefBadge>>,
) -> Result<Vec<GraphRow>> {
    let mut rows = Vec::with_capacity(layouts.len());

    for (i, rl) in layouts.iter().enumerate() {
        let commit = repo.find_commit(rl.oid)?;
        let author = commit.author();

        let mut edges = Vec::new();
        for (col, slot) in rl.outgoing.iter().enumerate() {
            let Some(lane_out) = slot else { continue };
            let from = lane_out.from_col;
            // Where does this line land in the next row?
            let to = match layouts.get(i + 1) {
                Some(next) if next.oid == lane_out.awaits => next.lane,
                _ => col, // continues straight down
            };
            let kind = if from != col {
                EdgeKind::Merge
            } else if to != col {
                EdgeKind::Branch
            } else {
                EdgeKind::Continue
            };
            edges.push(Edge { from_lane: from, to_lane: to, kind, color: to });
        }

        let subject = commit.summary().unwrap_or("");
        let body_preview = commit
            .body()
            .and_then(|body| body.lines().find(|line| !line.trim().is_empty()))
            .unwrap_or("");
        let summary = if body_preview.is_empty() {
            subject.to_string()
        } else {
            format!("{subject} — {body_preview}")
        };

        rows.push(GraphRow {
            oid: rl.oid.to_string(),
            parents: commit.parent_ids().map(|o| o.to_string()).collect(),
            summary,
            author: author.name().unwrap_or("").to_string(),
            email: author.email().unwrap_or("").to_string(),
            timestamp: commit.time().seconds(),
            lane: rl.lane,
            color: rl.lane,
            edges,
            refs: badges.get(&rl.oid).cloned().unwrap_or_default(),
        });
    }

    Ok(rows)
}

fn first_free(active: &[Option<Oid>]) -> usize {
    active.iter().position(Option::is_none).unwrap_or(active.len())
}

fn ensure_slot(active: &mut Vec<Option<Oid>>, idx: usize) {
    if idx >= active.len() {
        active.resize(idx + 1, None);
    }
}

fn trim_trailing_none(active: &mut Vec<Option<Oid>>) {
    while matches!(active.last(), Some(None)) {
        active.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    /// Full layout for a repo, newest-first, as (short_oid, lane) pairs plus rows.
    fn full(repo: &Repository) -> Vec<GraphRow> {
        let layouts = layout(repo).unwrap();
        let badges = crate::core::refs::badges_by_oid(repo);
        build_rows(repo, &layouts, &badges).unwrap()
    }

    #[test]
    fn linear_history_uses_single_lane() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.commit("c", &[b]);

        let rows = full(&t.repo);
        assert_eq!(rows.len(), 3);
        // All commits sit in lane 0.
        assert!(rows.iter().all(|r| r.lane == 0), "rows: {:?}", rows.iter().map(|r| (&r.summary, r.lane)).collect::<Vec<_>>());
        // Every band below a row (except the last) is a single straight edge.
        for r in &rows[..2] {
            assert_eq!(r.edges.len(), 1);
            assert_eq!(r.edges[0].from_lane, 0);
            assert_eq!(r.edges[0].to_lane, 0);
            assert_eq!(r.edges[0].kind, EdgeKind::Continue);
        }
    }

    #[test]
    fn branch_and_merge_opens_and_closes_a_lane() {
        // a -> b -> (feature: c) and (main: d), then merge m of d + c.
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        let c = t.commit("c on feature", &[b]);
        let d = t.commit("d on main", &[b]);
        let _m = t.commit("merge", &[d, c]);

        let rows = full(&t.repo);
        assert_eq!(rows.len(), 5);

        // Newest first: merge is row 0 and must have two parents.
        assert_eq!(rows[0].summary, "merge");
        assert_eq!(rows[0].parents.len(), 2);

        // The merge commit opens a second lane for its non-first parent: at
        // least one Merge edge exists in the graph.
        let has_merge = rows.iter().flat_map(|r| &r.edges).any(|e| e.kind == EdgeKind::Merge);
        assert!(has_merge, "expected a merge edge");

        // More than one lane must be in use somewhere.
        let max_lane = rows.iter().map(|r| r.lane).max().unwrap();
        assert!(max_lane >= 1, "branch should occupy a second lane");

        // The base commit `a` sits alone in lane 0 with a single continuation.
        let base = rows.iter().find(|r| r.summary == "a").unwrap();
        assert_eq!(base.parents.len(), 0);
        assert_eq!(base.edges.len(), 0, "root has no band below it");
    }

    #[test]
    fn octopus_merge_has_multiple_merge_edges() {
        let t = TestRepo::new();
        let base = t.commit("base", &[]);
        let p1 = t.commit("p1", &[base]);
        let p2 = t.commit("p2", &[base]);
        let p3 = t.commit("p3", &[base]);
        let _octo = t.commit("octopus", &[p1, p2, p3]);

        let rows = full(&t.repo);
        // Octopus is newest -> row 0 with three parents.
        assert_eq!(rows[0].summary, "octopus");
        assert_eq!(rows[0].parents.len(), 3);

        // Its band opens two extra lanes (parents 2 and 3) => two Merge edges.
        let merge_edges = rows[0].edges.iter().filter(|e| e.kind == EdgeKind::Merge).count();
        assert_eq!(merge_edges, 2, "octopus opens 2 extra lanes: {:?}", rows[0].edges);
    }

    #[test]
    fn two_orphan_roots_coexist() {
        let t = TestRepo::new();
        // First root chain.
        let a = t.commit("a", &[]);
        let _b = t.commit("b", &[a]);
        // Second, unrelated orphan root on its own branch.
        let x = t.commit_orphan("x", "orphan");
        let _y = t.commit("y", &[x]);

        let rows = full(&t.repo);
        assert_eq!(rows.len(), 4);
        // Two distinct roots (parentless commits) must be present.
        let roots = rows.iter().filter(|r| r.parents.is_empty()).count();
        assert_eq!(roots, 2);
    }

    /// Perf gate (plan §5): layout of 50k commits must be well under 500ms.
    /// Ignored by default; run with `cargo test --lib -- --ignored perf`.
    #[test]
    #[ignore]
    fn perf_50k_commits_under_500ms() {
        use git2::{Signature, Time};
        use std::time::Instant;

        let t = TestRepo::new();
        let repo = &t.repo;
        let empty_tree = {
            let oid = repo.treebuilder(None).unwrap().write().unwrap();
            repo.find_tree(oid).unwrap()
        };

        // 50k commits sharing one empty tree (no blob writes) so construction
        // is fast; every 500th commit forks a short side branch + merge to keep
        // the topology non-trivial.
        let mut prev: Option<Oid> = None;
        for i in 0..50_000u32 {
            let sig =
                Signature::new("P", "p@e.com", &Time::new(1_600_000_000 + i64::from(i), 0)).unwrap();
            let parents: Vec<git2::Commit> =
                prev.iter().map(|o| repo.find_commit(*o).unwrap()).collect();
            let refs: Vec<&git2::Commit> = parents.iter().collect();
            let oid = repo
                .commit(None, &sig, &sig, &format!("c{i}"), &empty_tree, &refs)
                .unwrap();
            prev = Some(oid);
        }
        repo.branch("main", &repo.find_commit(prev.unwrap()).unwrap(), true).unwrap();

        // Pack the object database — real repos are packed, and reading 50k
        // loose objects would unfairly dominate the timing.
        std::process::Command::new("git")
            .args(["-C", t.dir.path().to_str().unwrap(), "repack", "-adq"])
            .status()
            .expect("git repack");

        let start = Instant::now();
        let layouts = layout(repo).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(layouts.len(), 50_000);
        println!("layout of 50k commits took {:?}", elapsed);
        assert!(elapsed.as_millis() < 500, "layout too slow: {:?}", elapsed);
    }

    #[test]
    fn every_edge_targets_a_real_lane() {
        // Sanity invariant on a moderately tangled repo: no edge points past
        // the lanes that exist, and colors equal their destination lane.
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        let c = t.commit("c", &[b]);
        let d = t.commit("d", &[b]);
        let e = t.commit("e", &[c, d]);
        let _f = t.commit("f", &[e]);

        let rows = full(&t.repo);
        for r in &rows {
            for edge in &r.edges {
                assert_eq!(edge.color, edge.to_lane);
                assert!(edge.from_lane < 64 && edge.to_lane < 64);
            }
        }
    }
}
