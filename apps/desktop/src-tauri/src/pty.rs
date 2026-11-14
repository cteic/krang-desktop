use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, WebviewWindow};

use crate::startup::expand_home;

const READ_BUFFER_BYTES: usize = 64 * 1024;

struct Session {
    window: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

#[derive(Default)]
pub struct PtyState {
    sessions: Sessions,
}

impl PtyState {
    /// Ends every session a window started. A closed window's page never
    /// gets to run its own teardown, so the shell does it here.
    pub fn kill_window(&self, window: &str) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| session.window == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                let _ = session.killer.kill();
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    exit_code: u32,
    success: bool,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| String::from("/bin/zsh"))
}

/// Starts a program on a new pseudo-terminal and streams its output.
///
/// With no `program`, the user's login shell starts. A login shell matters
/// for an app opened from the Dock: it inherits a bare PATH, and the shell's
/// own profile is what puts developer tools back on it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    window: WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    cwd: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<ExitInfo>,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|error| format!("open pty: {error}"))?;

    let mut command = match program {
        Some(program) => {
            let mut command = CommandBuilder::new(program);
            command.args(args.unwrap_or_default());
            command
        }
        None => {
            let mut command = CommandBuilder::new(default_shell());
            command.arg("-l");
            command
        }
    };
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let home = std::env::var("HOME").ok();
    match cwd {
        Some(dir) => command.cwd(expand_home(&dir, home.as_deref())),
        None => {
            if let Some(home) = home {
                command.cwd(home);
            }
        }
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("spawn: {error}"))?;
    // The child holds its own handle to the slave side. Keeping ours open
    // would stop the reader ever seeing end-of-file after the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("clone reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("take writer: {error}"))?;
    let killer = child.clone_killer();

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| String::from("session table is poisoned"))?;
        if sessions.contains_key(&id) {
            return Err(format!("session {id} already exists"));
        }
        sessions.insert(
            id.clone(),
            Session {
                window: window.label().to_string(),
                master: pair.master,
                writer,
                killer,
            },
        );
    }

    thread::spawn(move || {
        let mut buffer = vec![0u8; READ_BUFFER_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let chunk = InvokeResponseBody::Raw(buffer[..count].to_vec());
                    if on_data.send(chunk).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let sessions = Arc::clone(&state.sessions);
    thread::spawn(move || {
        let info = match child.wait() {
            Ok(status) => ExitInfo {
                exit_code: status.exit_code(),
                success: status.success(),
            },
            Err(_) => ExitInfo {
                exit_code: 1,
                success: false,
            },
        };
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&id);
        }
        let _ = on_exit.send(info);
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| String::from("session table is poisoned"))?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no session {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| session.writer.flush())
        .map_err(|error| format!("write: {error}"))
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| String::from("session table is poisoned"))?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("no session {id}"))?;
    session
        .master
        .resize(size(cols, rows))
        .map_err(|error| format!("resize: {error}"))
}

/// Ends a session. Unknown ids are not an error: the child may already have
/// exited and removed itself.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| String::from("session table is poisoned"))?;
    if let Some(mut session) = sessions.remove(&id) {
        session
            .killer
            .kill()
            .map_err(|error| format!("kill: {error}"))?;
    }
    Ok(())
}
