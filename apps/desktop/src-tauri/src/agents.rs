use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use crate::startup::expand_home;

/// The command-line agents a chat pane may start. A name outside this list
/// is refused, so the window cannot be used to run arbitrary programs.
const ALLOWED_AGENTS: [&str; 2] = ["claude", "codex"];

/// Where agents are usually installed. An app opened from the Dock inherits
/// a bare PATH that has none of these.
const EXTRA_BIN_DIRS: [&str; 4] = [
    ".local/bin",
    ".cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];

struct Run {
    window: String,
    /// The agent leads a process group of its own, so its id names the
    /// whole group: the agent and everything it started.
    group: i32,
}

/// Stops an agent and everything it started, such as a test run or a tool
/// server. Killing only the agent would leave those running.
fn stop_group(group: i32) {
    // SAFETY: `killpg` takes plain integers and touches no memory of ours.
    // The group id came from a child this process spawned as a group leader.
    unsafe {
        libc::killpg(group, libc::SIGTERM);
    }
}

type Runs = Arc<Mutex<HashMap<String, Run>>>;

#[derive(Default)]
pub struct AgentState {
    runs: Runs,
}

impl AgentState {
    /// Stops every run a window started. See `PtyState::kill_window`.
    pub fn kill_window(&self, window: &str) {
        let Ok(mut runs) = self.runs.lock() else {
            return;
        };
        let ids: Vec<String> = runs
            .iter()
            .filter(|(_, run)| run.window == window)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(run) = runs.remove(&id) {
                stop_group(run.group);
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunExit {
    /// Null when the process was killed by a signal.
    exit_code: Option<i32>,
    stderr: String,
}

pub fn is_allowed_agent(name: &str) -> bool {
    ALLOWED_AGENTS.contains(&name)
}

fn bin_dirs(home: Option<&str>) -> Vec<PathBuf> {
    EXTRA_BIN_DIRS
        .iter()
        .filter_map(|dir| {
            if dir.starts_with('/') {
                Some(PathBuf::from(dir))
            } else {
                home.map(|home| PathBuf::from(home).join(dir))
            }
        })
        .collect()
}

/// The PATH an agent runs with: the usual install directories first, then
/// whatever the app inherited.
pub fn agent_path(home: Option<&str>, inherited: Option<&str>) -> String {
    let mut parts: Vec<String> = bin_dirs(home)
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    if let Some(inherited) = inherited {
        parts.extend(
            inherited
                .split(':')
                .filter(|part| !part.is_empty())
                .map(String::from),
        );
    }
    parts.join(":")
}

fn find_agent(name: &str, home: Option<&str>) -> Option<PathBuf> {
    let inherited = std::env::var("PATH").unwrap_or_default();
    agent_path(home, Some(&inherited))
        .split(':')
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|candidate| candidate.is_file())
}

/// Runs one agent command to completion, streaming each line of its standard
/// output. `prompt` is written to its standard input, which is then closed.
///
/// Rust knows nothing about what the lines mean. Choosing flags and reading
/// the agent's JSON events is the chat pane's job.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn agent_run(
    window: WebviewWindow,
    state: State<'_, AgentState>,
    id: String,
    agent: String,
    args: Vec<String>,
    cwd: Option<String>,
    prompt: Option<String>,
    on_line: Channel<String>,
    on_exit: Channel<RunExit>,
) -> Result<(), String> {
    if !is_allowed_agent(&agent) {
        return Err(format!("{agent} is not an agent this app may start"));
    }
    let home = std::env::var("HOME").ok();
    let program = find_agent(&agent, home.as_deref())
        .ok_or_else(|| format!("{agent} was not found. Is it installed?"))?;

    let mut command = Command::new(program);
    command
        .args(args)
        .env(
            "PATH",
            agent_path(home.as_deref(), std::env::var("PATH").ok().as_deref()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    match cwd {
        Some(dir) => {
            command.current_dir(expand_home(&dir, home.as_deref()));
        }
        None => {
            if let Some(home) = &home {
                command.current_dir(home);
            }
        }
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("start {agent}: {error}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let group = i32::try_from(child.id()).map_err(|_| String::from("process id out of range"))?;

    {
        let mut runs = state
            .runs
            .lock()
            .map_err(|_| String::from("run table is poisoned"))?;
        runs.insert(
            id.clone(),
            Run {
                window: window.label().to_string(),
                group,
            },
        );
    }

    thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            if let Some(prompt) = prompt {
                let _ = stdin.write_all(prompt.as_bytes());
            }
            // Dropping stdin closes it, which tells the agent the prompt is complete.
        }
    });

    let stderr_reader = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });

    let runs = Arc::clone(&state.runs);
    thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if on_line.send(line).is_err() {
                    break;
                }
            }
        }
        let stderr = stderr_reader.join().unwrap_or_default();
        let exit_code = child.wait().ok().and_then(|status| status.code());
        if let Ok(mut runs) = runs.lock() {
            runs.remove(&id);
        }
        let _ = on_exit.send(RunExit { exit_code, stderr });
    });

    Ok(())
}

/// Stops a run. An unknown id is not an error: the run may have finished.
#[tauri::command(async)]
pub fn agent_cancel(state: State<'_, AgentState>, id: String) -> Result<(), String> {
    let run = state
        .runs
        .lock()
        .map_err(|_| String::from("run table is poisoned"))?
        .remove(&id);
    if let Some(run) = run {
        stop_group(run.group);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_a_group_ends_the_child_and_what_it_started() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let group = i32::try_from(child.id()).unwrap();
        // Give the shell a moment to start its background job.
        std::thread::sleep(std::time::Duration::from_millis(150));

        stop_group(group);
        let status = child.wait().unwrap();
        assert!(!status.success());

        std::thread::sleep(std::time::Duration::from_millis(150));
        // SAFETY: signal 0 only asks whether the group still has members.
        let alive = unsafe { libc::killpg(group, 0) } == 0;
        assert!(!alive, "a process in the group outlived the stop");
    }

    #[test]
    fn only_listed_agents_are_allowed() {
        assert!(is_allowed_agent("claude"));
        assert!(is_allowed_agent("codex"));
        assert!(!is_allowed_agent("sh"));
        assert!(!is_allowed_agent("/bin/rm"));
        assert!(!is_allowed_agent("claude; rm -rf ~"));
    }

    #[test]
    fn install_directories_come_before_the_inherited_path() {
        let path = agent_path(Some("/Users/x"), Some("/usr/bin:/bin"));
        assert_eq!(
            path,
            "/Users/x/.local/bin:/Users/x/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn works_without_a_home_or_an_inherited_path() {
        assert_eq!(agent_path(None, None), "/opt/homebrew/bin:/usr/local/bin");
        assert_eq!(
            agent_path(None, Some("")),
            "/opt/homebrew/bin:/usr/local/bin"
        );
    }
}
