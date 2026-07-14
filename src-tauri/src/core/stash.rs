//! Stash save / list / apply / pop / drop.

use crate::error::{Error, Result};
use git2::{Repository, StashApplyOptions, StashFlags};
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

pub fn save(repo: &mut Repository, message: Option<&str>, include_untracked: bool) -> Result<String> {
    let sig = repo
        .signature()
        .map_err(|_| Error::Msg("no git identity configured".into()))?;
    let mut flags = StashFlags::DEFAULT;
    if include_untracked {
        flags |= StashFlags::INCLUDE_UNTRACKED;
    }
    let oid = repo.stash_save2(&sig, message, Some(flags))?;
    Ok(oid.to_string())
}

pub fn list(repo: &mut Repository) -> Result<Vec<StashEntry>> {
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        out.push(StashEntry { index, message: message.to_string(), oid: oid.to_string() });
        true
    })?;
    Ok(out)
}

pub fn apply(repo: &mut Repository, index: usize) -> Result<()> {
    let mut opts = StashApplyOptions::new();
    repo.stash_apply(index, Some(&mut opts))?;
    Ok(())
}

pub fn pop(repo: &mut Repository, index: usize) -> Result<()> {
    let mut opts = StashApplyOptions::new();
    repo.stash_pop(index, Some(&mut opts))?;
    Ok(())
}

pub fn drop(repo: &mut Repository, index: usize) -> Result<()> {
    repo.stash_drop(index)?;
    Ok(())
}
