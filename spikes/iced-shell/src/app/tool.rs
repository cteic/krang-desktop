//! The app's end of the `kd` pane tool: the socket, the secret each
//! terminal pane gets, and the hand-over of a request to the window.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use crate::kd::protocol::{ENV_CLI, ENV_PANE, ENV_SOCKET, ENV_TOKEN, Request, Response, pane_name};
use crate::kd::server::{self, Tokens};
use crate::kd::shell_env;

/// How long the socket's thread waits for the window to answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(5);

/// A request that carried its pane's secret, and where the answer goes.
#[derive(Clone)]
pub struct ToolCall {
    pub request: Request,
    reply: Arc<Mutex<Option<SyncSender<Response>>>>,
}

impl std::fmt::Debug for ToolCall {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The secret stays out of logs.
        formatter
            .debug_struct("ToolCall")
            .field("pane", &self.request.pane)
            .field("command", &self.request.command)
            .finish_non_exhaustive()
    }
}

impl ToolCall {
    pub fn answer(&self, response: Response) {
        let reply = self.reply.lock().ok().and_then(|mut reply| reply.take());
        if let Some(reply) = reply {
            let _ = reply.try_send(response);
        }
    }
}

pub struct Tool {
    socket: PathBuf,
    /// The `kd` link, and the directory it is in.
    cli: Option<PathBuf>,
    /// The zsh startup files are in the link's directory.
    wrapped: bool,
    tokens: Tokens,
}

impl Tool {
    /// Opens the socket and starts answering on a thread of its own. The
    /// thread blocks in `accept`, so it costs nothing while nobody asks.
    pub fn start(
        state_dir: Option<&Path>,
        calls: UnboundedSender<ToolCall>,
    ) -> Result<Self, String> {
        let dir = server::socket_dir(state_dir);
        let (listener, socket) = server::bind(&dir).map_err(|error| error.to_string())?;
        let tokens = Tokens::default();
        let cli = std::env::current_exe()
            .ok()
            .and_then(|program| server::link_tool(&server::tool_dir(&dir), &program).ok());
        // A profile may replace PATH outright, which would drop `kd`. zsh
        // reads these files instead and gets the tool back on PATH after.
        let wrapped = cli
            .as_deref()
            .and_then(Path::parent)
            .is_some_and(|bin| shell_env::write_zsh_dir(bin).is_ok());
        let serving = tokens.clone();
        std::thread::Builder::new()
            .name(String::from("kd-socket"))
            .spawn(move || {
                server::serve(listener, serving, move |request| {
                    let (reply, answer) = sync_channel(1);
                    let call = ToolCall {
                        request,
                        reply: Arc::new(Mutex::new(Some(reply))),
                    };
                    if calls.send(call).is_err() {
                        return Response::err("the app is closing");
                    }
                    answer
                        .recv_timeout(ANSWER_WITHIN)
                        .unwrap_or_else(|_| Response::err("the app did not answer in time"))
                });
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            socket,
            cli,
            wrapped,
            tokens,
        })
    }

    /// What a terminal pane's shell gets, so `kd` in it reaches this app as
    /// that pane. Each call makes the pane a new secret.
    pub fn env(&self, pane: u64) -> Vec<(String, String)> {
        let Ok(token) = self.tokens.issue(pane) else {
            return Vec::new();
        };
        let mut env = vec![
            (
                String::from(ENV_SOCKET),
                self.socket.to_string_lossy().into_owned(),
            ),
            (String::from(ENV_PANE), pane_name(pane)),
            (String::from(ENV_TOKEN), token),
        ];
        if let Some(cli) = &self.cli {
            env.push((String::from(ENV_CLI), cli.to_string_lossy().into_owned()));
            if let Some(bin) = cli.parent() {
                let path = match std::env::var("PATH") {
                    Ok(path) if !path.is_empty() => format!("{}:{path}", bin.display()),
                    _ => format!("{}:/usr/bin:/bin", bin.display()),
                };
                env.push((String::from("PATH"), path));
                let zsh = std::env::var("SHELL").map_or(cfg!(target_os = "macos"), |shell| {
                    shell.is_empty() || shell_env::is_zsh(&shell)
                });
                if self.wrapped && zsh {
                    env.extend(shell_env::zsh_env(
                        bin,
                        bin,
                        std::env::var("ZDOTDIR").ok().as_deref(),
                        std::env::var("HOME").ok().as_deref(),
                    ));
                }
            }
        }
        env
    }

    pub fn revoke(&self, pane: u64) {
        self.tokens.revoke(pane);
    }

    /// Removes the socket and the link. A process that crashes leaves
    /// them, and the next start sweeps them away.
    pub fn close(&self) {
        let _ = std::fs::remove_file(&self.socket);
        if let Some(cli) = &self.cli
            && let Some(bin) = cli.parent()
        {
            let _ = std::fs::remove_dir_all(bin);
        }
    }
}

impl Drop for Tool {
    fn drop(&mut self) {
        self.close();
    }
}
