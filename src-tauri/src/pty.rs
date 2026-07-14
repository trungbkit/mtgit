//! Terminal sessions backed by `portable-pty`, paired with xterm.js on the
//! frontend. Output is streamed as `pty-output` events; `pty-exit` fires when a
//! shell ends.

use crate::error::{Error, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
    counter: AtomicUsize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    id: String,
}

impl PtyManager {
    /// Spawn a shell rooted at `cwd`, returning the new session id.
    pub fn spawn(&self, app: AppHandle, cwd: &str, rows: u16, cols: u16) -> Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Msg(e.to_string()))?;

        let mut cmd = CommandBuilder::new(default_shell());
        cmd.cwd(cwd);

        let child = pair.slave.spawn_command(cmd).map_err(|e| Error::Msg(e.to_string()))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| Error::Msg(e.to_string()))?;
        let writer = pair.master.take_writer().map_err(|e| Error::Msg(e.to_string()))?;

        let id = format!("pty-{}", self.counter.fetch_add(1, Ordering::Relaxed));

        // Pump output to the frontend on a dedicated thread.
        let emit_id = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let _ = app.emit("pty-output", PtyOutput { id: emit_id.clone(), data });
                    }
                }
            }
            let _ = app.emit("pty-exit", PtyExit { id: emit_id.clone() });
        });

        self.sessions
            .lock()
            .map_err(|_| Error::Msg("pty lock poisoned".into()))?
            .insert(id.clone(), PtySession { master: pair.master, writer, child });

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|_| Error::Msg("pty lock poisoned".into()))?;
        let session = sessions.get_mut(id).ok_or_else(|| Error::Msg("no such pty".into()))?;
        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<()> {
        let sessions = self.sessions.lock().map_err(|_| Error::Msg("pty lock poisoned".into()))?;
        let session = sessions.get(id).ok_or_else(|| Error::Msg("no such pty".into()))?;
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Msg(e.to_string()))?;
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().map_err(|_| Error::Msg("pty lock poisoned".into()))?;
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.child.kill();
        }
        Ok(())
    }
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}
