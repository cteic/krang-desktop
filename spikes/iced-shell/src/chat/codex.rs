//! `codex exec --json`, as the current app reads it.

use serde_json::Value;

use super::event::{AgentEvent, Line, Usage, one_line, parse_json_line, str_at};
use super::{Mode, RunRequest};

/// The arguments for one message. The final `-` says the prompt is on
/// standard input. `codex exec resume` takes neither `-s` nor `-C`, so a
/// follow-up sets the sandbox through config and relies on the process's own
/// working directory.
pub fn args(request: &RunRequest) -> Vec<String> {
    let sandbox = match request.mode {
        Mode::ReadOnly => "read-only",
        Mode::Edit => "workspace-write",
    };
    let mut args: Vec<String> = Vec::new();
    if let Some(session) = &request.session_id {
        args.extend(
            [
                "exec",
                "resume",
                session,
                "--json",
                "--skip-git-repo-check",
                "-c",
            ]
            .map(String::from),
        );
        args.push(format!("sandbox_mode=\"{sandbox}\""));
    } else {
        args.extend(["exec", "--json", "--skip-git-repo-check"].map(String::from));
        if let Some(directory) = request
            .directory
            .as_deref()
            .filter(|dir| dir.starts_with('/'))
        {
            args.extend(["-C".into(), directory.to_string()]);
        }
        args.extend(["-s".into(), sandbox.into()]);
    }
    if let Some(kd) = &request.kd {
        args.extend(kd_config(kd));
    }
    args.push("-".into());
    args
}

/// Codex's config for the `kd` server. Codex hands an MCP server only the
/// variables it is told to, so the three the secret travels in are named.
fn kd_config(kd: &super::KdLink) -> Vec<String> {
    let quote = |text: &str| serde_json::Value::from(text).to_string();
    let list = |items: &[&str]| {
        let quoted: Vec<String> = items.iter().map(|item| quote(item)).collect();
        format!("[{}]", quoted.join(","))
    };
    let server = format!("mcp_servers.{}", super::KD_SERVER);
    let env = [
        crate::kd::protocol::ENV_SOCKET,
        crate::kd::protocol::ENV_PANE,
        crate::kd::protocol::ENV_TOKEN,
    ];
    [
        format!("{server}.command={}", quote(&kd.cli)),
        format!("{server}.args=[\"mcp\"]"),
        format!("{server}.env_vars={}", list(&env)),
        format!("{server}.enabled_tools={}", list(kd.tools())),
    ]
    .into_iter()
    // `codex exec` never asks, so a tool that needs approval fails. Only
    // the tools that show things are approved; `kd_term` and `kd_chat`
    // stay refused, as Codex's own shell would be.
    .chain(
        super::KD_SAFE_TOOLS
            .iter()
            .map(|tool| format!("{server}.tools.{tool}.approval_mode=\"approve\"")),
    )
    .flat_map(|setting| [String::from("-c"), setting])
    .collect()
}

fn tool(item: &Value, name: &str, summary: String) -> AgentEvent {
    AgentEvent::Tool {
        id: str_at(item, "id").map(String::from),
        name: name.to_string(),
        summary,
    }
}

fn item_events(item: &Value, completed: bool) -> Vec<AgentEvent> {
    let text = |key: &str| str_at(item, key).unwrap_or("");
    match str_at(item, "type") {
        Some("agent_message") if completed && !text("text").is_empty() => {
            vec![AgentEvent::Text(text("text").to_string())]
        }
        Some("command_execution") => vec![tool(item, "Run", one_line(text("command")))],
        Some("file_change") => {
            let paths: Vec<&str> = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .filter_map(|change| str_at(change, "path"))
                        .collect()
                })
                .unwrap_or_default();
            vec![tool(item, "Edit", one_line(&paths.join(", ")))]
        }
        Some("mcp_tool_call") => {
            let name = [text("server"), text("tool")]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(".");
            vec![tool(
                item,
                if name.is_empty() { "Tool" } else { &name },
                String::new(),
            )]
        }
        Some("web_search") => vec![tool(item, "Search", one_line(text("query")))],
        Some("todo_list") => {
            let steps = item
                .get("items")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            vec![tool(item, "Plan", format!("{steps} steps"))]
        }
        // An error item is a warning inside a turn that carries on.
        Some("error") if completed => str_at(item, "message")
            .map(|message| vec![AgentEvent::Note(message.to_string())])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let value = match parse_json_line(line) {
        Line::Blank => return Vec::new(),
        Line::Note(note) => return vec![note],
        Line::Json(value) => value,
    };
    match str_at(&value, "type") {
        Some("thread.started") => str_at(&value, "thread_id")
            .map(|id| vec![AgentEvent::Session(id.to_string())])
            .unwrap_or_default(),
        Some(kind @ ("item.started" | "item.updated" | "item.completed")) => value
            .get("item")
            .map(|item| item_events(item, kind == "item.completed"))
            .unwrap_or_default(),
        Some("turn.completed") => {
            let tokens = |key: &str| {
                value
                    .pointer(&format!("/usage/{key}"))
                    .and_then(Value::as_u64)
            };
            let input = match (tokens("input_tokens"), tokens("cached_input_tokens")) {
                (Some(a), Some(b)) => Some(a + b),
                (a, b) => a.or(b),
            };
            vec![AgentEvent::Done(Usage {
                cost_usd: None,
                input_tokens: input,
                output_tokens: tokens("output_tokens"),
            })]
        }
        Some("turn.failed") => vec![AgentEvent::Error(
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The turn failed")
                .to_string(),
        )],
        Some("error") => vec![AgentEvent::Error(
            str_at(&value, "message")
                .unwrap_or("The agent reported an error")
                .to_string(),
        )],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_only_chat_gets_the_safe_kd_tools_approved() {
        let request = RunRequest {
            mode: Mode::ReadOnly,
            directory: None,
            session_id: None,
            trusted: false,
            kd: Some(crate::chat::KdLink {
                cli: String::from("/run/kd"),
                safe: true,
            }),
        };
        let args = args(&request);
        let has = |setting: &str| args.iter().any(|arg| arg == setting);
        assert!(has("mcp_servers.kd.command=\"/run/kd\""));
        assert!(has(
            "mcp_servers.kd.env_vars=[\"KRANG_SOCKET\",\"KRANG_PANE_ID\",\"KRANG_PANE_TOKEN\"]"
        ));
        assert!(has(
            "mcp_servers.kd.enabled_tools=[\"kd_view\",\"kd_web\",\"kd_panes\",\"kd_title\"]"
        ));
        assert!(has(
            "mcp_servers.kd.tools.kd_view.approval_mode=\"approve\""
        ));
        assert!(!args.iter().any(|arg| arg.contains("kd_term")));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn first_message_and_follow_up_arguments() {
        let first = RunRequest {
            mode: Mode::ReadOnly,
            directory: Some("/w".into()),
            session_id: None,
            trusted: false,
            kd: None,
        };
        assert_eq!(
            args(&first).join(" "),
            "exec --json --skip-git-repo-check -C /w -s read-only -"
        );
        let next = RunRequest {
            session_id: Some("t1".into()),
            mode: Mode::Edit,
            ..first
        };
        assert_eq!(
            args(&next).join(" "),
            "exec resume t1 --json --skip-git-repo-check -c sandbox_mode=\"workspace-write\" -"
        );
    }

    #[test]
    fn reads_a_turn() {
        let lines = [
            r#"{"type":"thread.started","thread_id":"th"}"#,
            r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls"}}"#,
            r#"{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Done."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":4}}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|line| parse_line(line)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session("th".into()),
                AgentEvent::Tool {
                    id: Some("i1".into()),
                    name: "Run".into(),
                    summary: "ls".into()
                },
                AgentEvent::Text("Done.".into()),
                AgentEvent::Done(Usage {
                    cost_usd: None,
                    input_tokens: Some(12),
                    output_tokens: Some(4)
                }),
            ]
        );
    }

    #[test]
    fn a_failed_turn_is_an_error() {
        assert_eq!(
            parse_line(r#"{"type":"turn.failed","error":{"message":"quota"}}"#),
            [AgentEvent::Error("quota".into())]
        );
    }
}
