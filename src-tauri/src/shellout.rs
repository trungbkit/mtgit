//! Network operations (push / pull / fetch) shell out to the system `git`.
//! This deliberately inherits the user's credential helpers, SSH agent, and
//! proxy config — the single biggest pain point of libgit2's own networking.
//! Progress from `--progress` (stderr) is streamed to the frontend as events.

use crate::error::{Error, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
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

/// Read both of a child's pipes to EOF, calling `on_stderr` for each stderr
/// line as it arrives, and return stderr followed by stdout.
///
/// Both pipes must be drained *concurrently*. Reading stderr to EOF first
/// deadlocks any git op that fills the stdout pipe buffer while stderr is
/// still open — e.g. a `pull` whose merge prints a long diffstat: git blocks
/// writing stdout, we block reading stderr, and neither side moves.
fn drain(child: &mut Child, mut on_stderr: impl FnMut(&str)) -> String {
    let stdout = child.stdout.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        buf
    });

    // git writes transfer progress to stderr; stream it line by line.
    let mut collected = String::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            on_stderr(&line);
            collected.push_str(&line);
            collected.push('\n');
        }
    }

    collected.push_str(&stdout_reader.join().unwrap_or_default());
    collected
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

    let collected = drain(&mut child, |line| {
        if let Some(app) = app {
            let _ = app.emit("git-progress", ProgressEvent { op: op.to_string(), line: line.to_string() });
        }
    });

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

#[cfg(test)]
mod tests {
    use super::*;

    /// D4 regression: a child that fills the stdout pipe before writing
    /// anything to stderr must still be drained. The pre-fix implementation
    /// read stderr to EOF first and hung here forever.
    #[cfg(unix)]
    #[test]
    fn drain_does_not_deadlock_when_stdout_fills_the_pipe() {
        use std::sync::mpsc;
        use std::time::Duration;

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            // ~240KB on stdout (well past the 64KB pipe buffer) written before
            // the single stderr line, so stderr stays open the whole time.
            let mut child = Command::new("sh")
                .arg("-c")
                .arg("yes '0123456789' | head -n 20000; echo 'remote: done' >&2")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn sh");
            let mut progress = Vec::new();
            let out = drain(&mut child, |l| progress.push(l.to_string()));
            let _ = child.wait();
            let _ = tx.send((out, progress));
        });

        let (out, progress) = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("drain deadlocked on a full stdout pipe");
        assert_eq!(progress, vec!["remote: done".to_string()]);
        assert!(out.starts_with("remote: done\n"), "stderr comes first: {:?}", &out[..40]);
        assert_eq!(out.lines().filter(|l| *l == "0123456789").count(), 20_000);
    }

    /// A child that writes nothing at all must not hang or panic.
    #[cfg(unix)]
    #[test]
    fn drain_handles_a_silent_child() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("exit 0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        assert_eq!(drain(&mut child, |_| {}), "");
        assert!(child.wait().unwrap().success());
    }
}
