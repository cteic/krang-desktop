//! Claude Code's `--output-format stream-json`, as the current app reads it.

use serde_json::Value;

use super::event::{AgentEvent, Line, Usage, one_line, parse_json_line, str_at};
use super::{Mode, RunRequest};

/// The input fields that say most about a tool call, most telling first.
const SUMMARY_KEYS: [&str; 9] = [
    "file_path",
    "path",
    "notebook_path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
    "prompt",
];

const DENIED_TOOLS: [&str; 2] = ["Read(.obsidian/**)", "Read(**/.obsidian/**)"];
const EDIT_ALLOWED_TOOLS: [&str; 4] = [
    "Bash(kd node:*)",
    "Bash(kd relate:*)",
    "Bash(kd types:*)",
    "Bash(kd nodes:*)",
];

/// The arguments for one message. The prompt goes on standard input.
pub fn args(request: &RunRequest) -> Vec<String> {
    let permission = match request.mode {
        Mode::ReadOnly => "plan",
        Mode::Edit => "acceptEdits",
    };
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        permission,
    ]
    .map(String::from)
    .to_vec();
    if !request.trusted {
        // Print mode skips the workspace trust question, so this stands in
        // for it: the directory's own settings stay out until the person says yes.
        args.extend(["--setting-sources".into(), "user".into()]);
    }
    args.push("--disallowedTools".into());
    args.extend(DENIED_TOOLS.map(String::from));
    if request.mode == Mode::Edit {
        // The flag takes every word up to the next flag, so it goes last but for `--resume`.
        args.push("--allowedTools".into());
        args.extend(EDIT_ALLOWED_TOOLS.map(String::from));
    }
    if let Some(session) = &request.session_id {
        args.extend(["--resume".into(), session.clone()]);
    }
    args
}

/// One line that says what a tool was asked to do, such as a file path.
pub fn summarise_tool_input(input: &Value) -> String {
    let Some(record) = input.as_object() else {
        return input.as_str().map(one_line).unwrap_or_default();
    };
    let text = |value: &Value| {
        value
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .map(one_line)
    };
    SUMMARY_KEYS
        .iter()
        .find_map(|key| record.get(*key).and_then(text))
        .or_else(|| record.values().find_map(text))
        .unwrap_or_else(|| {
            if record.is_empty() {
                String::new()
            } else {
                one_line(&input.to_string())
            }
        })
}

fn stream_events(value: &Value) -> Vec<AgentEvent> {
    let Some(event) = value.get("event") else {
        return Vec::new();
    };
    match str_at(event, "type") {
        Some("content_block_delta") => {
            let delta = event.get("delta");
            let is_text = delta.and_then(|delta| str_at(delta, "type")) == Some("text_delta");
            match delta.and_then(|delta| str_at(delta, "text")) {
                Some(text) if is_text && !text.is_empty() => {
                    vec![AgentEvent::TextDelta(text.to_string())]
                }
                _ => Vec::new(),
            }
        }
        Some("content_block_start") => {
            let Some(block) = event.get("content_block") else {
                return Vec::new();
            };
            match (str_at(block, "type"), str_at(block, "name")) {
                (Some("tool_use"), Some(name)) => vec![AgentEvent::Tool {
                    id: str_at(block, "id").map(String::from),
                    name: name.to_string(),
                    summary: String::new(),
                }],
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

fn assistant_events(value: &Value) -> Vec<AgentEvent> {
    let Some(content) = value.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|block| match str_at(block, "type")? {
            "text" => str_at(block, "text")
                .filter(|text| !text.is_empty())
                .map(|text| AgentEvent::Text(text.to_string())),
            "tool_use" => Some(AgentEvent::Tool {
                id: str_at(block, "id").map(String::from),
                name: str_at(block, "name")?.to_string(),
                summary: block
                    .get("input")
                    .map(summarise_tool_input)
                    .unwrap_or_default(),
            }),
            _ => None,
        })
        .collect()
}

fn result_events(value: &Value) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    if let Some(session) = str_at(value, "session_id") {
        events.push(AgentEvent::Session(session.to_string()));
    }
    let subtype = str_at(value, "subtype");
    let is_error = value.get("is_error").and_then(Value::as_bool) == Some(true);
    if is_error || subtype.is_some_and(|subtype| subtype != "success") {
        let errors: Vec<&str> = value
            .get("errors")
            .and_then(Value::as_array)
            .map(|errors| errors.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let detail = if errors.is_empty() {
            str_at(value, "result").unwrap_or("").to_string()
        } else {
            errors.join("\n")
        };
        let message = if detail.is_empty() {
            subtype.unwrap_or("The run failed").to_string()
        } else {
            detail
        };
        events.push(AgentEvent::Error(message));
    } else {
        let usage = value.get("usage");
        let tokens = |key: &str| {
            usage
                .and_then(|usage| usage.get(key))
                .and_then(Value::as_u64)
        };
        let input = [
            tokens("input_tokens"),
            tokens("cache_read_input_tokens"),
            tokens("cache_creation_input_tokens"),
        ]
        .into_iter()
        .flatten()
        .reduce(|a, b| a + b);
        events.push(AgentEvent::Done(Usage {
            cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            input_tokens: input,
            output_tokens: tokens("output_tokens"),
        }));
    }
    events
}

/// Reads one line. An event type this does not know, or a known one with an
/// unexpected shape, gives no events.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let value = match parse_json_line(line) {
        Line::Blank => return Vec::new(),
        Line::Note(note) => return vec![note],
        Line::Json(value) => value,
    };
    match str_at(&value, "type") {
        Some("system") if str_at(&value, "subtype") == Some("init") => str_at(&value, "session_id")
            .map(|id| vec![AgentEvent::Session(id.to_string())])
            .unwrap_or_default(),
        Some("stream_event") => stream_events(&value),
        Some("assistant") => assistant_events(&value),
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
            directory: None,
            session_id: session.map(String::from),
            trusted,
        }
    }

    #[test]
    fn a_first_untrusted_read_only_message() {
        assert_eq!(
            args(&request(Mode::ReadOnly, None, false)).join(" "),
            "-p --output-format stream-json --verbose --include-partial-messages --permission-mode plan \
             --setting-sources user --disallowedTools Read(.obsidian/**) Read(**/.obsidian/**)"
        );
    }

    #[test]
    fn a_follow_up_in_edit_mode_resumes_last() {
        let args = args(&request(Mode::Edit, Some("s1"), true));
        assert!(!args.contains(&"--setting-sources".to_string()));
        assert_eq!(&args[args.len() - 2..], ["--resume", "s1"]);
        assert!(args.contains(&"Bash(kd node:*)".to_string()));
    }

    #[test]
    fn reads_a_stream() {
        let lines = [
            r#"{"type":"system","subtype":"init","session_id":"abc"}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"Read"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/a/b.md"}}]}}"#,
            r#"{"type":"result","subtype":"success","session_id":"abc","total_cost_usd":0.012,"usage":{"input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|line| parse_line(line)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session("abc".into()),
                AgentEvent::TextDelta("Hel".into()),
                AgentEvent::Tool {
                    id: Some("t1".into()),
                    name: "Read".into(),
                    summary: String::new()
                },
                AgentEvent::Text("Hello".into()),
                AgentEvent::Tool {
                    id: Some("t1".into()),
                    name: "Read".into(),
                    summary: "/a/b.md".into()
                },
                AgentEvent::Session("abc".into()),
                AgentEvent::Done(Usage {
                    cost_usd: Some(0.012),
                    input_tokens: Some(105),
                    output_tokens: Some(7)
                }),
            ]
        );
    }

    #[test]
    fn an_error_result_is_an_error_never_done() {
        let events = parse_line(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"]}"#,
        );
        assert_eq!(events, [AgentEvent::Error("boom".into())]);
        let events = parse_line(r#"{"type":"result","subtype":"error_max_turns"}"#);
        assert_eq!(events, [AgentEvent::Error("error_max_turns".into())]);
    }

    #[test]
    fn unreadable_and_unknown_lines() {
        assert_eq!(
            parse_line("not json"),
            [AgentEvent::Note("not json".into())]
        );
        assert!(parse_line(r#"{"type":"user"}"#).is_empty());
        assert!(parse_line(r#"{"type":"assistant","message":{}}"#).is_empty());
        assert!(parse_line("   ").is_empty());
    }

    #[test]
    fn tool_summaries() {
        let input: Value = serde_json::json!({"command": "ls -la\n  /tmp"});
        assert_eq!(summarise_tool_input(&input), "ls -la /tmp");
        assert_eq!(
            summarise_tool_input(&serde_json::json!({"other": "x"})),
            "x"
        );
        assert_eq!(
            summarise_tool_input(&serde_json::json!({"n": 1})),
            r#"{"n":1}"#
        );
        assert_eq!(summarise_tool_input(&serde_json::json!({})), "");
    }
}
