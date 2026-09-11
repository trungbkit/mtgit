//! Per-line blame for a file at a commit (or the working tree).
//!
//! Each line carries an `age` bucket as well as its commit, because the
//! heatmap gutter (G21) is a *per-file* ramp: the useful question is "which
//! lines in this file are the recent ones", not "how old is this line in
//! absolute terms". A file untouched for three years would be uniformly cold
//! on an absolute scale and tell the reader nothing.

use crate::error::{Error, Result};
use git2::{BlameOptions, Oid, Repository};
use serde::Serialize;
use std::path::Path;

const LARGE_FILE_BYTES: usize = 512 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_no: usize,
    pub oid: String,
    pub author: String,
    pub summary: String,
    pub timestamp: i64,
    pub content: String,
    /// Heatmap bucket, 0 (oldest change in this file) to 9 (newest). Lines
    /// with no blame hunk get 0.
    pub age: u8,
}

/// Blame `file`. When `at` (an oid) is given, blame is computed at that commit;
/// otherwise it blames up to the working tree.
pub fn blame_file(repo: &Repository, file: &str, at: Option<&str>) -> Result<Vec<BlameLine>> {
    let mut opts = BlameOptions::new();
    if let Some(a) = at {
        let oid = Oid::from_str(a).map_err(|_| Error::Msg(format!("bad oid: {a}")))?;
        opts.newest_commit(oid);
    }
    let blame = repo.blame_file(Path::new(file), Some(&mut opts))?;

    let content = read_content(repo, file, at)?;
    if content.len() > LARGE_FILE_BYTES {
        return Err(Error::Msg("file too large to blame".into()));
    }
    let text = String::from_utf8_lossy(&content);

    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line_no = i + 1;
        match blame.get_line(line_no) {
            Some(hunk) => {
                let commit_oid = hunk.final_commit_id();
                let (author, summary, timestamp) = match repo.find_commit(commit_oid) {
                    Ok(c) => (
                        c.author().name().unwrap_or("").to_string(),
                        c.summary().unwrap_or("").to_string(),
                        c.author().when().seconds(),
                    ),
                    Err(_) => (
                        hunk.final_signature().name().unwrap_or("").to_string(),
                        String::new(),
                        0,
                    ),
                };
                out.push(BlameLine {
                    line_no,
                    oid: commit_oid.to_string(),
                    author,
                    summary,
                    timestamp,
                    content: line.to_string(),
                    age: 0,
                });
            }
            None => out.push(BlameLine {
                line_no,
                oid: String::new(),
                author: String::new(),
                summary: String::new(),
                timestamp: 0,
                content: line.to_string(),
                age: 0,
            }),
        }
    }
    assign_age_buckets(&mut out);
    Ok(out)
}

/// Spread the file's own timestamp span over ten buckets.
///
/// Lines with no blame hunk carry `timestamp == 0` and are excluded from the
/// span — one of them would otherwise stretch the ramp back to 1970 and flatten
/// every real line into the coldest bucket.
fn assign_age_buckets(lines: &mut [BlameLine]) {
    let mut stamps = lines.iter().map(|l| l.timestamp).filter(|t| *t > 0);
    let Some(first) = stamps.next() else { return };
    let (min, max) = stamps.fold((first, first), |(lo, hi), t| (lo.min(t), hi.max(t)));

    for line in lines.iter_mut() {
        if line.timestamp <= 0 {
            continue;
        }
        line.age = if max == min {
            9
        } else {
            let span = (max - min) as f64;
            ((line.timestamp - min) as f64 / span * 9.0).round() as u8
        };
    }
}

fn read_content(repo: &Repository, file: &str, at: Option<&str>) -> Result<Vec<u8>> {
    match at {
        Some(a) => {
            let oid = Oid::from_str(a).map_err(|_| Error::Msg(format!("bad oid: {a}")))?;
            let commit = repo.find_commit(oid)?;
            let tree = commit.tree()?;
            let entry = tree
                .get_path(Path::new(file))
                .map_err(|_| Error::Msg(format!("file not found: {file}")))?;
            let obj = entry.to_object(repo)?;
            let blob = obj.as_blob().ok_or_else(|| Error::Msg("not a file blob".into()))?;
            Ok(blob.content().to_vec())
        }
        None => {
            let workdir = repo.workdir().ok_or_else(|| Error::Msg("bare repo".into()))?;
            Ok(std::fs::read(workdir.join(file))?)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    #[test]
    fn blame_returns_a_line_per_source_line() {
        let t = TestRepo::new();
        // TestRepo writes "<message>-<n>\n" into file.txt each commit.
        let a = t.commit("only", &[]);
        let lines = blame_file(&t.repo, "file.txt", Some(&a.to_string())).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].oid, a.to_string());
        assert_eq!(lines[0].line_no, 1);
    }

    /// The ramp is per-file, so the oldest surviving line is bucket 0 and the
    /// newest is bucket 9 whatever the absolute dates are.
    #[test]
    fn blame_age_buckets_span_the_files_own_history() {
        let t = TestRepo::new();
        let a = t.commit_files("old", &[], &[("f.txt", "old\n")]);
        let b = t.commit_files("new", &[a], &[("f.txt", "old\nnew\n")]);
        t.set_head_to(b);

        let lines = blame_file(&t.repo, "f.txt", Some(&b.to_string())).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].age, 0, "the line from the root commit is coldest");
        assert_eq!(lines[1].age, 9, "the line from the tip is hottest");
    }

    /// A line libgit2 could not attribute has timestamp 0; letting it into the
    /// span would drag the ramp back to the epoch and flatten the real lines.
    #[test]
    fn unattributed_lines_do_not_flatten_the_age_ramp() {
        let mut lines = vec![
            BlameLine { line_no: 1, oid: String::new(), author: String::new(), summary: String::new(), timestamp: 0, content: "?".into(), age: 0 },
            BlameLine { line_no: 2, oid: "x".into(), author: "a".into(), summary: String::new(), timestamp: 1_600_000_000, content: "a".into(), age: 0 },
            BlameLine { line_no: 3, oid: "y".into(), author: "b".into(), summary: String::new(), timestamp: 1_600_000_600, content: "b".into(), age: 0 },
        ];
        assign_age_buckets(&mut lines);
        assert_eq!(lines[0].age, 0);
        assert_eq!(lines[1].age, 0);
        assert_eq!(lines[2].age, 9);
    }
}
