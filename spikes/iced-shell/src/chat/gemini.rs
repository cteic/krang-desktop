//! Gemini CLI's headless `--output-format stream-json`. Each line is one
//! event: `init`, `message`, `tool_use`, `tool_result`, `error` or `result`.

use serde_json::Value;

use super::claude::summarise_tool_input;
use super::event::{AgentEvent, Line, Usage, parse_json_line, str_at};
use super::{Mode, RunRequest};

/// The arguments for one message. The prompt goes on standard input, which
/// is a pipe, so Gemini CLI runs headless without `-p`.
///
/// Read only is the `plan` approval mode, and edit is `auto_edit`, which
/// accepts file edits but still denies a shell command it would ask about.
/// Headless, a question Gemini would put to the person becomes a no.
///
/// An untrusted folder gets no `--skip-trust`. Gemini then refuses to run
/// there, unless the person trusted the folder in Gemini itself, so the
/// folder's own settings never load before the person says yes.
pub fn args(request: &RunRequest) -> Vec<String> {
    let approval = match request.mode {
        Mode::ReadOnly => "plan",
        Mode::Edit => "auto_edit",
    };
    let mut args: Vec<String> = [
        "--output-format",
        "stream-json",
        "--approval-mode",
        approval,
    ]
    .map(String::from)
    .to_vec();
    if request.trusted {
        args.push("--skip-trust".into());
    }
    if let Some(session) = &request.session_id {
        args.extend(["--resume".into(), session.clone()]);
    }
    args
}

fn message_events(value: &Value) -> Vec<AgentEvent> {
    if str_at(value, "role") != Some("assistant") {
        return Vec::new();
    }
    let Some(content) = str_at(value, "content").filter(|text| !text.is_empty()) else {
        return Vec::new();
    };
    if value.get("delta").and_then(Value::as_bool) == Some(true) {
        vec![AgentEvent::TextDelta(content.to_string())]
    } else {
        vec![AgentEvent::Text(content.to_string())]
    }
}

fn error_message(value: &Value) -> Option<&str> {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
}

fn result_events(value: &Value) -> Vec<AgentEvent> {
    if str_at(value, "status") != Some("success") {
        return vec![AgentEvent::Error(
            error_message(value)
                .unwrap_or("The turn failed")
                .to_string(),
        )];
    }
    // `input_tokens` already counts the cached part of the prompt.
    let tokens = |key: &str| {
        value
            .pointer(&format!("/stats/{key}"))
            .and_then(Value::as_u64)
    };
    vec![AgentEvent::Done(Usage {
        cost_usd: None,
        input_tokens: tokens("input_tokens"),
        output_tokens: tokens("output_tokens"),
    })]
}

/// Reads one line. An event type this does not know gives no events.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let value = match parse_json_line(line) {
        Line::Blank => return Vec::new(),
        Line::Note(note) => return vec![note],
        Line::Json(value) => value,
    };
    match str_at(&value, "type") {
        Some("init") => str_at(&value, "session_id")
            .map(|id| vec![AgentEvent::Session(id.to_string())])
            .unwrap_or_default(),
        Some("message") => message_events(&value),
        Some("tool_use") => match str_at(&value, "tool_name") {
            Some(name) => vec![AgentEvent::Tool {
                id: str_at(&value, "tool_id").map(String::from),
                name: name.to_string(),
                summary: value
                    .get("parameters")
                    .map(summarise_tool_input)
                    .unwrap_or_default(),
            }],
            None => Vec::new(),
        },
        // A tool that failed is told to the model, and the turn carries on.
        Some("tool_result") if str_at(&value, "status") == Some("error") => error_message(&value)
            .map(|message| vec![AgentEvent::Note(message.to_string())])
            .unwrap_or_default(),
        Some("error") => match (str_at(&value, "severity"), str_at(&value, "message")) {
            (Some("error"), message) => vec![AgentEvent::Error(
                message.unwrap_or("The agent reported an error").to_string(),
            )],
            (_, Some(message)) => vec![AgentEvent::Note(message.to_string())],
            _ => Vec::new(),
        },
        Some("result") => result_events(&value),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(mode: Mode, session: Option<&str>, trusted: bool) -> RunRequest {
        RunRequest {
            mode,
            directory: Some("/w".into()),
            session_id: session.map(String::from),
            trusted,
        }
    }

    #[test]
    fn a_first_untrusted_read_only_message() {
        assert_eq!(
            args(&request(Mode::ReadOnly, None, false)).join(" "),
            "--output-format stream-json --approval-mode plan"
        );
    }

    #[test]
    fn a_trusted_follow_up_in_edit_mode_resumes() {
        assert_eq!(
            args(&request(Mode::Edit, Some("s-1"), true)).join(" "),
            "--output-format stream-json --approval-mode auto_edit --skip-trust --resume s-1"
        );
    }

    #[test]
    fn no_mode_approves_everything() {
        for mode in [Mode::ReadOnly, Mode::Edit] {
            for trusted in [false, true] {
                let args = args(&request(mode, None, trusted));
                assert!(
                    !args
                        .iter()
                        .any(|arg| arg == "yolo" || arg == "--yolo" || arg == "-y")
                );
            }
        }
    }

    // The lines below are the shapes in Gemini CLI's own formatter tests,
    // packages/core/src/output/stream-json-formatter.test.ts.
    #[test]
    fn reads_a_turn() {
        let lines = [
            r#"{"type":"init","timestamp":"2025-10-10T12:00:00.000Z","session_id":"test-session-123","model":"gemini-2.0-flash-exp"}"#,
            r#"{"type":"message","timestamp":"2025-10-10T12:00:00.000Z","role":"user","content":"What is 2+2?"}"#,
            r#"{"type":"tool_use","timestamp":"2025-10-10T12:00:00.000Z","tool_name":"Read","tool_id":"read-123","parameters":{"file_path":"/path/to/file.txt"}}"#,
            r#"{"type":"tool_result","timestamp":"2025-10-10T12:00:00.000Z","tool_id":"read-123","status":"success","output":"File contents here"}"#,
            r#"{"type":"message","timestamp":"2025-10-10T12:00:00.000Z","role":"assistant","content":"4","delta":true}"#,
            r#"{"type":"result","timestamp":"2025-10-10T12:00:00.000Z","status":"success","stats":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"cached":0,"input":50,"duration_ms":1200,"tool_calls":2,"models":{}}}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|line| parse_line(line)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session("test-session-123".into()),
                AgentEvent::Tool {
                    id: Some("read-123".into()),
                    name: "Read".into(),
                    summary: "/path/to/file.txt".into()
                },
                AgentEvent::TextDelta("4".into()),
                AgentEvent::Done(Usage {
                    cost_usd: None,
                    input_tokens: Some(50),
                    output_tokens: Some(50)
                }),
            ]
        );
    }

    #[test]
    fn a_whole_message_is_text() {
        assert_eq!(
            parse_line(r#"{"type":"message","role":"assistant","content":"Hello"}"#),
            [AgentEvent::Text("Hello".into())]
        );
    }

    #[test]
    fn failures_and_warnings() {
        assert_eq!(
            parse_line(
                r#"{"type":"result","timestamp":"2025-10-10T12:00:00.000Z","status":"error","error":{"type":"MaxSessionTurnsError","message":"Maximum session turns exceeded"},"stats":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"cached":0,"input":50,"duration_ms":1200,"tool_calls":0,"models":{}}}"#
            ),
            [AgentEvent::Error("Maximum session turns exceeded".into())]
        );
        assert_eq!(
            parse_line(r#"{"type":"result","status":"error"}"#),
            [AgentEvent::Error("The turn failed".into())]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"error","timestamp":"2025-10-10T12:00:00.000Z","severity":"warning","message":"Loop detected, stopping execution"}"#
            ),
            [AgentEvent::Note("Loop detected, stopping execution".into())]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"error","severity":"error","message":"Maximum session turns exceeded"}"#
            ),
            [AgentEvent::Error("Maximum session turns exceeded".into())]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"tool_result","timestamp":"2025-10-10T12:00:00.000Z","tool_id":"read-123","status":"error","error":{"type":"FILE_NOT_FOUND","message":"File not found"}}"#
            ),
            [AgentEvent::Note("File not found".into())]
        );
    }

    #[test]
    fn unreadable_and_unknown_lines() {
        assert_eq!(
            parse_line("Loaded cached credentials."),
            [AgentEvent::Note("Loaded cached credentials.".into())]
        );
        assert!(parse_line(r#"{"type":"other"}"#).is_empty());
        assert!(parse_line(r#"{"type":"message","role":"assistant","content":""}"#).is_empty());
        assert!(parse_line("").is_empty());
    }
}
