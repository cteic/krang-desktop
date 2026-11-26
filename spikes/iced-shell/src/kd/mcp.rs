//! `kd mcp`: the pane tool as an MCP server on standard input and output.
//!
//! A coding agent started in a pane runs `kd mcp` and gets one tool per
//! `kd` command. Each message is one line of JSON-RPC 2.0. Answers go to
//! standard output, and anything else to standard error.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::cli::{self, Caller, Parsed};
use super::client;
use super::protocol::{Command, Request, Response, VERSION};

/// The protocol versions this server speaks, newest first.
pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INVALID_REQUEST: i64 = -32600;
const PARSE_ERROR: i64 = -32700;

/// The server's state: how a command reaches the app, and where relative
/// paths start. `send` is an error when the server runs outside a pane.
pub struct Server<F> {
    send: Result<F, String>,
    cwd: PathBuf,
}

impl<F> Server<F>
where
    F: FnMut(Command) -> Result<Response, String>,
{
    pub fn new(send: Result<F, String>, cwd: PathBuf) -> Self {
        Self { send, cwd }
    }

    /// Answers one line. A notification, or a reply from the client, gets
    /// no answer.
    pub fn handle(&mut self, line: &str) -> Option<Value> {
        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => {
                return Some(failure(
                    Value::Null,
                    PARSE_ERROR,
                    &format!("parse error: {error}"),
                ));
            }
        };
        let Some(object) = message.as_object() else {
            return Some(failure(
                Value::Null,
                INVALID_REQUEST,
                "a message is one JSON object",
            ));
        };
        let id = object.get("id").cloned();
        let method = object.get("method").and_then(Value::as_str);
        let (Some(id), Some(method)) = (id, method) else {
            return None;
        };
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        Some(match method {
            "initialize" => success(id, initialize(&params)),
            "ping" => success(id, json!({})),
            "tools/list" => success(id, json!({ "tools": tools() })),
            "tools/call" => match self.call(&params) {
                Ok(result) => success(id, result),
                Err(error) => failure(id, INVALID_PARAMS, &error),
            },
            other => failure(id, METHOD_NOT_FOUND, &format!("method not found: {other}")),
        })
    }

    /// Runs a tool. An error here is a bad request, such as an unknown
    /// tool. A tool that fails answers with `isError` instead.
    fn call(&mut self, params: &Value) -> Result<Value, String> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| String::from("tools/call needs the tool's name"))?;
        if !TOOLS.iter().any(|tool| tool.name == name) {
            return Err(format!("unknown tool: {name}"));
        }
        let empty = Map::new();
        let arguments = params
            .get("arguments")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        let send = match &mut self.send {
            Ok(send) => send,
            Err(error) => return Ok(tool_result(error.clone(), true)),
        };
        let command = match command(name, arguments, &self.cwd) {
            Ok(command) => command,
            Err(error) => return Ok(tool_result(error, true)),
        };
        Ok(match send(command) {
            Ok(Response { ok: true, data, .. }) => {
                let text = data.map_or_else(
                    || String::from("done"),
                    |data| serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string()),
                );
                tool_result(text, false)
            }
            Ok(Response { error, .. }) => tool_result(
                error.unwrap_or_else(|| String::from("the app refused")),
                true,
            ),
            Err(error) => tool_result(error, true),
        })
    }
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn failure(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// The client's protocol version when this server speaks it, or else the
/// newest one it does.
fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|asked| PROTOCOL_VERSIONS.contains(asked))
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "krang", "version": env!("CARGO_PKG_VERSION") },
    })
}

struct Tool {
    name: &'static str,
    description: &'static str,
}

const TOOLS: [Tool; 6] = [
    Tool {
        name: "kd_view",
        description: "Krang Shell pane tool: opens a file in an editor pane, or a folder in a files pane, beside the calling pane.",
    },
    Tool {
        name: "kd_web",
        description: "Krang Shell pane tool: opens a web pane on a URL, or on a file on disk. Write a URL in full, such as http://localhost:3000.",
    },
    Tool {
        name: "kd_term",
        description: "Krang Shell pane tool: opens a terminal pane, and types a first command into it.",
    },
    Tool {
        name: "kd_chat",
        description: "Krang Shell pane tool: opens a chat pane with a coding agent.",
    },
    Tool {
        name: "kd_title",
        description: "Krang Shell pane tool: sets or clears the calling pane's title.",
    },
    Tool {
        name: "kd_panes",
        description: "Krang Shell pane tool: lists the window's tabs and panes as JSON.",
    },
];

fn down_property() -> Value {
    json!({
        "type": "boolean",
        "description": "Open the new pane below the calling pane, not to its right."
    })
}

fn schema(name: &str) -> Value {
    let (properties, required) = match name {
        "kd_view" => (
            json!({
                "path": { "type": "string", "description": "A file or folder. A relative path starts where kd mcp runs." },
                "down": down_property(),
            }),
            vec!["path"],
        ),
        "kd_web" => (
            json!({
                "target": { "type": "string", "description": "A URL with :// in it, or a file on disk." },
                "down": down_property(),
            }),
            vec!["target"],
        ),
        "kd_term" => (
            json!({
                "directory": { "type": "string", "description": "Where the terminal starts. The default is where kd mcp runs." },
                "command": { "type": "string", "description": "A command typed into the terminal as written." },
                "down": down_property(),
            }),
            vec![],
        ),
        "kd_chat" => (
            json!({
                "agent": { "type": "string", "description": "The agent to run, such as claude or codex. The default is claude." },
                "directory": { "type": "string", "description": "Where the agent works. The default is where kd mcp runs." },
                "down": down_property(),
            }),
            vec![],
        ),
        "kd_title" => (
            json!({
                "text": { "type": "string", "description": "The new title, at most 200 characters." },
                "clear": { "type": "boolean", "description": "Clear the title. Give text or clear, not both." },
            }),
            vec![],
        ),
        _ => (json!({}), vec![]),
    };
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// Every tool, as `tools/list` gives it.
pub fn tools() -> Vec<Value> {
    TOOLS
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": schema(tool.name),
            })
        })
        .collect()
}

fn text<'a>(arguments: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text)),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn required<'a>(arguments: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    text(arguments, key)?
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

fn flag(arguments: &Map<String, Value>, key: &str) -> Result<bool, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("{key} must be true or false")),
    }
}

/// The `kd` command line a tool call stands for.
fn args(name: &str, arguments: &Map<String, Value>) -> Result<Vec<String>, String> {
    let mut args = vec![name.trim_start_matches("kd_").to_string()];
    let mut push = |word: &str| args.push(word.to_string());
    match name {
        "kd_view" => push(required(arguments, "path")?),
        "kd_web" => push(required(arguments, "target")?),
        "kd_term" => {
            if let Some(directory) = text(arguments, "directory")? {
                push(directory);
            }
        }
        "kd_chat" => {
            if let Some(agent) = text(arguments, "agent")? {
                push("--agent");
                push(agent);
            }
            if let Some(directory) = text(arguments, "directory")? {
                push(directory);
            }
        }
        "kd_title" => {
            if flag(arguments, "clear")? {
                push("--clear");
            }
            if let Some(text) = text(arguments, "text")? {
                push("--");
                push(text);
            }
        }
        _ => {}
    }
    if matches!(name, "kd_view" | "kd_web" | "kd_term" | "kd_chat") && flag(arguments, "down")? {
        args.push(String::from("--down"));
    }
    if name == "kd_term"
        && let Some(command) = text(arguments, "command")?
    {
        args.push(String::from("--"));
        args.push(command.to_string());
    }
    Ok(args)
}

/// Reads a tool call into the command `kd` would send for it, with the
/// same checks.
pub fn command(name: &str, arguments: &Map<String, Value>, cwd: &Path) -> Result<Command, String> {
    match cli::parse(&args(name, arguments)?, cwd)? {
        Parsed::Send(command) => Ok(command),
        Parsed::Help => Err(format!("{name} does not take --help")),
    }
}

/// Runs the server until standard input closes, and returns the exit code.
pub fn run(args: &[String]) -> i32 {
    if !args.is_empty() {
        eprintln!("kd: kd mcp takes no arguments\nTry kd --help");
        return 2;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let send = Caller::from(|name| std::env::var(name).ok())
        .map(|caller| {
            move |command: Command| {
                client::call(
                    &caller.socket,
                    &Request {
                        v: VERSION,
                        pane: caller.pane,
                        token: caller.token.clone(),
                        command,
                    },
                )
            }
        })
        .map_err(|error| format!("kd mcp must run inside a Krang Shell pane: {error}"));
    if let Err(error) = &send {
        eprintln!("kd mcp: {error}");
    }
    let mut server = Server::new(send, cwd);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("kd mcp: could not read standard input: {error}");
                return 1;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Some(answer) = server.handle(&line) else {
            continue;
        };
        if writeln!(stdout, "{answer}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            return 1;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Agent;

    type Sent = std::rc::Rc<std::cell::RefCell<Vec<Command>>>;

    fn fake(
        answer: Response,
    ) -> (
        Server<impl FnMut(Command) -> Result<Response, String>>,
        Sent,
    ) {
        let sent = Sent::default();
        let log = sent.clone();
        let send = move |command: Command| {
            log.borrow_mut().push(command);
            Ok(answer.clone())
        };
        (Server::new(Ok(send), PathBuf::from("/work/demo")), sent)
    }

    fn outside() -> Server<fn(Command) -> Result<Response, String>> {
        Server::new(
            Err(String::from(
                "kd mcp must run inside a Krang Shell pane: KRANG_SOCKET is not set",
            )),
            PathBuf::from("/work/demo"),
        )
    }

    fn arguments(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn call_line(name: &str, arguments: Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        })
        .to_string()
    }

    #[test]
    fn initialize_echoes_a_version_it_speaks_and_offers_tools() {
        let (mut server, _) = fake(Response::done());
        let mut answer = |version: &str| {
            let line = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": version, "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } },
            });
            server.handle(&line.to_string())
        };
        let first = answer("2025-03-26");
        assert_eq!(
            first
                .as_ref()
                .map(|answer| &answer["result"]["protocolVersion"]),
            Some(&json!("2025-03-26"))
        );
        assert_eq!(
            first
                .as_ref()
                .map(|answer| answer["result"]["capabilities"]["tools"].is_object()),
            Some(true)
        );
        assert_eq!(first.as_ref().map(|answer| &answer["id"]), Some(&json!(1)));
        assert_eq!(
            answer("2024-11-05").map(|answer| answer["result"]["protocolVersion"].clone()),
            Some(json!("2024-11-05"))
        );
        assert_eq!(
            answer("1999-01-01").map(|answer| answer["result"]["protocolVersion"].clone()),
            Some(json!("2025-06-18"))
        );
    }

    #[test]
    fn tools_list_names_every_kd_command() {
        let (mut server, _) = fake(Response::done());
        let answer = server.handle(r#"{"jsonrpc":"2.0","id":"a","method":"tools/list"}"#);
        let tools = answer
            .and_then(|answer| answer["result"]["tools"].as_array().cloned())
            .unwrap_or_default();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names,
            [
                "kd_view", "kd_web", "kd_term", "kd_chat", "kd_title", "kd_panes"
            ]
        );
        for tool in &tools {
            assert!(
                tool["description"]
                    .as_str()
                    .is_some_and(|text| text.starts_with("Krang Shell pane tool:"))
            );
            assert_eq!(tool["inputSchema"]["type"], json!("object"));
        }
        assert_eq!(tools[0]["inputSchema"]["required"], json!(["path"]));
    }

    #[test]
    fn ping_answers_and_an_unknown_method_is_refused() {
        let (mut server, _) = fake(Response::done());
        assert_eq!(
            server.handle(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#),
            Some(json!({ "jsonrpc": "2.0", "id": 2, "result": {} }))
        );
        let answer = server.handle(r#"{"jsonrpc":"2.0","id":3,"method":"resources/list"}"#);
        assert_eq!(
            answer.map(|answer| answer["error"]["code"].clone()),
            Some(json!(-32601))
        );
        let broken = server.handle("{not json");
        assert_eq!(
            broken.map(|answer| answer["error"]["code"].clone()),
            Some(json!(-32700))
        );
    }

    #[test]
    fn a_notification_gets_no_answer() {
        let (mut server, sent) = fake(Response::done());
        assert_eq!(
            server.handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
            None
        );
        assert_eq!(
            server.handle(
                r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#
            ),
            None
        );
        assert!(sent.borrow().is_empty());
    }

    #[test]
    fn a_tool_call_sends_its_command_and_answers_with_text() {
        let (mut server, sent) = fake(Response::done());
        let answer = server.handle(&call_line("kd_title", json!({ "text": "api tests" })));
        assert_eq!(
            answer.map(|answer| answer["result"].clone()),
            Some(json!({ "content": [{ "type": "text", "text": "done" }], "isError": false }))
        );
        assert_eq!(
            *sent.borrow(),
            [Command::Title {
                text: Some(String::from("api tests"))
            }]
        );

        let (mut server, _) = fake(Response::data(json!({ "tabs": [] })));
        let answer = server.handle(&call_line("kd_panes", json!({})));
        let body = answer.and_then(|answer| {
            answer["result"]["content"][0]["text"]
                .as_str()
                .map(String::from)
        });
        assert_eq!(
            body.map(|body| serde_json::from_str::<Value>(&body).ok()),
            Some(Some(json!({ "tabs": [] })))
        );
    }

    #[test]
    fn a_failed_tool_call_is_an_error_result() {
        let (mut server, _) = fake(Response::err("the pane is closed"));
        let answer = server.handle(&call_line("kd_panes", json!({})));
        assert_eq!(
            answer.map(|answer| answer["result"].clone()),
            Some(
                json!({ "content": [{ "type": "text", "text": "the pane is closed" }], "isError": true })
            )
        );

        let (mut server, sent) = fake(Response::done());
        let answer = server.handle(&call_line("kd_view", json!({})));
        assert_eq!(
            answer.map(|answer| answer["result"]["isError"].clone()),
            Some(json!(true))
        );
        assert!(sent.borrow().is_empty());

        let answer = server.handle(&call_line("kd_badge", json!({})));
        assert_eq!(
            answer.map(|answer| answer["error"]["code"].clone()),
            Some(json!(-32602))
        );
    }

    #[test]
    fn outside_a_pane_every_tool_call_says_so() {
        let mut server = outside();
        for tool in tools() {
            let name = tool["name"].as_str().unwrap_or_default();
            let answer = server.handle(&call_line(name, json!({ "path": "a" })));
            let result = answer.map(|answer| answer["result"].clone());
            assert_eq!(
                result.as_ref().map(|result| &result["isError"]),
                Some(&json!(true))
            );
            assert!(
                result
                    .and_then(|result| result["content"][0]["text"].as_str().map(String::from))
                    .is_some_and(|text| text.contains("inside a Krang Shell pane"))
            );
        }
        assert!(
            server
                .handle(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
                .is_some_and(|answer| answer["result"]["tools"].is_array())
        );
    }

    #[test]
    fn arguments_map_to_the_commands_kd_sends() {
        let cwd = Path::new("/work/demo");
        let map = |name: &str, value: Value| command(name, &arguments(value), cwd);
        assert_eq!(
            map("kd_view", json!({ "path": "src/main.rs", "down": true })),
            Ok(Command::View {
                path: String::from("/work/demo/src/main.rs"),
                down: true
            })
        );
        assert_eq!(
            map("kd_web", json!({ "target": "http://localhost:3000" })),
            Ok(Command::Web {
                target: String::from("http://localhost:3000"),
                down: false
            })
        );
        assert!(map("kd_web", json!({ "target": "localhost:3000" })).is_err());
        assert_eq!(
            map("kd_term", json!({})),
            Ok(Command::Term {
                directory: Some(String::from("/work/demo")),
                command: None,
                down: false
            })
        );
        assert_eq!(
            map(
                "kd_term",
                json!({ "directory": "api", "command": "pnpm test && pnpm build", "down": true })
            ),
            Ok(Command::Term {
                directory: Some(String::from("/work/demo/api")),
                command: Some(String::from("pnpm test && pnpm build")),
                down: true
            })
        );
        assert_eq!(
            map("kd_chat", json!({ "agent": "codex", "directory": "api" })),
            Ok(Command::Chat {
                agent: Agent::Codex,
                directory: Some(String::from("/work/demo/api")),
                down: false
            })
        );
        assert_eq!(
            map("kd_chat", json!({ "down": true })),
            Ok(Command::Chat {
                agent: Agent::Claude,
                directory: Some(String::from("/work/demo")),
                down: true
            })
        );
        assert!(map("kd_chat", json!({ "agent": "gpt" })).is_err());
        assert_eq!(
            map("kd_title", json!({ "text": "--draft" })),
            Ok(Command::Title {
                text: Some(String::from("--draft"))
            })
        );
        assert_eq!(
            map("kd_title", json!({ "clear": true })),
            Ok(Command::Title { text: None })
        );
        assert!(map("kd_title", json!({ "clear": true, "text": "x" })).is_err());
        assert!(map("kd_title", json!({})).is_err());
        assert_eq!(map("kd_panes", json!({})), Ok(Command::Panes));
        assert!(map("kd_view", json!({})).is_err_and(|error| error.contains("path")));
        assert!(map("kd_view", json!({ "path": 3 })).is_err());
        assert!(map("kd_view", json!({ "path": "a", "down": "yes" })).is_err());
    }
}
