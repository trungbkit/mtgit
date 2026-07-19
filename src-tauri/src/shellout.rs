//! Network operations (push / pull / fetch) shell out to the system `git`.
//! This deliberately inherits the user's credential helpers, SSH agent, and
//! proxy config — the single biggest pain point of libgit2's own networking.
//! Progress from `--progress` (stderr) is streamed to the frontend as events.

use crate::error::{Error, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitOpResult {
    pub success: bool,
    pub code: Option<i32>,
    pub output: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    op: String,
    line: String,
}

/// Is a usable `git` binary on PATH? Checked at startup (plan mitigation #2).
pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a network git operation, streaming stderr lines as `git-progress`
/// events and returning the combined output when it finishes.
pub fn run(
    app: &AppHandle,
    repo_path: &str,
    op: &str,
    remote: Option<&str>,
    extra: &[String],
    pids: &Mutex<HashMap<String, u32>>,
) -> Result<GitOpResult> {
    run_inner(Some(app), repo_path, op, remote, extra, Some(pids))
}

pub fn run_silent(repo_path: &str, op: &str, remote: Option<&str>, extra: &[String]) -> Result<GitOpResult> {
    run_inner(None, repo_path, op, remote, extra, None)
}

fn run_inner(
    app: Option<&AppHandle>,
    repo_path: &str,
    op: &str,
    remote: Option<&str>,
    extra: &[String],
    pids: Option<&Mutex<HashMap<String, u32>>>,
) -> Result<GitOpResult> {
    if !matches!(op, "fetch" | "pull" | "push") {
        return Err(Error::Msg(format!("unsupported network op: {op}")));
    }

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo_path).arg(op).arg("--progress");
    if let Some(r) = remote {
        if !r.is_empty() {
            cmd.arg(r);
        }
    }
    for a in extra {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| Error::Msg(format!("failed to launch git: {e}")))?;
    if let Some(pids) = pids {
        if let Ok(mut active) = pids.lock() {
            active.insert(repo_path.to_string(), child.id());
        }
    }

    let mut collected = String::new();

    // git writes transfer progress to stderr; stream it line by line.
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(std::result::Result::ok) {
            if let Some(app) = app {
                let _ = app.emit("git-progress", ProgressEvent { op: op.to_string(), line: line.clone() });
            }
            collected.push_str(&line);
            collected.push('\n');
        }
    }

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(std::result::Result::ok) {
            collected.push_str(&line);
            collected.push('\n');
        }
    }

    let status = child.wait().map_err(|e| Error::Msg(e.to_string()))?;
    if let Some(pids) = pids {
        if let Ok(mut active) = pids.lock() {
            active.remove(repo_path);
        }
    }
    Ok(GitOpResult {
        success: status.success(),
        code: status.code(),
        output: collected.trim_end().to_string(),
    })
}
