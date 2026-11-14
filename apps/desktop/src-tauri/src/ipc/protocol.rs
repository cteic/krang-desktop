//! The messages that cross the socket, and the one the page receives.
//!
//! The shapes are checked here. What a command means is the page's business.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One line from the tool to the app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    /// The label of the window the calling pane lives in.
    pub window: String,
    /// The id of the calling pane.
    pub pane: String,
    pub command: Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Beside the calling pane.
    Row,
    /// Below the calling pane.
    Column,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WebTarget {
    Url(String),
    Path(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutTarget {
    /// A bare name, looked up in the layout directories.
    Name(String),
    /// An absolute path to a layout file.
    Path(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Badge {
    pub text: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "lowercase")]
pub enum Command {
    View {
        path: String,
        kind: PathKind,
        direction: Direction,
    },
    Web {
        target: WebTarget,
        direction: Direction,
    },
    Term {
        directory: String,
        command: Option<String>,
    },
    Chat {
        agent: Option<String>,
        directory: String,
    },
    Graph {
        directory: String,
    },
    Title {
        title: Option<String>,
    },
    Badge {
        badge: Option<Badge>,
    },
    Layout {
        target: LayoutTarget,
    },
    Panes,
}

/// One line from the app back to the tool. The page's answer has the same
/// shape, so it passes straight through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl Response {
    #[cfg(test)]
    pub fn ok() -> Self {
        Self {
            ok: true,
            error: None,
            data: None,
        }
    }

    #[cfg(test)]
    pub fn ok_with(data: Value) -> Self {
        Self {
            ok: true,
            error: None,
            data: Some(data),
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            data: None,
        }
    }
}

/// What a window's page receives as the payload of an `ipc-request` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub request_id: String,
    pub pane: String,
    pub command: Value,
}

/// A layout file, read for the page to parse.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutFile {
    pub path: String,
    pub text: String,
}

/// Turns a command from the tool into the one the page sees. Every command
/// passes through unchanged except `layout`: the page cannot read files, so
/// the file's path and text replace the name or path the tool sent.
pub fn page_command<F>(command: &Command, read_layout: F) -> Result<Value, String>
where
    F: FnOnce(&LayoutTarget) -> Result<LayoutFile, String>,
{
    match command {
        Command::Layout { target } => {
            let file = read_layout(target)?;
            Ok(serde_json::json!({
                "name": "layout",
                "path": file.path,
                "text": file.text,
            }))
        }
        other => serde_json::to_value(other)
            .map_err(|error| format!("could not encode the command: {error}")),
    }
}

pub fn decode_request(line: &[u8]) -> Result<Request, String> {
    serde_json::from_slice(line).map_err(|error| format!("malformed request: {error}"))
}

pub fn decode_response(line: &[u8]) -> Result<Response, String> {
    serde_json::from_slice(line).map_err(|error| format!("malformed reply: {error}"))
}

/// One line of JSON, with its newline.
pub fn encode_line<T: Serialize>(message: &T) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_vec(message)
        .map_err(|error| format!("could not encode the message: {error}"))?;
    line.push(b'\n');
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(command: Command) -> Request {
        Request {
            window: String::from("window-1"),
            pane: String::from("p3"),
            command,
        }
    }

    fn wire(command: Command) -> Value {
        serde_json::to_value(command).unwrap()
    }

    #[test]
    fn every_command_has_a_stable_wire_shape() {
        assert_eq!(
            wire(Command::View {
                path: String::from("/work/readme.md"),
                kind: PathKind::File,
                direction: Direction::Row,
            }),
            json!({"name": "view", "path": "/work/readme.md", "kind": "file", "direction": "row"})
        );
        assert_eq!(
            wire(Command::Web {
                target: WebTarget::Url(String::from("https://example.com")),
                direction: Direction::Column,
            }),
            json!({"name": "web", "target": {"url": "https://example.com"}, "direction": "column"})
        );
        assert_eq!(
            wire(Command::Web {
                target: WebTarget::Path(String::from("/work/index.html")),
                direction: Direction::Row,
            }),
            json!({"name": "web", "target": {"path": "/work/index.html"}, "direction": "row"})
        );
        assert_eq!(
            wire(Command::Term {
                directory: String::from("/work"),
                command: Some(String::from("pnpm dev")),
            }),
            json!({"name": "term", "directory": "/work", "command": "pnpm dev"})
        );
        assert_eq!(
            wire(Command::Chat {
                agent: None,
                directory: String::from("/work"),
            }),
            json!({"name": "chat", "agent": null, "directory": "/work"})
        );
        assert_eq!(
            wire(Command::Graph {
                directory: String::from("/vault"),
            }),
            json!({"name": "graph", "directory": "/vault"})
        );
        assert_eq!(
            wire(Command::Title { title: None }),
            json!({"name": "title", "title": null})
        );
        assert_eq!(
            wire(Command::Badge {
                badge: Some(Badge {
                    text: String::from("!"),
                    color: Some(String::from("#ff8800")),
                }),
            }),
            json!({"name": "badge", "badge": {"text": "!", "color": "#ff8800"}})
        );
        assert_eq!(
            wire(Command::Layout {
                target: LayoutTarget::Name(String::from("review")),
            }),
            json!({"name": "layout", "target": {"name": "review"}})
        );
        assert_eq!(wire(Command::Panes), json!({"name": "panes"}));
    }

    #[test]
    fn a_request_survives_a_round_trip() {
        let commands = vec![
            Command::View {
                path: String::from("/a"),
                kind: PathKind::Directory,
                direction: Direction::Column,
            },
            Command::Web {
                target: WebTarget::Path(String::from("/a b/c.html")),
                direction: Direction::Row,
            },
            Command::Term {
                directory: String::from("/a"),
                command: None,
            },
            Command::Chat {
                agent: Some(String::from("codex")),
                directory: String::from("/a"),
            },
            Command::Graph {
                directory: String::from("/a"),
            },
            Command::Title {
                title: Some(String::from("build")),
            },
            Command::Badge { badge: None },
            Command::Layout {
                target: LayoutTarget::Path(String::from("/a/x.toml")),
            },
            Command::Panes,
        ];
        for command in commands {
            let sent = request(command);
            let line = encode_line(&sent).unwrap();
            assert_eq!(line.last(), Some(&b'\n'));
            assert_eq!(line.iter().filter(|byte| **byte == b'\n').count(), 1);
            assert_eq!(decode_request(&line).unwrap(), sent);
        }
    }

    #[test]
    fn optional_fields_may_be_left_out() {
        let decoded =
            decode_request(br#"{"window":"window-1","pane":"p1","command":{"name":"title"}}"#)
                .unwrap();
        assert_eq!(decoded.command, Command::Title { title: None });
    }

    #[test]
    fn rejects_requests_of_the_wrong_shape() {
        let cases: [&[u8]; 6] = [
            b"not json",
            b"[]",
            br#"{"window":"window-1","pane":"p1"}"#,
            br#"{"window":"window-1","pane":"p1","command":{"name":"explode"}}"#,
            br#"{"window":"window-1","pane":"p1","command":{"name":"view","path":"/a"}}"#,
            br#"{"window":7,"pane":"p1","command":{"name":"panes"}}"#,
        ];
        for case in cases {
            let error = decode_request(case).unwrap_err();
            assert!(error.starts_with("malformed request: "), "{error}");
        }
    }

    #[test]
    fn responses_omit_what_they_do_not_carry() {
        assert_eq!(
            String::from_utf8(encode_line(&Response::ok()).unwrap()).unwrap(),
            "{\"ok\":true}\n"
        );
        assert_eq!(
            String::from_utf8(encode_line(&Response::err("no")).unwrap()).unwrap(),
            "{\"ok\":false,\"error\":\"no\"}\n"
        );
        assert_eq!(
            decode_response(br#"{"ok":true,"data":{"tabs":[]}}"#).unwrap(),
            Response::ok_with(json!({"tabs": []}))
        );
        assert!(decode_response(br#"{"error":"no ok field"}"#).is_err());
    }

    #[test]
    fn a_layout_reaches_the_page_as_path_and_text() {
        let command = Command::Layout {
            target: LayoutTarget::Name(String::from("review")),
        };
        let value = page_command(&command, |target| {
            assert_eq!(target, &LayoutTarget::Name(String::from("review")));
            Ok(LayoutFile {
                path: String::from("/layouts/review.toml"),
                text: String::from("name = \"review\""),
            })
        })
        .unwrap();
        assert_eq!(
            value,
            json!({"name": "layout", "path": "/layouts/review.toml", "text": "name = \"review\""})
        );

        let failed = page_command(&command, |_| Err(String::from("no layout named review")));
        assert_eq!(failed.unwrap_err(), "no layout named review");
    }

    #[test]
    fn other_commands_reach_the_page_unchanged() {
        let value = page_command(&Command::Panes, |_| {
            panic!("only a layout is read from disk")
        })
        .unwrap();
        assert_eq!(value, json!({"name": "panes"}));
    }

    #[test]
    fn the_page_request_uses_camel_case() {
        let page = PageRequest {
            request_id: String::from("r1"),
            pane: String::from("p3"),
            command: json!({"name": "panes"}),
        };
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            json!({"requestId": "r1", "pane": "p3", "command": {"name": "panes"}})
        );
    }
}
