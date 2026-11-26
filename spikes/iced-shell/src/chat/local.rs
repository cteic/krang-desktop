//! The Local agent: a model on the owner's Ollama, text only, with no tools.
//!
//! The runner starts this app's own binary as `krang-shell --local-agent`.
//! That helper reads the prompt on standard input, sends the conversation
//! to Ollama's `/api/chat` with streaming on, and prints one JSON line per
//! event for `parse_line` to read:
//!
//! ```text
//! {"type":"session","id":"local-1764150000-4242"}
//! {"type":"delta","text":"Hel"}
//! {"type":"text","text":"Hello"}
//! {"type":"done","input_tokens":12,"output_tokens":3}
//! {"type":"error","message":"Ollama is not running at http://127.0.0.1:11434"}
//! ```
//!
//! The conversation is kept per session in a JSON file under the state
//! folder, so a follow-up passes the id back with `--resume`, as Claude's does.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::RunRequest;
use super::event::{AgentEvent, Line, Usage, parse_json_line, str_at};

/// The flag that starts the helper instead of the window.
pub const HELPER_FLAG: &str = "--local-agent";
pub const DEFAULT_HOST: &str = "http://127.0.0.1:11434";
pub const DEFAULT_MODEL: &str = "qwen3.5:9b-q8_0";
pub const ENV_HOST: &str = "OLLAMA_HOST";
pub const ENV_MODEL: &str = "KRANG_LOCAL_MODEL";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Loading a large model can take minutes before the first word.
const READ_TIMEOUT: Duration = Duration::from_secs(600);

/// The arguments for one message. The mode and the trust answer change
/// nothing, since this agent never touches a file.
pub fn args(request: &RunRequest) -> Vec<String> {
    let mut args = vec![HELPER_FLAG.to_string()];
    if let Some(session) = &request.session_id {
        args.extend(["--resume".into(), session.clone()]);
    }
    args
}

/// Reads one line the helper printed.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let value = match parse_json_line(line) {
        Line::Blank => return Vec::new(),
        Line::Note(note) => return vec![note],
        Line::Json(value) => value,
    };
    let text = |key: &str| str_at(&value, key).map(String::from);
    match str_at(&value, "type") {
        Some("session") => text("id").map(AgentEvent::Session).into_iter().collect(),
        Some("delta") => text("text")
            .filter(|text| !text.is_empty())
            .map(AgentEvent::TextDelta)
            .into_iter()
            .collect(),
        Some("text") => text("text")
            .filter(|text| !text.is_empty())
            .map(AgentEvent::Text)
            .into_iter()
            .collect(),
        Some("done") => vec![AgentEvent::Done(Usage {
            cost_usd: Some(0.0),
            input_tokens: value.get("input_tokens").and_then(Value::as_u64),
            output_tokens: value.get("output_tokens").and_then(Value::as_u64),
        })],
        Some("error") => vec![AgentEvent::Error(
            text("message").unwrap_or_else(|| String::from("The local model failed")),
        )],
        _ => Vec::new(),
    }
}

/// Where Ollama listens, read from `OLLAMA_HOST` as Ollama itself reads it:
/// `host`, `host:port` or `http://host:port`, with 11434 as the port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    pub host: String,
    pub port: u16,
}

impl Host {
    pub fn parse(value: Option<&str>) -> Result<Host, String> {
        let value = value.map(str::trim).filter(|value| !value.is_empty());
        let Some(value) = value else {
            return Host::parse(Some(DEFAULT_HOST));
        };
        if value.starts_with("https://") {
            return Err(format!(
                "OLLAMA_HOST is {value}, but the Local agent speaks plain http only"
            ));
        }
        let rest = value.strip_prefix("http://").unwrap_or(value);
        let authority = rest.split('/').next().unwrap_or(rest);
        let (host, port) = match authority.strip_prefix('[') {
            Some(bracketed) => match bracketed.split_once(']') {
                Some((host, after)) => (host, after.strip_prefix(':')),
                None => return Err(format!("OLLAMA_HOST has a bad address: {value}")),
            },
            None => match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            },
        };
        let port = match port {
            None => 11434,
            Some(port) => port
                .parse::<u16>()
                .map_err(|_| format!("OLLAMA_HOST has a bad port: {value}"))?,
        };
        if host.is_empty() {
            return Err(format!("OLLAMA_HOST has no host: {value}"));
        }
        Ok(Host {
            host: host.to_string(),
            port,
        })
    }

    /// The address as a person would type it.
    pub fn url(&self) -> String {
        if self.host.contains(':') {
            format!("http://[{}]:{}", self.host, self.port)
        } else {
            format!("http://{}:{}", self.host, self.port)
        }
    }

    fn authority(&self) -> String {
        self.url().trim_start_matches("http://").to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// One conversation as the helper keeps it between turns.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Conversation {
    pub messages: Vec<ChatMessage>,
}

/// The whole HTTP request for one turn. It asks the server to close the
/// connection after the reply, so the reply ends where the stream ends.
pub fn chat_request(host: &Host, model: &str, messages: &[ChatMessage]) -> Vec<u8> {
    let body = json!({ "model": model, "messages": messages, "stream": true }).to_string();
    let mut request = format!(
        "POST /api/chat HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nAccept: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        host.authority(),
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(body.as_bytes());
    request
}

/// What one line of Ollama's streamed reply means.
#[derive(Debug, Clone, PartialEq)]
pub enum Piece {
    Text(String),
    Done {
        input: Option<u64>,
        output: Option<u64>,
    },
    Error(String),
    Nothing,
}

pub fn read_piece(line: &str) -> Piece {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return Piece::Nothing;
    };
    if let Some(error) = str_at(&value, "error") {
        return Piece::Error(error.to_string());
    }
    if value.get("done").and_then(Value::as_bool) == Some(true) {
        return Piece::Done {
            input: value.get("prompt_eval_count").and_then(Value::as_u64),
            output: value.get("eval_count").and_then(Value::as_u64),
        };
    }
    match value.pointer("/message/content").and_then(Value::as_str) {
        Some(text) if !text.is_empty() => Piece::Text(text.to_string()),
        _ => Piece::Nothing,
    }
}

/// A session id is a file name, so it may hold only these characters.
pub fn valid_session(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn new_session() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    format!("local-{seconds}-{}", std::process::id())
}

pub fn conversation_file(state: &Path, session: &str) -> PathBuf {
    state.join("local-chats").join(format!("{session}.json"))
}

fn load(file: &Path) -> Conversation {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(file: &Path, conversation: &Conversation) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("keep the chat: {error}"))?;
    }
    let text = serde_json::to_string_pretty(conversation)
        .map_err(|error| format!("keep the chat: {error}"))?;
    std::fs::write(file, text).map_err(|error| format!("keep the chat: {error}"))
}

fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn fail(message: String) -> i32 {
    emit(json!({ "type": "error", "message": message }));
    1
}

/// The status line and headers of a reply: the status code, and whether
/// the body comes in chunks.
fn read_head(reader: &mut impl BufRead) -> Result<(u16, bool), String> {
    let mut status = String::new();
    reader
        .read_line(&mut status)
        .map_err(|error| format!("read Ollama's reply: {error}"))?;
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("Ollama sent a reply this cannot read: {}", status.trim()))?;
    let mut chunked = false;
    loop {
        let mut header = String::new();
        let read = reader
            .read_line(&mut header)
            .map_err(|error| format!("read Ollama's reply: {error}"))?;
        let header = header.trim();
        if read == 0 || header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("transfer-encoding")
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
    }
    Ok((code, chunked))
}

/// Calls `line` for each line of a reply body, as it arrives. A chunked
/// body is put back together first.
pub fn read_body_lines(
    reader: &mut impl BufRead,
    chunked: bool,
    mut line: impl FnMut(&str) -> bool,
) -> Result<(), String> {
    let error = |error: std::io::Error| format!("read Ollama's reply: {error}");
    if !chunked {
        for text in reader.lines() {
            if !line(&text.map_err(error)?) {
                break;
            }
        }
        return Ok(());
    }
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let mut size = String::new();
        if reader.read_line(&mut size).map_err(error)? == 0 {
            break;
        }
        let size = size.trim();
        let size = size.split(';').next().unwrap_or(size);
        let size = usize::from_str_radix(size.trim(), 16)
            .map_err(|_| format!("Ollama sent a chunk this cannot read: {size}"))?;
        if size == 0 {
            break;
        }
        let mut chunk = vec![0; size];
        reader.read_exact(&mut chunk).map_err(error)?;
        let mut end = [0; 2];
        reader.read_exact(&mut end).map_err(error)?;
        pending.extend_from_slice(&chunk);
        while let Some(at) = pending.iter().position(|byte| *byte == b'\n') {
            let whole: Vec<u8> = pending.drain(..=at).collect();
            if !line(&String::from_utf8_lossy(&whole)) {
                return Ok(());
            }
        }
    }
    if !pending.is_empty() {
        line(&String::from_utf8_lossy(&pending));
    }
    Ok(())
}

fn connect(host: &Host) -> Option<TcpStream> {
    let addresses = (host.host.as_str(), host.port).to_socket_addrs().ok()?;
    addresses
        .into_iter()
        .find_map(|address| TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).ok())
}

/// Runs one turn and prints its events. Returns the process exit code.
pub fn run_helper(args: &[String]) -> i32 {
    let session = match args {
        [] => new_session(),
        [flag, id] if flag == "--resume" && valid_session(id) => id.clone(),
        _ => return fail(format!("{HELPER_FLAG} takes only --resume <session>")),
    };
    let host = match Host::parse(std::env::var(ENV_HOST).ok().as_deref()) {
        Ok(host) => host,
        Err(error) => return fail(error),
    };
    let model = std::env::var(ENV_MODEL)
        .ok()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let Some(state) = crate::shell::store::state_dir() else {
        return fail(String::from("There is no folder to keep the chat in"));
    };
    let mut prompt = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut prompt) {
        return fail(format!("read the prompt: {error}"));
    }
    emit(json!({ "type": "session", "id": session }));

    let file = conversation_file(&state, &session);
    let mut conversation = load(&file);
    conversation.messages.push(ChatMessage {
        role: "user".into(),
        content: prompt.trim().to_string(),
    });

    let Some(mut stream) = connect(&host) else {
        return fail(format!("Ollama is not running at {}", host.url()));
    };
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    if let Err(error) = stream.write_all(&chat_request(&host, &model, &conversation.messages)) {
        return fail(format!("send to Ollama at {}: {error}", host.url()));
    }
    let mut reader = BufReader::new(stream);
    let (code, chunked) = match read_head(&mut reader) {
        Ok(head) => head,
        Err(error) => return fail(error),
    };

    let mut reply = String::new();
    // The last line that ends the reply: done, or an error.
    let mut outcome = Piece::Nothing;
    let read = read_body_lines(&mut reader, chunked, |line| match read_piece(line) {
        Piece::Text(text) => {
            emit(json!({ "type": "delta", "text": text }));
            reply.push_str(&text);
            true
        }
        Piece::Nothing => true,
        ending => {
            outcome = ending;
            false
        }
    });
    if let Err(error) = read {
        return fail(error);
    }
    match outcome {
        Piece::Done { input, output } => {
            if !reply.is_empty() {
                emit(json!({ "type": "text", "text": reply }));
            }
            conversation.messages.push(ChatMessage {
                role: "assistant".into(),
                content: reply,
            });
            if let Err(error) = save(&file, &conversation) {
                return fail(error);
            }
            emit(json!({ "type": "done", "input_tokens": input, "output_tokens": output }));
            0
        }
        Piece::Error(error) => fail(format!("Ollama: {error}")),
        _ if code != 200 => fail(format!("Ollama answered with HTTP {code}")),
        _ => fail(String::from("Ollama's reply ended before it was done")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Mode;

    #[test]
    fn arguments_resume_a_session() {
        let first = RunRequest {
            mode: Mode::Edit,
            directory: None,
            session_id: None,
            trusted: false,
        };
        assert_eq!(args(&first), ["--local-agent"]);
        let next = RunRequest {
            session_id: Some("local-1-2".into()),
            ..first
        };
        assert_eq!(args(&next), ["--local-agent", "--resume", "local-1-2"]);
    }

    #[test]
    fn reads_what_the_helper_prints() {
        let lines = [
            r#"{"type":"session","id":"local-1-2"}"#,
            r#"{"type":"delta","text":"Hel"}"#,
            r#"{"type":"delta","text":""}"#,
            r#"{"type":"text","text":"Hello"}"#,
            r#"{"type":"done","input_tokens":12,"output_tokens":3}"#,
        ];
        let events: Vec<AgentEvent> = lines.iter().flat_map(|line| parse_line(line)).collect();
        assert_eq!(
            events,
            [
                AgentEvent::Session("local-1-2".into()),
                AgentEvent::TextDelta("Hel".into()),
                AgentEvent::Text("Hello".into()),
                AgentEvent::Done(Usage {
                    cost_usd: Some(0.0),
                    input_tokens: Some(12),
                    output_tokens: Some(3)
                }),
            ]
        );
        assert_eq!(
            parse_line(
                r#"{"type":"error","message":"Ollama is not running at http://127.0.0.1:11434"}"#
            ),
            [AgentEvent::Error(
                "Ollama is not running at http://127.0.0.1:11434".into()
            )]
        );
        assert_eq!(parse_line("oops"), [AgentEvent::Note("oops".into())]);
    }

    #[test]
    fn hosts_as_ollama_reads_them() {
        let host = |value: Option<&str>| Host::parse(value).map(|host| host.url());
        assert_eq!(host(None), Ok(DEFAULT_HOST.to_string()));
        assert_eq!(host(Some("")), Ok(DEFAULT_HOST.to_string()));
        assert_eq!(host(Some("0.0.0.0")), Ok("http://0.0.0.0:11434".into()));
        assert_eq!(
            host(Some("box.local:8080")),
            Ok("http://box.local:8080".into())
        );
        assert_eq!(
            host(Some("http://10.0.0.2:9/")),
            Ok("http://10.0.0.2:9".into())
        );
        assert_eq!(host(Some("[::1]:11434")), Ok("http://[::1]:11434".into()));
        assert_eq!(host(Some("[::1]")), Ok("http://[::1]:11434".into()));
        assert!(host(Some("https://remote")).is_err());
        assert!(host(Some("box:port")).is_err());
    }

    #[test]
    fn builds_a_streaming_chat_request() {
        let host = Host::parse(None).unwrap_or_else(|error| panic!("{error}"));
        let messages = [ChatMessage {
            role: "user".into(),
            content: "Reply with \"ok\"".into(),
        }];
        let request = String::from_utf8(chat_request(&host, "m:1b", &messages)).unwrap_or_default();
        let (head, body) = request.split_once("\r\n\r\n").unwrap_or_default();
        assert!(head.starts_with("POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:11434\r\n"));
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
        assert!(head.contains("Connection: close"));
        let body: Value = serde_json::from_str(body).unwrap_or_default();
        assert_eq!(
            body,
            json!({"model":"m:1b","stream":true,"messages":[{"role":"user","content":"Reply with \"ok\""}]})
        );
    }

    #[test]
    fn reads_ollama_lines() {
        assert_eq!(
            read_piece(
                r#"{"model":"m","created_at":"t","message":{"role":"assistant","content":"o"},"done":false}"#
            ),
            Piece::Text("o".into())
        );
        assert_eq!(
            read_piece(
                r#"{"model":"m","message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}"#
            ),
            Piece::Nothing
        );
        assert_eq!(
            read_piece(
                r#"{"model":"m","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","prompt_eval_count":14,"eval_count":2}"#
            ),
            Piece::Done {
                input: Some(14),
                output: Some(2)
            }
        );
        assert_eq!(
            read_piece(r#"{"error":"model 'x' not found"}"#),
            Piece::Error("model 'x' not found".into())
        );
        assert_eq!(read_piece("garbage"), Piece::Nothing);
    }

    #[test]
    fn puts_a_chunked_body_back_together() {
        let body = "7\r\n{\"a\":1}\r\n5\r\n\n{\"b\"\r\n4\r\n:2}\n\r\n0\r\n\r\n";
        let mut lines = Vec::new();
        let read = read_body_lines(&mut body.as_bytes(), true, |line| {
            lines.push(line.trim().to_string());
            true
        });
        assert!(read.is_ok());
        assert_eq!(lines, [r#"{"a":1}"#, r#"{"b":2}"#]);

        let mut head = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/x-ndjson\r\n\r\n".as_bytes();
        assert_eq!(read_head(&mut head), Ok((200, true)));
        let mut plain = "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\n{}".as_bytes();
        assert_eq!(read_head(&mut plain), Ok((404, false)));
    }

    #[test]
    fn session_ids_are_safe_file_names() {
        assert!(valid_session("local-1764150000-42"));
        assert!(!valid_session("../escape"));
        assert!(!valid_session(""));
        assert!(valid_session(&new_session()));
        assert_eq!(
            conversation_file(Path::new("/s"), "a-1"),
            PathBuf::from("/s/local-chats/a-1.json")
        );
    }

    #[test]
    fn a_closed_port_is_reported_as_not_running() {
        let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0") else {
            return;
        };
        let port = listener.local_addr().map_or(0, |address| address.port());
        drop(listener);
        let host = Host {
            host: "127.0.0.1".into(),
            port,
        };
        assert!(connect(&host).is_none());
    }
}
