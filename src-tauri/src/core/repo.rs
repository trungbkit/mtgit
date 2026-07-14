use crate::error::{Error, Result};
use git2::Repository;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    /// Short branch name (e.g. "main"), or None when detached / unborn.
    pub branch: Option<String>,
    /// Full oid of HEAD, or None on an unborn branch (empty repo).
    pub oid: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Directory name of the working dir / repo root.
    pub name: String,
    /// Absolute path used as the handle for subsequent commands.
    pub path: String,
    pub head: HeadInfo,
    pub is_bare: bool,
}

/// Open a repository at `path` (searching upward for a `.git`) and return a
/// summary. `path` becomes the handle the frontend passes to every other
/// command.
pub fn open(path: &str) -> Result<RepoInfo> {
    let repo = Repository::discover(path)
        .map_err(|_| Error::Msg(format!("no git repository found at '{path}'")))?;

    let workdir = repo
        .workdir()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo.path().to_path_buf());

    let name = workdir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repository".to_string());

    let head = head_info(&repo);

    Ok(RepoInfo {
        name,
        path: workdir.to_string_lossy().into_owned(),
        head,
        is_bare: repo.is_bare(),
    })
}

pub fn head_info(repo: &Repository) -> HeadInfo {
    match repo.head() {
        Ok(reference) => {
            let detached = repo.head_detached().unwrap_or(false);
            let branch = if detached {
                None
            } else {
                reference.shorthand().map(str::to_string)
            };
            let oid = reference.target().map(|o| o.to_string());
            HeadInfo {
                branch,
                oid,
                detached,
                unborn: false,
            }
        }
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => HeadInfo {
            branch: reference_shorthand_from_unborn(repo),
            oid: None,
            detached: false,
            unborn: true,
        },
        Err(_) => HeadInfo {
            branch: None,
            oid: None,
            detached: false,
            unborn: true,
        },
    }
}

/// On an unborn branch `repo.head()` fails, but the symbolic ref still names
/// the branch that a first commit will create (usually "main"/"master").
fn reference_shorthand_from_unborn(repo: &Repository) -> Option<String> {
    let reference = repo.find_reference("HEAD").ok()?;
    let target = reference.symbolic_target()?;
    Some(target.strip_prefix("refs/heads/").unwrap_or(target).to_string())
}
