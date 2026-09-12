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

/// Stash only what is staged (`01-commit.md` §3.2).
///
/// The one function here that shells out, because libgit2 has no equivalent of
/// `git stash push --staged`. The near miss is `StashFlags::KEEP_INDEX`, which
/// stashes *everything* and then puts the index back — leaving the working
/// tree clean and the staged changes still staged, which is the opposite of
/// what the panel header offers. `--staged` needs git 2.35; an older git
/// refuses by name, which is a better answer than silently stashing more than
/// was asked for.
pub fn save_staged(path: &str, message: Option<&str>) -> Result<()> {
    let mut args = vec!["stash", "push", "--staged"];
    if let Some(message) = message {
        args.push("-m");
        args.push(message);
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&args)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        let text = String::from_utf8_lossy(&output.stderr);
        Err(Error::Msg(text.trim().to_string()))
    }
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
