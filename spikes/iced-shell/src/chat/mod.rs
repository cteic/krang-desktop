//! The chat pane's model: agents, their stream formats and the transcript.

pub mod claude;
pub mod codex;
pub mod event;
pub mod gemini;
pub mod local;
pub mod qwen;
pub mod runner;
pub mod transcript;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    #[default]
    Claude,
    Codex,
    Gemini,
    /// Qwen Code, an agent with tools, driving a model on the local Ollama.
    Qwen,
    /// A model on the local Ollama, run by this app's own binary.
    Local,
}

impl Agent {
    pub const ALL: [Agent; 5] = [
        Agent::Claude,
        Agent::Codex,
        Agent::Gemini,
        Agent::Qwen,
        Agent::Local,
    ];

    /// The program to look for on the path. Local runs this app's own
    /// binary instead, see `runner::find_agent`.
    pub fn program(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Gemini => "gemini",
            Agent::Qwen => "qwen",
            Agent::Local => "krang-shell",
        }
    }

    /// The variable that names another program to run, such as a fake agent.
    pub fn override_env(self) -> &'static str {
        match self {
            Agent::Claude => "KRANG_CLAUDE_BIN",
            Agent::Codex => "KRANG_CODEX_BIN",
            Agent::Gemini => "KRANG_GEMINI_BIN",
            Agent::Qwen => "KRANG_QWEN_BIN",
            Agent::Local => "KRANG_LOCAL_BIN",
        }
    }

    pub fn args(self, request: &RunRequest) -> Vec<String> {
        match self {
            Agent::Claude => claude::args(request),
            Agent::Codex => codex::args(request),
            Agent::Gemini => gemini::args(request),
            Agent::Qwen => qwen::args(request),
            Agent::Local => local::args(request),
        }
    }

    pub fn parse_line(self, line: &str) -> Vec<event::AgentEvent> {
        match self {
            Agent::Claude => claude::parse_line(line),
            Agent::Codex => codex::parse_line(line),
            Agent::Gemini => gemini::parse_line(line),
            Agent::Qwen => qwen::parse_line(line),
            Agent::Local => local::parse_line(line),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
            Agent::Gemini => "Gemini",
            Agent::Qwen => "Qwen Code (local)",
            Agent::Local => "Local (text only)",
        }
    }

    /// The name layouts, saved workspaces and `kd chat --agent` use.
    pub fn name(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Gemini => "gemini",
            Agent::Qwen => "qwen",
            Agent::Local => "local",
        }
    }

    pub fn from_name(name: &str) -> Option<Agent> {
        Agent::ALL.into_iter().find(|agent| agent.name() == name)
    }

    /// The agent after this one, for the chat pane's switcher.
    pub fn next(self) -> Agent {
        let at = Agent::ALL
            .iter()
            .position(|agent| *agent == self)
            .unwrap_or(0);
        Agent::ALL[(at + 1) % Agent::ALL.len()]
    }

    /// Whether the agent reads a directory's own settings, and so waits on
    /// the person's trust first.
    pub fn asks_trust(self) -> bool {
        matches!(self, Agent::Claude | Agent::Gemini | Agent::Qwen)
    }

    /// Whether the agent has tools, so read only and edit mean something.
    /// Local only writes text.
    pub fn has_tools(self) -> bool {
        self != Agent::Local
    }

    /// Whether the app hands the agent the `kd` MCP server. Gemini CLI has
    /// no flag for a server, only its settings files, so it gets none yet.
    pub fn takes_kd(self) -> bool {
        matches!(self, Agent::Claude | Agent::Codex | Agent::Qwen)
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
    /// How the agent reaches this window's `kd` tools, when it may.
    pub kd: Option<KdLink>,
}

/// The `kd` MCP server an agent is given: the program to run as
/// `<cli> mcp`, and whether its secret covers only the safe commands. The
/// secret itself reaches the server through the agent's environment, never
/// its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KdLink {
    pub cli: String,
    pub safe: bool,
}

/// The tools that only show things. A read-only chat gets just these.
pub const KD_SAFE_TOOLS: [&str; 4] = ["kd_view", "kd_web", "kd_panes", "kd_title"];
/// Every tool `kd mcp` serves.
pub const KD_ALL_TOOLS: [&str; 6] = [
    "kd_view", "kd_web", "kd_panes", "kd_title", "kd_term", "kd_chat",
];
/// The name agents know the server by, so Claude's tools are `mcp__kd__kd_view`.
pub const KD_SERVER: &str = "kd";

impl KdLink {
    /// The tools this link's secret may use.
    pub fn tools(&self) -> &'static [&'static str] {
        if self.safe {
            &KD_SAFE_TOOLS
        } else {
            &KD_ALL_TOOLS
        }
    }

    /// The `{"mcpServers": ...}` config Claude Code and Qwen Code take.
    pub fn mcp_config(&self) -> String {
        serde_json::json!({
            "mcpServers": {
                KD_SERVER: { "command": self.cli, "args": ["mcp"] }
            }
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_match_what_is_saved() {
        for agent in Agent::ALL {
            assert_eq!(Agent::from_name(agent.name()), Some(agent));
            assert_eq!(
                serde_json::to_string(&agent).ok(),
                Some(format!("\"{}\"", agent.name()))
            );
        }
        assert_eq!(Agent::from_name("gpt"), None);
        assert_eq!(Agent::Codex.next(), Agent::Gemini);
        assert_eq!(Agent::Local.next(), Agent::Claude);
    }
}
