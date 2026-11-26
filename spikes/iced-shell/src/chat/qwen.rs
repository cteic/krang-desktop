//! Qwen Code, headless, pointed at the local Ollama. It is an agent with
//! tools, like Claude Code, and its `--output-format stream-json` has the
//! same shape as Claude Code's, so Claude's reader reads it.
//!
//! The model and the host come from `KRANG_QWEN_MODEL` and `OLLAMA_HOST`.
//! A turn on the owner's own machine costs nothing, so a turn that gives no
//! price is counted at $0.

use super::event::AgentEvent;
use super::{KdLink, Mode, RunRequest};

pub const DEFAULT_MODEL: &str = "qwen3.6:35b-a3b-coding-mxfp8";
pub const ENV_MODEL: &str = "KRANG_QWEN_MODEL";

/// Ollama takes any key on its OpenAI-style endpoint. Qwen Code refuses to
/// start without one, so this placeholder stands in.
const OLLAMA_KEY: &str = "ollama";

/// The arguments for one message. The prompt goes on standard input.
///
/// Read only is the `plan` approval mode and edit is `auto-edit`. An
/// untrusted folder runs in `--safe-mode`, which keeps the folder's own
/// context files, hooks, skills and MCP servers out. That also leaves out
/// the `kd` server, so `kd` tools start once the person trusts the folder.
pub fn args(request: &RunRequest) -> Vec<String> {
    let model = std::env::var(ENV_MODEL)
        .ok()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| String::from(DEFAULT_MODEL));
    args_for(request, &model, &base_url())
}

fn args_for(request: &RunRequest, model: &str, base_url: &str) -> Vec<String> {
    let approval = match request.mode {
        Mode::ReadOnly => "plan",
        Mode::Edit => "auto-edit",
    };
    let mut args: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--auth-type".into(),
        "openai".into(),
        "--openai-base-url".into(),
        base_url.into(),
        "--openai-api-key".into(),
        OLLAMA_KEY.into(),
        "--model".into(),
        model.into(),
        "--approval-mode".into(),
        approval.into(),
    ];
    if !request.trusted {
        args.push("--safe-mode".into());
    } else if let Some(kd) = &request.kd {
        args.extend(["--mcp-config".into(), mcp_config(kd)]);
        args.extend(["--allowed-mcp-server-names".into(), super::KD_SERVER.into()]);
        // Plan mode blocks every MCP tool as not read-only, unless it is
        // allowed by name. Only the tools that show things are, so in edit
        // mode `kd_term` and `kd_chat` still ask, and headless that is a no.
        args.push("--allowed-tools".into());
        args.extend(
            super::KD_SAFE_TOOLS
                .iter()
                .filter(|tool| kd.tools().contains(tool))
                .map(|tool| format!("mcp__{}__{tool}", super::KD_SERVER)),
        );
    }
    if let Some(session) = &request.session_id {
        args.extend(["--resume".into(), session.clone()]);
    }
    args
}

/// The server inherits the agent's environment, so the secret reaches it
/// in the three `KRANG_` variables and never sits in an argument. Qwen Code
/// does not expand `$NAME` in a config's `env`, so the config has none.
fn mcp_config(kd: &KdLink) -> String {
    serde_json::json!({
        "mcpServers": {
            super::KD_SERVER: {
                "command": kd.cli,
                "args": ["mcp"],
                "includeTools": kd.tools(),
            }
        }
    })
    .to_string()
}

/// Ollama's OpenAI-style endpoint, from `OLLAMA_HOST` as the Local agent
/// reads it.
fn base_url() -> String {
    let host = std::env::var(super::local::ENV_HOST)
        .ok()
        .map(|host| host.trim().trim_end_matches('/').to_string())
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| String::from(super::local::DEFAULT_HOST));
    let host = if host.contains("://") {
        host
    } else {
        format!("http://{host}")
    };
    format!("{host}/v1")
}

pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    super::claude::parse_line(line)
        .into_iter()
        .map(|event| match event {
            AgentEvent::Done(mut usage) => {
                usage.cost_usd = usage.cost_usd.or(Some(0.0));
                AgentEvent::Done(usage)
            }
            other => other,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::event::Usage;

    fn request(mode: Mode, trusted: bool, kd: Option<KdLink>) -> RunRequest {
        RunRequest {
            mode,
            directory: None,
            session_id: None,
            trusted,
            kd,
        }
    }

    fn link(safe: bool) -> KdLink {
        KdLink {
            cli: String::from("/run/kd"),
            safe,
        }
    }

    #[test]
    fn an_untrusted_folder_runs_safe_and_gets_no_kd() {
        let args = args_for(
            &request(Mode::ReadOnly, false, Some(link(true))),
            "m",
            "http://h/v1",
        );
        assert!(args.contains(&String::from("--safe-mode")));
        assert!(!args.contains(&String::from("--mcp-config")));
        assert_eq!(
            args[..12].join(" "),
            "--output-format stream-json --auth-type openai --openai-base-url http://h/v1 \
             --openai-api-key ollama --model m --approval-mode plan"
        );
    }

    #[test]
    fn a_trusted_read_only_chat_gets_only_the_safe_tools() {
        let args = args_for(&request(Mode::ReadOnly, true, Some(link(true))), "m", "u");
        let at = args.iter().position(|arg| arg == "--mcp-config");
        let config: serde_json::Value = at
            .and_then(|at| args.get(at + 1))
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default();
        let server = &config["mcpServers"]["kd"];
        assert_eq!(server["command"], "/run/kd");
        assert!(server.get("env").is_none());
        assert!(args.contains(&String::from("mcp__kd__kd_view")));
        assert!(!args.iter().any(|arg| arg.contains("kd_term")));
        assert_eq!(
            server["includeTools"],
            serde_json::json!(["kd_view", "kd_web", "kd_panes", "kd_title"])
        );
        assert!(!args.iter().any(|arg| arg == "--safe-mode"));
    }

    #[test]
    fn a_local_turn_with_no_price_costs_nothing() {
        let line = r#"{"type":"result","subtype":"success","session_id":"s","usage":{"input_tokens":5,"output_tokens":7}}"#;
        let done = parse_line(line).into_iter().find_map(|event| match event {
            AgentEvent::Done(usage) => Some(usage),
            _ => None,
        });
        assert_eq!(
            done,
            Some(Usage {
                cost_usd: Some(0.0),
                input_tokens: Some(5),
                output_tokens: Some(7),
            })
        );
    }
}
