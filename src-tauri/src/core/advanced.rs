//! Git features whose semantics are best delegated to the system `git`.
//!
//! libgit2 remains the fast read path for the graph, status, and diffs.  This
//! module drives sequencer operations so hooks, signing, autostash, conflict
//! metadata, and user git configuration behave exactly like the command line.

use crate::error::{Error, Result};
use crate::core::branch::{MergeKind, MergeMode, MergeResult};
use git2::{Repository, RepositoryState};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub success: bool,
    pub code: Option<i32>,
    pub output: String,
    pub oid: Option<String>,
    pub conflicts: Vec<String>,
    pub skipped: usize,
    /// The operation stashed the working tree to get started
    /// (`07-cherry-pick.md` B4). Always false for operations that pass
    /// `--autostash` to git, which restores it itself.
    pub auto_stashed: bool,
    /// The stash was kept rather than popped — either popping conflicted, or
    /// the operation paused and popping into a conflicted index would bury
    /// the user's own work under the sequencer's.
    pub stash_kept: bool,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum CheckoutRecovery {
    Normal,
    Stash,
    Discard,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResult {
    pub branch: Option<String>,
    pub detached: bool,
    pub auto_stashed: bool,
    pub stash_conflicts: bool,
    pub previous_head: String,
    pub submodules_changed: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanItem {
    pub oid: String,
    pub action: RebaseAction,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RebaseAction {
    Pick,
    Reword,
    Squash,
    Fixup,
    Drop,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RewriteInfo {
    pub commits: usize,
    pub pushed: usize,
    pub merges: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub oid: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    /// A merge commit, which an interactive rebase flattens rather than
    /// replays. Reported rather than filtered out (`06-rebase.md` §7): a plan
    /// that silently omits three of the seven commits you selected is a plan
    /// that does not describe what is about to happen.
    pub is_merge: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OperationInfo {
    pub kind: String,
    pub conflicts: Vec<String>,
    pub current_sha: Option<String>,
    pub current: usize,
    pub total: usize,
    pub can_continue: bool,
    pub can_skip: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub ours: String,
    pub theirs: String,
    pub output: String,
    pub binary: bool,
}

fn output_text(output: &Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    text.trim().to_string()
}

fn git_output(path: &str, args: &[&str]) -> Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| Error::Msg(format!("failed to launch git: {e}")))
}

fn git_text(path: &str, args: &[&str]) -> Result<String> {
    let output = git_output(path, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(Error::Msg(output_text(&output)))
    }
}

fn command_result(path: &str, output: Output) -> Result<CommandResult> {
    let repo = Repository::discover(path)?;
    let conflicts = crate::core::ops::conflict_paths(&repo.index()?);
    let oid = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .map(|oid| oid.to_string());
    Ok(CommandResult {
        success: output.status.success(),
        code: output.status.code(),
        output: output_text(&output),
        oid,
        conflicts,
        skipped: 0,
        auto_stashed: false,
        stash_kept: false,
    })
}

fn git_dir(path: &str) -> Result<PathBuf> {
    let raw = git_text(path, &["rev-parse", "--git-dir"])?;
    let dir = PathBuf::from(raw);
    if dir.is_absolute() {
        Ok(dir)
    } else {
        Ok(Path::new(path).join(dir))
    }
}

pub fn commit_cli(
    path: &str,
    summary: &str,
    description: &str,
    amend: bool,
    no_verify: bool,
) -> Result<CommandResult> {
    let mut args = vec!["commit", "-m", summary];
    if !description.trim().is_empty() {
        args.extend(["-m", description]);
    }
    if amend {
        args.push("--amend");
    }
    if no_verify {
        args.push("--no-verify");
    }
    let output = git_output(path, &args)?;
    command_result(path, output)
}

pub fn head_message(path: &str) -> Result<String> {
    git_text(path, &["log", "-1", "--format=%B"])
}

pub fn set_upstream(path: &str, local: &str, upstream: &str) -> Result<()> {
    git_text(
        path,
        &["branch", &format!("--set-upstream-to={upstream}"), local],
    )?;
    Ok(())
}

/// Drop a branch's upstream configuration (STATUS C8).
///
/// `--unset-upstream` rather than deleting the config keys by hand: git also
/// clears `branch.<name>.rebase` and friends, and reproducing that list here
/// would rot the first time git adds to it.
pub fn unset_upstream(path: &str, local: &str) -> Result<()> {
    git_text(path, &["branch", "--unset-upstream", local])?;
    Ok(())
}

pub fn update_submodules(path: &str) -> Result<()> {
    git_text(path, &["submodule", "update", "--init", "--recursive"])?;
    Ok(())
}

pub fn checkout(
    path: &str,
    target: &str,
    recovery: CheckoutRecovery,
    local_override: Option<&str>,
) -> Result<CheckoutResult> {
    let previous_head = git_text(path, &["rev-parse", "--symbolic-full-name", "--verify", "-q", "HEAD"])
        .or_else(|_| git_text(path, &["rev-parse", "HEAD"]))?;
    let submodules_before = git_text(path, &["submodule", "status"]).unwrap_or_default();
    let mut auto_stashed = false;

    match recovery {
        CheckoutRecovery::Normal => {}
        CheckoutRecovery::Stash => {
            let status = git_text(path, &["status", "--porcelain"])?;
            if !status.is_empty() {
                let out = git_output(
                    path,
                    &["stash", "push", "--include-untracked", "-m", "MTGit automatic checkout stash"],
                )?;
                if !out.status.success() {
                    return Err(Error::Msg(output_text(&out)));
                }
                auto_stashed = true;
            }
        }
        CheckoutRecovery::Discard => {
            let out = git_output(path, &["reset", "--hard", "HEAD"])?;
            if !out.status.success() {
                return Err(Error::Msg(output_text(&out)));
            }
            let out = git_output(path, &["clean", "-fd"])?;
            if !out.status.success() {
                return Err(Error::Msg(output_text(&out)));
            }
        }
    }

    let repo = Repository::discover(path)?;
    let is_remote = repo
        .find_branch(target, git2::BranchType::Remote)
        .is_ok();
    let output = if target == "@{-1}" {
        git_output(path, &["checkout", target])?
    } else if is_remote {
        let local = local_override.unwrap_or_else(|| target.split_once('/').map(|(_, n)| n).unwrap_or(target));
        if let Ok(existing) = repo.find_branch(local, git2::BranchType::Local) {
            let upstream = existing
                .upstream()
                .ok()
                .and_then(|branch| branch.name().ok().flatten().map(str::to_string));
            if local_override.is_none() && upstream.as_deref().is_some_and(|name| name != target) {
                return Err(Error::Msg(format!(
                    "REMOTE_NAME_CONFLICT|{local}|{target}|{}",
                    upstream.unwrap_or_default()
                )));
            }
            git_output(path, &["switch", local])?
        } else {
            git_output(path, &["switch", "--track", "-c", local, target])?
        }
    } else if repo.find_branch(target, git2::BranchType::Local).is_ok() {
        git_output(path, &["switch", target])?
    } else {
        git_output(path, &["checkout", "--detach", target])?
    };

    if !output.status.success() {
        if auto_stashed {
            let _ = git_output(path, &["stash", "pop"]);
        }
        return Err(Error::Msg(output_text(&output)));
    }

    let mut stash_conflicts = false;
    if auto_stashed {
        let pop = git_output(path, &["stash", "pop"])?;
        stash_conflicts = !pop.status.success();
    }

    let branch = git_text(path, &["branch", "--show-current"]).unwrap_or_default();
    Ok(CheckoutResult {
        branch: if branch.is_empty() { None } else { Some(branch) },
        detached: git_text(path, &["symbolic-ref", "-q", "HEAD"]).is_err(),
        auto_stashed,
        stash_conflicts,
        previous_head,
        submodules_changed: submodules_before
            != git_text(path, &["submodule", "status"]).unwrap_or_default(),
    })
}

/// Cherry-pick one or more commits.
///
/// `stash_fallback` is `07-cherry-pick.md` B4. `git cherry-pick` has no
/// `--autostash`, so a dirty tree it refuses has to be stashed and restored
/// around the pick by hand — and the interesting half is *when not to
/// restore*. Three outcomes, three answers:
///
/// * the pick **succeeds** — pop, and report it if the pop conflicts;
/// * the pick **fails outright** — pop, so a refusal leaves the tree exactly
///   as it was found;
/// * the pick **pauses on a conflict** — keep the stash. Popping into a
///   conflicted index mixes the user's uncommitted work into the sequencer's
///   conflict markers, and no later `--abort` would separate them again.
pub fn cherry_pick_many(
    path: &str,
    oids: &[String],
    commit_immediately: bool,
    mainline: Option<usize>,
    append_origin: bool,
    stash_fallback: bool,
) -> Result<CommandResult> {
    if oids.is_empty() {
        return Err(Error::Msg("select at least one commit".into()));
    }
    let mut auto_stashed = false;
    if stash_fallback && !git_text(path, &["status", "--porcelain"])?.is_empty() {
        let out = git_output(
            path,
            &["stash", "push", "--include-untracked", "-m", "MTGit automatic cherry-pick stash"],
        )?;
        if !out.status.success() {
            return Err(Error::Msg(output_text(&out)));
        }
        auto_stashed = true;
    }
    let mut owned = vec!["cherry-pick".to_string()];
    if !commit_immediately {
        owned.push("--no-commit".into());
    }
    if append_origin {
        owned.push("-x".into());
    }
    if let Some(parent) = mainline {
        owned.push("-m".into());
        owned.push(parent.to_string());
    }
    owned.extend(oids.iter().cloned());
    let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
    let output = git_output(path, &refs)?;
    let lower_output = output_text(&output).to_lowercase();
    let empty = !output.status.success()
        && ["empty", "nothing to commit", "already applied"]
            .iter()
            .any(|needle| lower_output.contains(needle));
    let mut result = command_result(path, output)?;
    if empty && commit_immediately {
        let skipped = git_output(path, &["cherry-pick", "--skip"])?;
        result = command_result(path, skipped)?;
        result.skipped = 1;
        if result.success {
            result.output = "Commit skipped — change already applied".into();
        }
    }
    if !result.success && !result.conflicts.is_empty() {
        write_sequence_meta(path, "cherryPick", oids.len(), 1, oids.first().cloned())?;
    }
    if auto_stashed {
        result.auto_stashed = true;
        if !result.success && !result.conflicts.is_empty() {
            result.stash_kept = true;
        } else {
            let pop = git_output(path, &["stash", "pop"])?;
            result.stash_kept = !pop.status.success();
        }
    }
    Ok(result)
}

pub fn rewrite_info(path: &str, base: &str) -> Result<RewriteInfo> {
    let commits = git_text(path, &["rev-list", "--count", &format!("{base}..HEAD")])?
        .parse()
        .unwrap_or(0);
    let merges = git_text(path, &["rev-list", "--count", "--merges", &format!("{base}..HEAD")])?
        .parse()
        .unwrap_or(0);
    let pushed = git_text(path, &["rev-list", &format!("{base}..HEAD")])
        .unwrap_or_default()
        .lines()
        .filter(|oid| {
            git_text(path, &["branch", "-r", "--contains", oid])
                .map(|text| !text.trim().is_empty())
                .unwrap_or(false)
        })
        .count();
    Ok(RewriteInfo { commits, pushed, merges })
}

pub fn rebase_commits(path: &str, base: &str) -> Result<Vec<RebaseCommit>> {
    let raw = git_text(
        path,
        &[
            "log",
            "--reverse",
            "--format=%H%x00%P%x00%an%x00%ae%x00%s",
            &format!("{base}..HEAD"),
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(5, '\0');
            let oid = fields.next()?;
            let parents = fields.next()?;
            let author = fields.next()?;
            let email = fields.next()?;
            let summary = fields.next()?;
            Some(RebaseCommit {
                oid: oid.to_string(),
                summary: summary.to_string(),
                author: author.to_string(),
                email: email.to_string(),
                is_merge: parents.split_whitespace().count() > 1,
            })
        })
        .collect())
}

pub fn standard_rebase(path: &str, onto: &str) -> Result<CommandResult> {
    let total = git_text(path, &["rev-list", "--count", &format!("{onto}..HEAD")])
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(1);
    let output = git_output(path, &["rebase", "--autostash", onto])?;
    let result = command_result(path, output)?;
    if !result.success && !result.conflicts.is_empty() {
        write_sequence_meta(path, "rebase", total, 1, None)?;
    }
    Ok(result)
}

pub fn merge(path: &str, their_ref: &str, mode: MergeMode) -> Result<MergeResult> {
    let before = git_text(path, &["rev-parse", "HEAD"])?;
    let mut args = vec!["merge", "--autostash", "--no-edit"];
    match mode {
        MergeMode::Default => {}
        MergeMode::FfOnly => args.push("--ff-only"),
        MergeMode::NoFf => args.push("--no-ff"),
    }
    args.push(their_ref);
    let output = git_output(path, &args)?;
    let repo = Repository::discover(path)?;
    let conflicts = crate::core::ops::conflict_paths(&repo.index()?);
    if !output.status.success() {
        if !conflicts.is_empty() {
            return Ok(MergeResult {
                kind: MergeKind::Conflicts,
                conflicts,
                oid: None,
            });
        }
        return Err(Error::Msg(output_text(&output)));
    }
    let after = git_text(path, &["rev-parse", "HEAD"])?;
    let kind = if before == after {
        MergeKind::UpToDate
    } else if mode != MergeMode::NoFf
        && git_text(path, &["rev-list", "--parents", "-n", "1", "HEAD"])?
            .split_whitespace()
            .count()
            == 2
    {
        MergeKind::FastForward
    } else {
        MergeKind::Normal
    };
    Ok(MergeResult {
        kind,
        conflicts: vec![],
        oid: Some(after),
    })
}

pub fn interactive_rebase(
    path: &str,
    base: &str,
    plan: &[RebasePlanItem],
) -> Result<CommandResult> {
    if plan.is_empty() {
        return Err(Error::Msg("the rebase plan is empty".into()));
    }
    if matches!(
        plan.first().map(|p| p.action),
        Some(RebaseAction::Squash | RebaseAction::Fixup)
    ) {
        return Err(Error::Msg("the oldest commit cannot be squashed or fixed up".into()));
    }

    let dir = git_dir(path)?.join("mtgit-rebase");
    fs::create_dir_all(&dir)?;
    let todo_path = dir.join("todo");
    let editor_path = dir.join("sequence-editor.sh");
    let mut todo = String::new();

    for (idx, item) in plan.iter().enumerate() {
        let subject = git_text(path, &["show", "-s", "--format=%s", &item.oid])
            .unwrap_or_else(|_| item.oid.clone());
        match item.action {
            RebaseAction::Pick | RebaseAction::Reword => {
                todo.push_str(&format!("pick {} {}\n", item.oid, subject));
                if item.action == RebaseAction::Reword {
                    let msg_path = dir.join(format!("message-{idx}.txt"));
                    fs::write(&msg_path, item.message.clone().unwrap_or(subject))?;
                    todo.push_str(&format!(
                        "exec git commit --amend --no-verify -F \"{}\"\n",
                        msg_path.display()
                    ));
                }
            }
            RebaseAction::Squash => todo.push_str(&format!("squash {} {}\n", item.oid, subject)),
            RebaseAction::Fixup => todo.push_str(&format!("fixup {} {}\n", item.oid, subject)),
            RebaseAction::Drop => todo.push_str(&format!("drop {} {}\n", item.oid, subject)),
        }
    }
    fs::write(&todo_path, todo)?;
    fs::write(
        &editor_path,
        "#!/bin/sh\ncp \"$MTGIT_REBASE_TODO\" \"$1\"\n",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&editor_path, fs::Permissions::from_mode(0o700))?;
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rebase", "-i", base])
        .env("GIT_SEQUENCE_EDITOR", &editor_path)
        .env("GIT_EDITOR", "true")
        .env("MTGIT_REBASE_TODO", &todo_path)
        .output()
        .map_err(|e| Error::Msg(format!("failed to launch git: {e}")))?;
    let result = command_result(path, output)?;
    if !result.success && (!result.conflicts.is_empty() || Repository::discover(path)?.state() != RepositoryState::Clean) {
        write_sequence_meta(path, "rebase", plan.len(), 1, plan.first().map(|p| p.oid.clone()))?;
    } else {
        clear_sequence_meta(path);
    }
    Ok(result)
}

pub fn operation_info(path: &str) -> Result<Option<OperationInfo>> {
    let repo = Repository::discover(path)?;
    let state = repo.state();
    if state == RepositoryState::Clean {
        return Ok(None);
    }
    let kind = match state {
        RepositoryState::Merge => "merge",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "rebase",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherryPick",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        _ => "operation",
    }
    .to_string();
    let conflicts = crate::core::ops::conflict_paths(&repo.index()?);
    let meta = read_sequence_meta(path).unwrap_or_default();
    let current_sha = if kind == "cherryPick" {
        git_text(path, &["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).ok()
    } else if kind == "rebase" {
        git_dir(path)
            .ok()
            .and_then(|d| fs::read_to_string(d.join("rebase-merge/stopped-sha")).ok())
            .map(|s| s.trim().to_string())
    } else {
        None
    };
    Ok(Some(OperationInfo {
        kind: kind.clone(),
        conflicts,
        current_sha: current_sha.or(meta.sha),
        current: meta.current.max(1),
        total: meta.total.max(1),
        can_continue: true,
        can_skip: matches!(kind.as_str(), "rebase" | "cherryPick" | "revert"),
    }))
}

pub fn operation_continue(path: &str) -> Result<CommandResult> {
    let info = operation_info(path)?.ok_or_else(|| Error::Msg("no operation is in progress".into()))?;
    let args = match info.kind.as_str() {
        "merge" => vec!["commit", "--no-edit"],
        "rebase" => vec!["rebase", "--continue"],
        "cherryPick" => vec!["cherry-pick", "--continue"],
        "revert" => vec!["revert", "--continue"],
        _ => return Err(Error::Msg("this operation cannot be continued".into())),
    };
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(&args)
        .env("GIT_EDITOR", "true")
        .output()?;
    let result = command_result(path, output)?;
    if result.success {
        clear_sequence_meta(path);
    } else {
        bump_sequence_meta(path);
    }
    Ok(result)
}

pub fn operation_skip(path: &str) -> Result<CommandResult> {
    let info = operation_info(path)?.ok_or_else(|| Error::Msg("no operation is in progress".into()))?;
    let args = match info.kind.as_str() {
        "rebase" => vec!["rebase", "--skip"],
        "cherryPick" => vec!["cherry-pick", "--skip"],
        "revert" => vec!["revert", "--skip"],
        _ => return Err(Error::Msg("this operation cannot skip a commit".into())),
    };
    let output = git_output(path, &args)?;
    let mut result = command_result(path, output)?;
    result.skipped = 1;
    if result.success {
        clear_sequence_meta(path);
    } else {
        bump_sequence_meta(path);
    }
    Ok(result)
}

pub fn operation_abort(path: &str) -> Result<()> {
    let info = operation_info(path)?.ok_or_else(|| Error::Msg("no operation is in progress".into()))?;
    let args = match info.kind.as_str() {
        "merge" => vec!["merge", "--abort"],
        "rebase" => vec!["rebase", "--abort"],
        "cherryPick" => vec!["cherry-pick", "--abort"],
        "revert" => vec!["revert", "--abort"],
        _ => return Err(Error::Msg("this operation cannot be aborted".into())),
    };
    let output = git_output(path, &args)?;
    if !output.status.success() {
        return Err(Error::Msg(output_text(&output)));
    }
    clear_sequence_meta(path);
    Ok(())
}

/// One `<<<<<<< / ======= / >>>>>>>` region inside a conflicted file.
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRegion {
    /// 0-based position of this region within its file.
    pub index: usize,
    /// 1-based line of the `<<<<<<<` marker in the working-tree file.
    pub start_line: usize,
    /// 1-based line of the `>>>>>>>` marker.
    pub end_line: usize,
    pub ours: String,
    pub theirs: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileEntry {
    pub path: String,
    pub binary: bool,
    /// Empty for a binary conflict, and also for a text file whose conflict is
    /// add/add or delete/modify — those have no markers to navigate.
    pub regions: Vec<ConflictRegion>,
}

/// Every conflicted file at once, with the two sides named (G25 / STATUS C4).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSet {
    pub kind: String,
    /// What `ours` actually *is*, as a ref name or short sha.
    pub ours_label: String,
    pub theirs_label: String,
    /// The commits behind each side, so the caller can colour them by lane.
    pub ours_oid: Option<String>,
    pub theirs_oid: Option<String>,
    pub files: Vec<ConflictFileEntry>,
}

/// Name the two sides of the conflict.
///
/// This is the whole point of G25's relabelling. "Ours" and "theirs" are not
/// wrong, they are *unstable*: in a merge, ours is the branch you are on; in a
/// rebase, ours is the branch you are rebasing **onto** and theirs is your own
/// work — the exact opposite of what almost everyone assumes. Naming the refs
/// removes the guess rather than asking the user to remember which operation
/// inverts the words.
fn conflict_sides(path: &str, kind: &str) -> (String, Option<String>, String, Option<String>) {
    let head_name = git_text(path, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let head_oid = git_text(path, &["rev-parse", "--verify", "-q", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());

    let describe = |rev: &str| -> Option<String> {
        git_text(path, &["rev-parse", "--verify", "-q", rev]).ok().map(|s| s.trim().to_string())
    };
    let short = |oid: &Option<String>| oid.as_deref().map(|o| o[..o.len().min(7)].to_string());

    match kind {
        "rebase" => {
            // `head-name` is the branch being rebased (theirs, the replayed
            // side); `onto` is the base (ours). Both live in the rebase state
            // directory rather than in a ref, which is why this reads files.
            let dir = git_dir(path).ok();
            let head_name_file = dir
                .as_ref()
                .and_then(|d| {
                    fs::read_to_string(d.join("rebase-merge/head-name"))
                        .or_else(|_| fs::read_to_string(d.join("rebase-apply/head-name")))
                        .ok()
                })
                .map(|s| s.trim().trim_start_matches("refs/heads/").to_string())
                .filter(|s| !s.is_empty());
            let onto = dir
                .as_ref()
                .and_then(|d| {
                    fs::read_to_string(d.join("rebase-merge/onto"))
                        .or_else(|_| fs::read_to_string(d.join("rebase-apply/onto")))
                        .ok()
                })
                .map(|s| s.trim().to_string());
            let stopped = dir
                .as_ref()
                .and_then(|d| fs::read_to_string(d.join("rebase-merge/stopped-sha")).ok())
                .map(|s| s.trim().to_string());
            let ours_label = onto
                .as_ref()
                .and_then(|o| name_for(path, o))
                .or_else(|| short(&onto))
                .unwrap_or_else(|| "the base".into());
            let theirs_label = head_name_file
                .clone()
                .or_else(|| short(&stopped))
                .unwrap_or_else(|| "your commit".into());
            (ours_label, onto, theirs_label, stopped)
        }
        "cherryPick" | "revert" => {
            let rev = if kind == "cherryPick" { "CHERRY_PICK_HEAD" } else { "REVERT_HEAD" };
            let other = describe(rev);
            let ours = head_name.clone().or_else(|| short(&head_oid)).unwrap_or_else(|| "HEAD".into());
            let theirs = other
                .as_ref()
                .and_then(|o| name_for(path, o))
                .or_else(|| short(&other))
                .unwrap_or_else(|| rev.to_string());
            (ours, head_oid, theirs, other)
        }
        _ => {
            let other = describe("MERGE_HEAD");
            let ours = head_name.clone().or_else(|| short(&head_oid)).unwrap_or_else(|| "HEAD".into());
            let theirs = other
                .as_ref()
                .and_then(|o| name_for(path, o))
                .or_else(|| short(&other))
                .unwrap_or_else(|| "MERGE_HEAD".into());
            (ours, head_oid, theirs, other)
        }
    }
}

/// A branch or tag name pointing at `oid`, if one does.
fn name_for(path: &str, oid: &str) -> Option<String> {
    let out = git_text(path, &["name-rev", "--name-only", "--refs=refs/heads/*", "--no-undefined", oid]).ok()?;
    let name = out.trim();
    // `name-rev` answers `main~3` for a commit that is merely *reachable* from
    // main. That is a description, not a label for a side, and printing it
    // beside a diff pane would read as "the branch main" when it is not.
    (!name.is_empty() && !name.contains('~') && !name.contains('^')).then(|| name.to_string())
}

/// Parse the conflict markers in `text` into navigable regions.
pub fn parse_conflict_regions(text: &str) -> Vec<ConflictRegion> {
    let mut out = Vec::new();
    let mut ours: Option<(usize, Vec<&str>)> = None;
    let mut theirs: Option<Vec<&str>> = None;

    for (i, line) in text.lines().enumerate() {
        let line_no = i + 1;
        if line.starts_with("<<<<<<<") {
            ours = Some((line_no, Vec::new()));
            theirs = None;
        } else if line.starts_with("=======") && ours.is_some() {
            theirs = Some(Vec::new());
        } else if line.starts_with(">>>>>>>") {
            if let (Some((start, our_lines)), Some(their_lines)) = (ours.take(), theirs.take()) {
                out.push(ConflictRegion {
                    index: out.len(),
                    start_line: start,
                    end_line: line_no,
                    ours: join_lines(&our_lines),
                    theirs: join_lines(&their_lines),
                });
            }
        } else if let Some(their_lines) = theirs.as_mut() {
            their_lines.push(line);
        } else if let Some((_, our_lines)) = ours.as_mut() {
            our_lines.push(line);
        }
    }
    out
}

fn join_lines(lines: &[&str]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

/// Everything the unified conflict panel needs in one call (G25).
///
/// One call rather than one per file because the panel's whole reason to exist
/// is cross-file navigation: `n` at the last region of file 3 has to know that
/// file 4 exists and where its first region is, and a per-file fetch would
/// make that a round trip mid-keystroke.
pub fn conflict_set(path: &str) -> Result<Option<ConflictSet>> {
    let Some(info) = operation_info(path)? else { return Ok(None) };
    let repo = Repository::discover(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::Msg("bare repositories have no conflict files".into()))?;

    let (ours_label, ours_oid, theirs_label, theirs_oid) = conflict_sides(path, &info.kind);

    let mut files = Vec::new();
    for file in &info.conflicts {
        let bytes = safe_worktree_path(workdir, file)
            .ok()
            .and_then(|p| fs::read(p).ok())
            .unwrap_or_default();
        let binary = bytes.contains(&0);
        let regions = if binary {
            Vec::new()
        } else {
            parse_conflict_regions(&String::from_utf8_lossy(&bytes))
        };
        files.push(ConflictFileEntry { path: file.clone(), binary, regions });
    }

    Ok(Some(ConflictSet {
        kind: info.kind,
        ours_label,
        theirs_label,
        ours_oid,
        theirs_oid,
        files,
    }))
}

pub fn conflict_file(path: &str, file: &str) -> Result<ConflictFile> {
    let repo = Repository::discover(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::Msg("bare repositories have no conflict files".into()))?;
    let output_path = safe_worktree_path(workdir, file)?;
    let ours_bytes = git_output(path, &["show", &format!(":2:{file}")])?.stdout;
    let theirs_bytes = git_output(path, &["show", &format!(":3:{file}")])?.stdout;
    let output_bytes = fs::read(&output_path).unwrap_or_default();
    let binary = [&ours_bytes, &theirs_bytes, &output_bytes]
        .iter()
        .any(|bytes| bytes.contains(&0));
    Ok(ConflictFile {
        path: file.to_string(),
        ours: String::from_utf8_lossy(&ours_bytes).to_string(),
        theirs: String::from_utf8_lossy(&theirs_bytes).to_string(),
        output: String::from_utf8_lossy(&output_bytes).to_string(),
        binary,
    })
}

pub fn resolve_conflict_content(path: &str, file: &str, content: &str) -> Result<()> {
    let repo = Repository::discover(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::Msg("bare repositories have no working tree".into()))?;
    let output_path = safe_worktree_path(workdir, file)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, content)?;
    git_text(path, &["add", "--", file])?;
    Ok(())
}

pub fn resolve_conflict_side(path: &str, file: &str, side: &str) -> Result<()> {
    if !matches!(side, "ours" | "theirs") {
        return Err(Error::Msg("conflict side must be ours or theirs".into()));
    }
    let flag = if side == "ours" { "--ours" } else { "--theirs" };
    let checkout = git_output(path, &["checkout", flag, "--", file])?;
    if checkout.status.success() {
        git_text(path, &["add", "--", file])?;
    } else {
        // A missing side represents a deletion.
        let remove = git_output(path, &["rm", "-f", "--ignore-unmatch", "--", file])?;
        if !remove.status.success() {
            return Err(Error::Msg(output_text(&checkout)));
        }
    }
    Ok(())
}

pub fn apply_patch(path: &str, patch: &str, cached: bool, reverse: bool) -> Result<()> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["apply", "--unidiff-zero"])
        .args(if cached { vec!["--cached"] } else { Vec::new() })
        .args(if reverse { vec!["--reverse"] } else { Vec::new() })
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    use std::io::Write;
    child
        .stdin
        .take()
        .ok_or_else(|| Error::Msg("could not open git apply stdin".into()))?
        .write_all(patch.as_bytes())?;
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::Msg(output_text(&output)))
    }
}

fn safe_worktree_path(workdir: &Path, file: &str) -> Result<PathBuf> {
    let rel = Path::new(file);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(Error::Msg("unsafe repository-relative path".into()));
    }
    Ok(workdir.join(rel))
}

#[derive(Default)]
struct SequenceMeta {
    kind: String,
    total: usize,
    current: usize,
    sha: Option<String>,
}

fn sequence_meta_path(path: &str) -> Result<PathBuf> {
    Ok(git_dir(path)?.join("MTGIT_SEQUENCE"))
}

fn write_sequence_meta(
    path: &str,
    kind: &str,
    total: usize,
    current: usize,
    sha: Option<String>,
) -> Result<()> {
    fs::write(
        sequence_meta_path(path)?,
        format!("{kind}\n{total}\n{current}\n{}\n", sha.unwrap_or_default()),
    )?;
    Ok(())
}

fn read_sequence_meta(path: &str) -> Result<SequenceMeta> {
    let text = fs::read_to_string(sequence_meta_path(path)?)?;
    let mut lines = text.lines();
    Ok(SequenceMeta {
        kind: lines.next().unwrap_or_default().to_string(),
        total: lines.next().and_then(|s| s.parse().ok()).unwrap_or(1),
        current: lines.next().and_then(|s| s.parse().ok()).unwrap_or(1),
        sha: lines
            .next()
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

fn bump_sequence_meta(path: &str) {
    if let Ok(mut meta) = read_sequence_meta(path) {
        meta.current = (meta.current + 1).min(meta.total);
        let _ = write_sequence_meta(path, &meta.kind, meta.total, meta.current, meta.sha);
    }
}

fn clear_sequence_meta(path: &str) {
    if let Ok(meta) = sequence_meta_path(path) {
        let _ = fs::remove_file(meta);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn git(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            output_text(&output)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn repo_with_commits() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "-q", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "test@example.com"]);
        for (index, message) in ["root", "second", "third"].iter().enumerate() {
            fs::write(dir.path().join("file.txt"), format!("{index}\n")).unwrap();
            git(dir.path(), &["add", "file.txt"]);
            git(dir.path(), &["commit", "-q", "-m", message]);
        }
        dir
    }

    /// The frontend's conflict banner is driven *only* by `operation_info`
    /// (`docs/feature-requirements/00-overview.md` §5.1): no call site derives
    /// banner state from its own operation's return value any more, because
    /// `git_network` has no conflict list to return and a conflict made in the
    /// terminal panel has no return value at all. That makes this function the
    /// single point of failure for STATUS A1, so it is pinned here for a
    /// conflict nobody reported to us — one produced by plain `git`.
    #[test]
    fn operation_info_reports_a_conflict_it_was_never_told_about() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();
        assert!(
            operation_info(path).unwrap().is_none(),
            "a clean repo must report no operation, or the banner never goes away"
        );

        git(dir.path(), &["checkout", "-q", "-b", "side", "HEAD~1"]);
        fs::write(dir.path().join("file.txt"), "side\n").unwrap();
        git(dir.path(), &["add", "file.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "side change"]);
        git(dir.path(), &["checkout", "-q", "main"]);

        // Conflict via the git binary directly: nothing in our own code ran, so
        // the only way to know about it is to read the repository.
        let merge = Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["merge", "side"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "fixture must actually conflict");

        let info = operation_info(path)
            .unwrap()
            .expect("a conflicted merge must be discoverable from the repo");
        assert_eq!(info.kind, "merge");
        assert_eq!(info.conflicts, vec!["file.txt".to_string()]);
        assert!(info.can_continue);
        // `i of n` has no git-side record for a merge, so it must still be a
        // usable default rather than 0 — the banner renders it verbatim.
        assert_eq!((info.current, info.total), (1, 1));

        git(dir.path(), &["merge", "--abort"]);
        assert!(
            operation_info(path).unwrap().is_none(),
            "abort must clear the state, or the banner outlives the operation"
        );
    }

    /// STATUS A3 / overview §5.3: while an operation is paused, the frontend
    /// refuses checkout / pull / merge / rebase / cherry-pick / reset and points
    /// at the banner instead of letting git produce the refusal. That gate asks
    /// exactly one question — `operation_info(path).is_some()` — so it is only
    /// as good as this function's willingness to report an operation whose
    /// conflicts have all been resolved and staged.
    ///
    /// That is the dangerous half of the paused state, not the harmless one: a
    /// rebase stopped mid-plan with a clean index still has replays pending, and
    /// a checkout there abandons them. The conflict *list* is empty at that
    /// point, so anything keying off `conflicts.is_empty()` would wave the
    /// checkout through — hence the assertion below.
    #[test]
    fn operation_info_still_reports_a_paused_operation_with_no_conflicts_left() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();

        git(dir.path(), &["checkout", "-q", "-b", "side", "HEAD~1"]);
        fs::write(dir.path().join("file.txt"), "side\n").unwrap();
        git(dir.path(), &["add", "file.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "side change"]);
        git(dir.path(), &["checkout", "-q", "main"]);

        let merge = Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["merge", "side"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "fixture must actually conflict");

        // Resolve and stage every conflict, but do not commit — the merge is
        // still in progress, which is precisely what the user cannot see once
        // the file list empties out.
        fs::write(dir.path().join("file.txt"), "resolved\n").unwrap();
        git(dir.path(), &["add", "file.txt"]);

        let info = operation_info(path)
            .unwrap()
            .expect("a merge with every conflict staged is still a merge in progress");
        assert_eq!(info.kind, "merge");
        assert!(
            info.conflicts.is_empty(),
            "the fixture is meant to have nothing left to resolve"
        );
        assert!(info.can_continue, "the banner's Continue is the way out of this state");

        git(dir.path(), &["commit", "-q", "--no-edit"]);
        assert!(
            operation_info(path).unwrap().is_none(),
            "committing the merge ends it, and the gate must reopen"
        );
    }

    #[test]
    fn native_commit_uses_staged_snapshot() {
        let dir = repo_with_commits();
        fs::write(dir.path().join("staged.txt"), "staged\n").unwrap();
        git(dir.path(), &["add", "staged.txt"]);
        fs::write(dir.path().join("unstaged.txt"), "unstaged\n").unwrap();

        let result = commit_cli(
            dir.path().to_str().unwrap(),
            "native commit",
            "body",
            false,
            false,
        )
        .unwrap();
        assert!(result.success, "{}", result.output);
        assert_eq!(git(dir.path(), &["show", "-s", "--format=%s", "HEAD"]), "native commit");
        assert!(git(dir.path(), &["status", "--porcelain"]).contains("unstaged.txt"));
    }

    #[test]
    fn interactive_rebase_rewords_without_touching_tree() {
        let dir = repo_with_commits();
        let base = git(dir.path(), &["rev-parse", "HEAD~2"]);
        let commits = rebase_commits(dir.path().to_str().unwrap(), &base).unwrap();
        let before = fs::read_to_string(dir.path().join("file.txt")).unwrap();
        let plan = commits
            .iter()
            .map(|commit| RebasePlanItem {
                oid: commit.oid.clone(),
                action: if commit.summary == "second" {
                    RebaseAction::Reword
                } else {
                    RebaseAction::Pick
                },
                message: (commit.summary == "second").then(|| "second rewritten".to_string()),
            })
            .collect::<Vec<_>>();
        let result = interactive_rebase(dir.path().to_str().unwrap(), &base, &plan).unwrap();
        assert!(result.success, "{}", result.output);
        assert!(git(dir.path(), &["log", "--format=%s", "-3"]).contains("second rewritten"));
        assert_eq!(fs::read_to_string(dir.path().join("file.txt")).unwrap(), before);
    }

    #[test]
    fn no_commit_cherry_pick_leaves_changes_staged() {
        let dir = repo_with_commits();
        git(dir.path(), &["checkout", "-q", "-b", "side", "HEAD~1"]);
        fs::write(dir.path().join("side.txt"), "side\n").unwrap();
        git(dir.path(), &["add", "side.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "side change"]);
        let pick = git(dir.path(), &["rev-parse", "HEAD"]);
        git(dir.path(), &["checkout", "-q", "main"]);

        let result = cherry_pick_many(
            dir.path().to_str().unwrap(),
            &[pick],
            false,
            None,
            false,
            false,
        )
        .unwrap();
        assert!(result.success, "{}", result.output);
        assert!(git(dir.path(), &["diff", "--cached", "--name-only"]).contains("side.txt"));
        assert_ne!(git(dir.path(), &["show", "-s", "--format=%s", "HEAD"]), "side change");
    }

    /// `07-cherry-pick.md` B4. Without the fallback git refuses the pick
    /// outright ("your local changes would be overwritten"), and the user is
    /// told to stash by a tool that could have stashed.
    #[test]
    fn a_dirty_tree_is_stashed_around_the_pick_and_restored_after_it() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();
        git(dir.path(), &["checkout", "-q", "-b", "side", "HEAD~1"]);
        fs::write(dir.path().join("file.txt"), "side\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "side change"]);
        let pick = git(dir.path(), &["rev-parse", "HEAD"]);
        git(dir.path(), &["checkout", "-q", "main"]);

        // The uncommitted edit git will refuse to overwrite.
        fs::write(dir.path().join("file.txt"), "work in progress\n").unwrap();
        let refused =
            cherry_pick_many(path, std::slice::from_ref(&pick), true, None, false, false).unwrap();
        assert!(!refused.success, "git should refuse a colliding dirty tree");
        assert!(!refused.auto_stashed);

        let result = cherry_pick_many(path, &[pick], true, None, false, true).unwrap();
        assert!(result.auto_stashed);
        assert!(!result.success, "the pick still conflicts with the stashed edit");
        assert!(!result.conflicts.is_empty(), "{}", result.output);
        assert!(
            result.stash_kept,
            "a paused sequence must keep the stash: popping would mix the user's \
             work into the conflict markers"
        );
        assert_eq!(git(dir.path(), &["stash", "list"]).lines().count(), 1);
    }

    /// The other half of B4: when the pick goes through, the work that was
    /// stashed to let it start has to come back.
    #[test]
    fn a_clean_pick_pops_the_stash_it_took() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();
        git(dir.path(), &["checkout", "-q", "-b", "side", "HEAD~1"]);
        fs::write(dir.path().join("other.txt"), "side\n").unwrap();
        git(dir.path(), &["add", "other.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "side change"]);
        let pick = git(dir.path(), &["rev-parse", "HEAD"]);
        git(dir.path(), &["checkout", "-q", "main"]);
        fs::write(dir.path().join("file.txt"), "work in progress\n").unwrap();

        let result = cherry_pick_many(path, &[pick], true, None, false, true).unwrap();
        assert!(result.success, "{}", result.output);
        assert!(result.auto_stashed && !result.stash_kept);
        assert_eq!(
            fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "work in progress\n",
            "the uncommitted edit is back"
        );
        assert_eq!(git(dir.path(), &["stash", "list"]), "");
    }

    #[test]
    fn conflict_regions_are_parsed_with_their_line_numbers() {
        let text = "a\n<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> other\nb\n";
        let regions = parse_conflict_regions(text);
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].index, 0);
        assert_eq!(regions[0].start_line, 2);
        assert_eq!(regions[0].end_line, 6);
        assert_eq!(regions[0].ours, "mine\n");
        assert_eq!(regions[0].theirs, "yours\n");
    }

    /// A side with no lines is a delete-vs-modify, and it has to survive as an
    /// empty string: dropping the region would hide a conflict the user must
    /// still decide.
    #[test]
    fn an_empty_side_still_produces_a_region() {
        let regions = parse_conflict_regions("<<<<<<< HEAD\n=======\nyours\n>>>>>>> other\n");
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].ours, "");
        assert_eq!(regions[0].theirs, "yours\n");
    }

    #[test]
    fn a_file_with_no_markers_has_no_regions() {
        assert!(parse_conflict_regions("just text\n").is_empty());
        // An unterminated region is not a region: git never writes one, and
        // treating a stray marker as a conflict would offer to "resolve"
        // ordinary prose.
        assert!(parse_conflict_regions("<<<<<<< HEAD\nmine\n").is_empty());
    }

    /// The C4 fix, and the reason G25 exists: during a **merge** the sides are
    /// named for the branches, not "ours" and "theirs".
    #[test]
    fn a_merge_conflict_names_both_branches() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();
        git(dir.path(), &["checkout", "-q", "-b", "side", "HEAD~1"]);
        fs::write(dir.path().join("file.txt"), "side\n").unwrap();
        git(dir.path(), &["add", "file.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "side change"]);
        git(dir.path(), &["checkout", "-q", "main"]);
        let _ = Command::new("git").arg("-C").arg(dir.path()).args(["merge", "side"]).output();

        let set = conflict_set(path).unwrap().expect("a conflict is in progress");
        assert_eq!(set.kind, "merge");
        assert_eq!(set.ours_label, "main");
        assert_eq!(set.theirs_label, "side");
        assert_eq!(set.files.len(), 1);
        assert_eq!(set.files[0].path, "file.txt");
        assert_eq!(set.files[0].regions.len(), 1, "one marker block in file.txt");
        assert!(!set.files[0].binary);
    }

    /// A rebase inverts the two words, which is precisely what made "Ours" and
    /// "Theirs" worse than useless. `ours` is the branch being rebased *onto*.
    #[test]
    fn a_rebase_conflict_names_the_base_as_ours_and_the_replayed_branch_as_theirs() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();
        git(dir.path(), &["checkout", "-q", "-b", "feature", "HEAD~1"]);
        fs::write(dir.path().join("file.txt"), "feature\n").unwrap();
        git(dir.path(), &["add", "file.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "feature change"]);
        let _ = Command::new("git").arg("-C").arg(dir.path()).args(["rebase", "main"]).output();

        let set = conflict_set(path).unwrap().expect("a rebase is in progress");
        assert_eq!(set.kind, "rebase");
        assert_eq!(set.ours_label, "main", "ours is the base you are rebasing onto");
        assert_eq!(set.theirs_label, "feature", "theirs is your own work");
    }

    /// `06-rebase.md` §7: a merge commit in the range is *flagged*, not
    /// dropped. Filtering it out made the plan claim the rebase would replay
    /// commits it was actually going to flatten.
    #[test]
    fn rebase_commits_reports_a_merge_rather_than_hiding_it() {
        let dir = repo_with_commits();
        let path = dir.path().to_str().unwrap();
        let base = git(dir.path(), &["rev-parse", "HEAD"]);

        git(dir.path(), &["checkout", "-q", "-b", "side"]);
        fs::write(dir.path().join("side.txt"), "s\n").unwrap();
        git(dir.path(), &["add", "side.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "side"]);
        git(dir.path(), &["checkout", "-q", "main"]);
        fs::write(dir.path().join("main.txt"), "m\n").unwrap();
        git(dir.path(), &["add", "main.txt"]);
        git(dir.path(), &["commit", "-q", "-m", "main change"]);
        git(dir.path(), &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);

        let commits = rebase_commits(path, &base).unwrap();
        let merge = commits.iter().find(|c| c.is_merge).expect("the merge is listed");
        assert_eq!(merge.summary, "merge side");
        assert!(commits.iter().any(|c| !c.is_merge), "ordinary commits are still listed");
        assert!(!merge.email.is_empty(), "rows carry an identity for the avatar");
    }

    #[test]
    fn a_clean_repository_has_no_conflict_set() {
        let dir = repo_with_commits();
        assert!(conflict_set(dir.path().to_str().unwrap()).unwrap().is_none());
    }
}
