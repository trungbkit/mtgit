//! Per-line blame for a file at a commit (or the working tree).

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
                });
            }
            None => out.push(BlameLine {
                line_no,
                oid: String::new(),
                author: String::new(),
                summary: String::new(),
                timestamp: 0,
                content: line.to_string(),
            }),
        }
    }
    Ok(out)
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
}
