//! Network operations (clone / fetch / pull / push) shell out to the system `git`.
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

/// What the clone form can ask for beyond a URL and a destination.
#[derive(Debug, Default, Clone)]
pub struct CloneOptions {
    pub recurse_submodules: bool,
    /// Shallow depth. `Some(0)` is treated as "no limit" rather than passed on,
    /// because `git clone --depth 0` is an error and an empty form field is not.
    pub depth: Option<u32>,
    /// Clone a single named branch instead of the remote's default.
    pub branch: Option<String>,
    pub bare: bool,
}

/// `git clone --progress <url> <dest>`, streamed like any other network op.
///
/// Clone cannot go through [`run`]: it has no repository to `-C` into, and it
/// is the one network op whose arguments are typed by the user. Both of those
/// user-typed values are placed after `--`, so a URL or a path beginning with
/// `-` is a bad URL rather than an injected option — the same guard
/// `core/search.rs` applies to search terms, for the same reason.
///
/// The PID is registered under `dest`, so the status bar's Cancel reaches a
/// clone by the path the frontend already knows it by.
pub fn clone(
    app: &AppHandle,
    url: &str,
    dest: &str,
    opts: &CloneOptions,
    pids: &Mutex<HashMap<String, u32>>,
) -> Result<GitOpResult> {
    clone_inner(Some(app), url, dest, opts, Some(pids))
}

fn clone_inner(
    app: Option<&AppHandle>,
    url: &str,
    dest: &str,
    opts: &CloneOptions,
    pids: Option<&Mutex<HashMap<String, u32>>>,
) -> Result<GitOpResult> {
    let url = url.trim();
    if url.is_empty() {
        return Err(Error::Msg("clone URL cannot be empty".into()));
    }
    if dest.trim().is_empty() {
        return Err(Error::Msg("clone destination cannot be empty".into()));
    }

    let mut cmd = Command::new("git");
    cmd.arg("clone").arg("--progress");
    if opts.recurse_submodules {
        cmd.arg("--recurse-submodules");
    }
    if let Some(depth) = opts.depth.filter(|d| *d > 0) {
        cmd.arg(format!("--depth={depth}"));
    }
    if let Some(branch) = opts.branch.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        // Attached to its flag: one argv word, so a leading '-' cannot be read
        // as an option of its own.
        cmd.arg(format!("--branch={branch}"));
    }
    if opts.bare {
        cmd.arg("--bare");
    }
    cmd.arg("--").arg(url).arg(dest);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| Error::Msg(format!("failed to launch git: {e}")))?;
    if let Some(pids) = pids {
        if let Ok(mut active) = pids.lock() {
            active.insert(dest.to_string(), child.id());
        }
    }

    let collected = drain(&mut child, |line| {
        if let Some(app) = app {
            let _ = app.emit(
                "git-progress",
                ProgressEvent { op: "clone".to_string(), line: line.to_string() },
            );
        }
    });

    let status = child.wait().map_err(|e| Error::Msg(e.to_string()))?;
    if let Some(pids) = pids {
        if let Ok(mut active) = pids.lock() {
            active.remove(dest);
        }
    }
    Ok(GitOpResult {
        success: status.success(),
        code: status.code(),
        output: collected.trim_end().to_string(),
    })
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

    /// Clone the real thing: a local fixture repo, through the real `git`
    /// binary, and assert the clone carries the history and a live origin.
    #[test]
    fn clone_copies_history_and_wires_up_origin() {
        let source = tempfile::tempdir().unwrap();
        let src = source.path().to_str().unwrap();
        git(src, &["init", "-q", "-b", "main", "."]);
        std::fs::write(source.path().join("a.txt"), "hello\n").unwrap();
        git(src, &["add", "a.txt"]);
        git(src, &["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", "first"]);

        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("clone").to_string_lossy().into_owned();
        let mut progress = Vec::new();
        let result = clone_inner(None, src, &dest, &CloneOptions::default(), None).unwrap();
        progress.push(result.output.clone());

        assert!(result.success, "clone failed: {}", result.output);
        assert_eq!(std::fs::read_to_string(format!("{dest}/a.txt")).unwrap(), "hello\n");
        let repo = git2::Repository::open(&dest).unwrap();
        assert_eq!(repo.find_remote("origin").unwrap().url(), Some(src));
        assert!(repo.find_reference("refs/remotes/origin/main").is_ok());
    }

    /// A shallow clone must actually be shallow — `--depth` is the one clone
    /// option whose effect is invisible in the working tree.
    #[test]
    fn clone_with_a_depth_truncates_history() {
        let source = tempfile::tempdir().unwrap();
        let src = source.path().to_str().unwrap();
        git(src, &["init", "-q", "-b", "main", "."]);
        for n in 0..3 {
            std::fs::write(source.path().join("a.txt"), format!("{n}\n")).unwrap();
            git(src, &["add", "a.txt"]);
            git(src, &["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", &format!("c{n}")]);
        }

        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("shallow").to_string_lossy().into_owned();
        let opts = CloneOptions { depth: Some(1), ..CloneOptions::default() };
        // `file://` deliberately: git ignores --depth for a plain local path
        // (it hardlinks the object store instead of running the transport).
        let result = clone_inner(None, &format!("file://{src}"), &dest, &opts, None).unwrap();
        assert!(result.success, "clone failed: {}", result.output);

        let repo = git2::Repository::open(&dest).unwrap();
        let mut walk = repo.revwalk().unwrap();
        walk.push_head().unwrap();
        assert_eq!(walk.count(), 1, "--depth=1 must bring exactly one commit");
    }

    /// `--depth=0` is an error to git and "no limit" to a form field. The
    /// option must be dropped, not forwarded.
    #[test]
    fn clone_treats_a_zero_depth_as_no_limit() {
        let source = tempfile::tempdir().unwrap();
        let src = source.path().to_str().unwrap();
        git(src, &["init", "-q", "-b", "main", "."]);
        std::fs::write(source.path().join("a.txt"), "x\n").unwrap();
        git(src, &["add", "a.txt"]);
        git(src, &["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-qm", "first"]);

        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("full").to_string_lossy().into_owned();
        let opts = CloneOptions { depth: Some(0), ..CloneOptions::default() };
        let result = clone_inner(None, src, &dest, &opts, None).unwrap();
        assert!(result.success, "a zero depth must not reach git: {}", result.output);
    }

    /// The user types the URL, and it reaches a real `git` command line
    /// (invariant 6). After `--` a leading dash is a bad path, not an option:
    /// `--upload-pack=` would otherwise run an arbitrary command.
    #[test]
    fn a_url_that_looks_like_an_option_is_treated_as_a_url() {
        let target = tempfile::tempdir().unwrap();
        let dest = target.path().join("nope").to_string_lossy().into_owned();
        let marker = target.path().join("pwned");
        let payload = format!("--upload-pack=touch {}", marker.display());
        let result = clone_inner(None, &payload, &dest, &CloneOptions::default(), None).unwrap();

        assert!(!result.success, "a dash-leading URL must not clone: {}", result.output);
        assert!(!marker.exists(), "the option was executed rather than read as a URL");
    }

    fn git(cwd: &str, args: &[&str]) {
        let status = Command::new("git").arg("-C").arg(cwd).args(args).status().unwrap();
        assert!(status.success(), "git {args:?} failed");
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
