//! The chat pane's model: agents, their stream formats and the transcript.

pub mod claude;
pub mod codex;
pub mod event;
pub mod runner;
pub mod transcript;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    #[default]
    Claude,
    Codex,
}

impl Agent {
    pub fn program(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }

    /// The variable that names another program to run, such as a fake agent.
    pub fn override_env(self) -> &'static str {
        match self {
            Agent::Claude => "KRANG_CLAUDE_BIN",
            Agent::Codex => "KRANG_CODEX_BIN",
        }
    }

    pub fn args(self, request: &RunRequest) -> Vec<String> {
        match self {
            Agent::Claude => claude::args(request),
            Agent::Codex => codex::args(request),
        }
    }

    pub fn parse_line(self, line: &str) -> Vec<event::AgentEvent> {
        match self {
            Agent::Claude => claude::parse_line(line),
            Agent::Codex => codex::parse_line(line),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
        }
    }
}

/// What a chat may do to the machine. No mode turns off an agent's own
/// permission checks or its sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    #[default]
    ReadOnly,
    Edit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunRequest {
    pub mode: Mode,
    pub directory: Option<String>,
    pub session_id: Option<String>,
    /// Whether the person trusted the directory. Until then its own agent
    /// settings must not load.
    pub trusted: bool,
}
