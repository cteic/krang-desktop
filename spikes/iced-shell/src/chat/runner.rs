//! Starts an agent as the current app does: in a process group of its own,
//! prompt on standard input, each line of standard output streamed back.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use tokio::sync::mpsc::UnboundedSender;

use super::Agent;

#[derive(Debug, Clone)]
pub enum RunOutput {
    Line(String),
    Exit { code: Option<i32>, stderr: String },
}

#[derive(Debug, Clone)]
pub struct RunEvent {
    pub pane: u64,
    pub run: u64,
    pub output: RunOutput,
}

/// Where agents are usually installed. An app opened from the Dock inherits
/// a bare PATH that has none of these.
const EXTRA_BIN_DIRS: [&str; 4] = [
    ".local/bin",
    ".cargo/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];

pub fn agent_path(home: Option<&Path>, inherited: Option<&str>) -> String {
    let mut parts: Vec<String> = EXTRA_BIN_DIRS
        .iter()
        .filter_map(|dir| {
            if dir.starts_with('/') {
                Some(dir.to_string())
            } else {
                home.map(|home| home.join(dir).to_string_lossy().into_owned())
            }
        })
        .collect();
    parts.extend(
        inherited
            .unwrap_or("")
            .split(':')
            .filter(|part| !part.is_empty())
            .map(String::from),
    );
    parts.join(":")
}

/// The program for an agent: the override from the environment when set,
/// which is how the tests run a fake agent, or the first match on the path.
/// Local is this app's own binary, whatever it is called.
pub fn find_agent(agent: Agent, path: &str) -> Option<PathBuf> {
    if let Some(program) = std::env::var_os(agent.override_env()).filter(|value| !value.is_empty())
    {
        return Some(PathBuf::from(program));
    }
    if agent == Agent::Local {
        return std::env::current_exe().ok();
    }
    path.split(':')
        .map(|dir| Path::new(dir).join(agent.program()))
        .find(|candidate| candidate.is_file())
}

pub struct Started {
    /// The agent leads its own process group, so this id names the agent
    /// and everything it started.
    pub group: i32,
}

/// What the agent is started with, beside its prompt.
#[derive(Debug, Clone, Default)]
pub struct Launch {
    pub args: Vec<String>,
    /// Variables added after the app's own `kd` ones are removed.
    pub env: Vec<(String, String)>,
}

pub fn start(
    agent: Agent,
    launch: Launch,
    directory: Option<&Path>,
    prompt: String,
    pane: u64,
    run: u64,
    sender: UnboundedSender<RunEvent>,
) -> Result<Started, String> {
    let Launch { args, env } = launch;
    let home = dirs::home_dir();
    let path = agent_path(home.as_deref(), std::env::var("PATH").ok().as_deref());
    let program = find_agent(agent, &path)
        .ok_or_else(|| format!("{} was not found. Is it installed?", agent.program()))?;
    let mut command = Command::new(&program);
    command
        .args(args)
        .env("PATH", &path)
        // An agent is not a pane: it must not drive the app as one, even
        // when the app itself was started from inside a pane.
        .env_remove(crate::kd::protocol::ENV_SOCKET)
        .env_remove(crate::kd::protocol::ENV_PANE)
        .env_remove(crate::kd::protocol::ENV_TOKEN)
        .env_remove(crate::kd::protocol::ENV_CLI)
        // What it gets instead is its own chat pane's secret, for the `kd`
        // MCP server it may start.
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(directory) = directory.or(home.as_deref()) {
        command.current_dir(directory);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("start {}: {error}", agent.program()))?;
    let group = i32::try_from(child.id()).map_err(|_| String::from("process id out of range"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(prompt.as_bytes());
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
    thread::spawn(move || {
        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender
                    .send(RunEvent {
                        pane,
                        run,
                        output: RunOutput::Line(line),
                    })
                    .is_err()
                {
                    break;
                }
            }
        }
        let stderr = stderr_reader.join().unwrap_or_default();
        let code = child.wait().ok().and_then(|status| status.code());
        let _ = sender.send(RunEvent {
            pane,
            run,
            output: RunOutput::Exit { code, stderr },
        });
    });
    Ok(Started { group })
}

/// Stops an agent and everything it started, such as a test run. Killing
/// only the agent would leave those running.
pub fn stop_group(group: i32) {
    // SAFETY: `killpg` takes plain integers and touches no memory of ours.
    // The group id came from a child this process spawned as a group leader.
    unsafe {
        libc::killpg(group, libc::SIGTERM);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_a_group_ends_the_child_and_what_it_started() {
        let Ok(mut child) = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
        else {
            panic!("could not start sh");
        };
        let group = i32::try_from(child.id()).unwrap_or_default();
        thread::sleep(std::time::Duration::from_millis(150));
        stop_group(group);
        assert!(child.wait().is_ok_and(|status| !status.success()));
        thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !group_alive(group),
            "a process in the group outlived the stop"
        );
    }

    /// Whether a group has a member that is still running. A container's
    /// first process may never reap orphans, so a zombie does not count.
    #[cfg(target_os = "linux")]
    pub(crate) fn group_alive(group: i32) -> bool {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return false;
        };
        entries.flatten().any(|entry| {
            let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
            // The fields after the command name: state, ppid, pgrp.
            let after = stat.rsplit_once(')').map(|(_, rest)| rest).unwrap_or("");
            let fields: Vec<&str> = after.split_whitespace().collect();
            fields.len() > 2 && fields[0] != "Z" && fields[2] == group.to_string()
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn group_alive(group: i32) -> bool {
        // SAFETY: signal 0 only asks whether the group still has members.
        unsafe { libc::killpg(group, 0) == 0 }
    }

    #[test]
    fn install_directories_come_before_the_inherited_path() {
        assert_eq!(
            agent_path(Some(Path::new("/Users/x")), Some("/usr/bin:/bin")),
            "/Users/x/.local/bin:/Users/x/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        );
        assert_eq!(agent_path(None, None), "/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn streams_lines_then_the_exit() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let dir = std::env::temp_dir().join(format!("krang-runner-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let script = dir.join("claude");
        let _ = std::fs::write(
            &script,
            "#!/bin/sh\nread prompt\necho \"got $prompt\"\necho oops >&2\nexit 3\n",
        );
        let _ =
            std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755));
        let args = vec![];
        // SAFETY of the test: the variable is set before any thread reads it.
        unsafe { std::env::set_var(Agent::Claude.override_env(), &script) };
        let started = start(
            Agent::Claude,
            Launch {
                args,
                env: Vec::new(),
            },
            Some(&dir),
            "hello\n".into(),
            1,
            9,
            sender,
        );
        assert!(started.is_ok());
        let mut seen = Vec::new();
        while let Some(event) = receiver.blocking_recv() {
            assert_eq!((event.pane, event.run), (1, 9));
            let done = matches!(event.output, RunOutput::Exit { .. });
            seen.push(format!("{:?}", event.output));
            if done {
                break;
            }
        }
        assert_eq!(
            seen,
            [
                r#"Line("got hello")"#,
                r#"Exit { code: Some(3), stderr: "oops\n" }"#
            ]
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
