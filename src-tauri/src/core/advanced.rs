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

pub fn cherry_pick_many(
    path: &str,
    oids: &[String],
    commit_immediately: bool,
    mainline: Option<usize>,
    append_origin: bool,
) -> Result<CommandResult> {
    if oids.is_empty() {
        return Err(Error::Msg("select at least one commit".into()));
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
            "--format=%H%x00%P%x00%s",
            &format!("{base}..HEAD"),
        ],
    )?;
    Ok(raw
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\0');
            let oid = fields.next()?;
            let parents = fields.next()?;
            let summary = fields.next()?;
            if parents.split_whitespace().count() > 1 {
                return None;
            }
            Some(RebaseCommit {
                oid: oid.to_string(),
                summary: summary.to_string(),
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
        )
        .unwrap();
        assert!(result.success, "{}", result.output);
        assert!(git(dir.path(), &["diff", "--cached", "--name-only"]).contains("side.txt"));
        assert_ne!(git(dir.path(), &["show", "-s", "--format=%s", "HEAD"]), "side change");
    }
}
