//! End-to-end smoke check of the read path against a real repository.
//!
//!   cargo run --example dump_graph -- /path/to/repo
//!
//! Prints layout timing plus the first rows with their lanes and ref badges,
//! so the graph can be eyeballed for correctness on real history.

use git2::Repository;
use mtgit_lib::core::{graph, refs};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let repo = Repository::discover(&path).expect("open repo");

    let t0 = Instant::now();
    let layouts = graph::layout(&repo).expect("layout");
    let layout_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let badges = refs::badges_by_oid(&repo);
    let rows = graph::build_rows(&repo, &layouts, &badges).expect("build rows");

    println!("repo:   {path}");
    println!("commits: {}", rows.len());
    println!("layout:  {layout_ms:.1} ms");

    let max_lane = rows.iter().map(|r| r.lane).max().unwrap_or(0);
    println!("max lane: {max_lane}");
    println!("---- first {} rows ----", rows.len().min(20));
    for r in rows.iter().take(20) {
        let refs_str = if r.refs.is_empty() {
            String::new()
        } else {
            let names: Vec<String> = r.refs.iter().map(|b| b.name.clone()).collect();
            format!("  [{}]", names.join(", "))
        };
        println!(
            "{}  lane {}  edges {}  {}{}",
            &r.oid[..8],
            r.lane,
            r.edges.len(),
            truncate(&r.summary, 50),
            refs_str
        );
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n - 1).collect();
        out.push('…');
        out
    }
}
