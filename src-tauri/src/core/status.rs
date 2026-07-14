//! Working-tree status plus the stage / unstage / discard operations that feed
//! the staging view.

use crate::core::diff::FileStatus;
use crate::error::{Error, Result};
use git2::{Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub status: FileStatus,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub conflicted: Vec<StatusEntry>,
    /// True when the working tree has any change at all (drives the WIP row).
    pub is_dirty: bool,
}

pub fn status(repo: &Repository) -> Result<StatusReport> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo.statuses(Some(&mut opts))?;
    let mut report = StatusReport::default();

    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }

        if s.contains(Status::CONFLICTED) {
            report.conflicted.push(StatusEntry { path: path.clone(), status: FileStatus::Conflicted });
            continue;
        }

        if let Some(st) = index_status(s) {
            report.staged.push(StatusEntry { path: path.clone(), status: st });
        }
        if let Some(st) = worktree_status(s) {
            report.unstaged.push(StatusEntry { path, status: st });
        }
    }

    report.is_dirty =
        !(report.staged.is_empty() && report.unstaged.is_empty() && report.conflicted.is_empty());
    report.staged.sort_by(|a, b| a.path.cmp(&b.path));
    report.unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(report)
}

fn index_status(s: Status) -> Option<FileStatus> {
    if s.contains(Status::INDEX_NEW) {
        Some(FileStatus::Added)
    } else if s.contains(Status::INDEX_MODIFIED) {
        Some(FileStatus::Modified)
    } else if s.contains(Status::INDEX_DELETED) {
        Some(FileStatus::Deleted)
    } else if s.contains(Status::INDEX_RENAMED) {
        Some(FileStatus::Renamed)
    } else if s.contains(Status::INDEX_TYPECHANGE) {
        Some(FileStatus::Typechange)
    } else {
        None
    }
}

fn worktree_status(s: Status) -> Option<FileStatus> {
    if s.contains(Status::WT_NEW) {
        Some(FileStatus::Untracked)
    } else if s.contains(Status::WT_MODIFIED) {
        Some(FileStatus::Modified)
    } else if s.contains(Status::WT_DELETED) {
        Some(FileStatus::Deleted)
    } else if s.contains(Status::WT_RENAMED) {
        Some(FileStatus::Renamed)
    } else if s.contains(Status::WT_TYPECHANGE) {
        Some(FileStatus::Typechange)
    } else {
        None
    }
}

/// Stage each path: add new/modified content, or record deletions.
pub fn stage_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    let mut index = repo.index()?;
    let workdir = repo.workdir().ok_or_else(|| Error::Msg("bare repo".into()))?;
    for p in paths {
        let rel = Path::new(p);
        if workdir.join(rel).exists() {
            index.add_path(rel)?;
        } else {
            index.remove_path(rel)?;
        }
    }
    index.write()?;
    Ok(())
}

/// Unstage each path (reset its index entry to HEAD, or drop it when unborn).
pub fn unstage_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    match repo.head() {
        Ok(head) => {
            let obj = head.peel_to_commit()?.into_object();
            repo.reset_default(Some(&obj), paths.iter())?;
        }
        Err(_) => {
            let mut index = repo.index()?;
            for p in paths {
                let _ = index.remove_path(Path::new(p));
            }
            index.write()?;
        }
    }
    Ok(())
}

/// Discard working-tree changes for each path. Tracked files are checked out
/// from HEAD; untracked files are deleted.
pub fn discard_paths(repo: &Repository, paths: &[String]) -> Result<()> {
    let workdir = repo.workdir().ok_or_else(|| Error::Msg("bare repo".into()))?;

    // Untracked files won't be touched by checkout_head, so remove them here.
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    let mut any_checkout = false;

    for p in paths {
        let is_untracked = statuses
            .iter()
            .any(|e| e.path() == Some(p.as_str()) && e.status().contains(Status::WT_NEW));
        if is_untracked {
            let _ = std::fs::remove_file(workdir.join(p));
        } else {
            checkout.path(p);
            any_checkout = true;
        }
    }

    if any_checkout {
        repo.checkout_head(Some(&mut checkout))?;
    }
    Ok(())
}
