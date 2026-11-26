//! What goes over the socket: one line of JSON each way.
//!
//! A request:  `{"v":1,"pane":3,"token":"...","cmd":"title","text":"api"}`
//! An answer:  `{"ok":true}` or `{"ok":false,"error":"..."}`, with `data`
//! when the command asks for something back.

use serde::{Deserialize, Serialize};

use crate::chat::Agent;

/// The protocol's version. A request with another number is refused, so an
/// old `kd` never half-works against a newer app.
pub const VERSION: u32 = 1;

/// The longest line either side reads, newline included.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// The longest title `kd title` sets, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// The environment a pane's shell gets.
pub const ENV_SOCKET: &str = "KRANG_SOCKET";
pub const ENV_PANE: &str = "KRANG_PANE_ID";
pub const ENV_TOKEN: &str = "KRANG_PANE_TOKEN";
pub const ENV_CLI: &str = "KRANG_CLI";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Command {
    /// Open a file in an editor, or a folder in a files pane.
    View {
        path: String,
        #[serde(default)]
        down: bool,
    },
    /// Open a URL, or a file on disk, in a web pane.
    Web {
        target: String,
        #[serde(default)]
        down: bool,
    },
    /// Open a terminal, and type a first command into it.
    Term {
        #[serde(default)]
        directory: Option<String>,
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        down: bool,
    },
    Chat {
        #[serde(default)]
        agent: Agent,
        #[serde(default)]
        directory: Option<String>,
        #[serde(default)]
        down: bool,
    },
    /// Set the calling pane's title, or clear it with no text.
    Title {
        #[serde(default)]
        text: Option<String>,
    },
    /// List the window's tabs and panes.
    Panes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Request {
    pub v: u32,
    /// The pane that is asking.
    pub pane: u64,
    /// The secret the app made for that pane.
    pub token: String,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Response {
    pub fn done() -> Self {
        Self {
            ok: true,
            error: None,
            data: None,
        }
    }

    pub fn data(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            error: None,
            data: Some(data),
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            data: None,
        }
    }
}

/// One pane in the answer to `panes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaneInfo {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabInfo {
    pub title: String,
    pub active: bool,
    pub panes: Vec<PaneInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Panes {
    pub tabs: Vec<TabInfo>,
}

/// A pane's id as the environment and `kd panes` write it: `p3`.
pub fn pane_name(id: u64) -> String {
    format!("p{id}")
}

pub fn parse_pane_name(name: &str) -> Option<u64> {
    name.strip_prefix('p').unwrap_or(name).parse().ok()
}

/// A value as one line, newline included.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut line = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if line.len() >= MAX_LINE_BYTES {
        return Err(String::from("the message is larger than 64 KiB"));
    }
    line.push(b'\n');
    Ok(line)
}

fn text_is_plain(text: &str) -> bool {
    !text.chars().any(char::is_control)
}

/// Reads a request line and refuses what the app should never act on: a
/// line that is not a request, another version, or text with control
/// characters where a title or a path goes.
pub fn decode_request(line: &[u8]) -> Result<Request, String> {
    let request: Request = serde_json::from_slice(line)
        .map_err(|error| format!("the request is not understood: {error}"))?;
    if request.v != VERSION {
        return Err(format!(
            "the request is version {}, and the app speaks version {VERSION}",
            request.v
        ));
    }
    let plain = match &request.command {
        Command::View { path, .. } => text_is_plain(path),
        Command::Web { target, .. } => text_is_plain(target),
        Command::Term {
            directory, command, ..
        } => {
            directory.as_deref().is_none_or(text_is_plain)
                && command.as_deref().is_none_or(text_is_plain)
        }
        Command::Chat { directory, .. } => directory.as_deref().is_none_or(text_is_plain),
        Command::Title { text } => text
            .as_deref()
            .is_none_or(|text| text_is_plain(text) && text.chars().count() <= MAX_TITLE_CHARS),
        Command::Panes => true,
    };
    if !plain {
        return Err(String::from(
            "the request holds control characters, or a title over 200 characters",
        ));
    }
    Ok(request)
}

pub fn decode_response(line: &[u8]) -> Result<Response, String> {
    serde_json::from_slice(line).map_err(|error| format!("the answer is not understood: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(command: Command) -> Request {
        Request {
            v: VERSION,
            pane: 3,
            token: String::from("secret"),
            command,
        }
    }

    #[test]
    fn a_request_is_one_flat_line() {
        let line = encode(&request(Command::Title {
            text: Some(String::from("api tests")),
        }));
        assert_eq!(
            line.as_deref().map(String::from_utf8_lossy).as_deref(),
            Ok(
                "{\"v\":1,\"pane\":3,\"token\":\"secret\",\"cmd\":\"title\",\"text\":\"api tests\"}\n"
            )
        );
    }

    #[test]
    fn every_command_round_trips() {
        let commands = [
            Command::View {
                path: String::from("/demo/README.md"),
                down: true,
            },
            Command::Web {
                target: String::from("http://localhost:3000"),
                down: false,
            },
            Command::Term {
                directory: Some(String::from("/demo")),
                command: Some(String::from("pnpm test && pnpm build")),
                down: false,
            },
            Command::Chat {
                agent: Agent::Codex,
                directory: None,
                down: true,
            },
            Command::Title { text: None },
            Command::Panes,
        ];
        for command in commands {
            let sent = request(command);
            let line = encode(&sent).unwrap_or_default();
            assert_eq!(line.iter().filter(|byte| **byte == b'\n').count(), 1);
            assert_eq!(decode_request(&line), Ok(sent));
        }
    }

    #[test]
    fn fields_left_out_take_their_defaults() {
        let line = br#"{"v":1,"pane":1,"token":"t","cmd":"term"}"#;
        assert_eq!(
            decode_request(line).map(|request| request.command),
            Ok(Command::Term {
                directory: None,
                command: None,
                down: false
            })
        );
    }

    #[test]
    fn what_is_not_a_request_is_refused() {
        assert!(decode_request(b"").is_err());
        assert!(decode_request(b"hello").is_err());
        assert!(decode_request(br#"{"v":1,"pane":1,"token":"t"}"#).is_err());
        assert!(decode_request(br#"{"v":1,"pane":1,"token":"t","cmd":"reboot"}"#).is_err());
        assert!(decode_request(br#"{"v":1,"pane":"one","token":"t","cmd":"panes"}"#).is_err());
        assert!(decode_request(br#"{"v":1,"pane":1,"cmd":"panes"}"#).is_err());
        let other = br#"{"v":2,"pane":1,"token":"t","cmd":"panes"}"#;
        assert!(decode_request(other).is_err_and(|error| error.contains("version 2")));
    }

    #[test]
    fn control_characters_and_long_titles_are_refused() {
        let escape = request(Command::Title {
            text: Some(String::from("bad\u{1b}[31m")),
        });
        assert!(decode_request(&encode(&escape).unwrap_or_default()).is_err());
        let long = request(Command::Title {
            text: Some("x".repeat(MAX_TITLE_CHARS + 1)),
        });
        assert!(decode_request(&encode(&long).unwrap_or_default()).is_err());
        let fits = request(Command::Title {
            text: Some("é".repeat(MAX_TITLE_CHARS)),
        });
        assert!(decode_request(&encode(&fits).unwrap_or_default()).is_ok());
        let path = request(Command::View {
            path: String::from("/demo/a\nb"),
            down: false,
        });
        assert!(decode_request(&encode(&path).unwrap_or_default()).is_err());
    }

    #[test]
    fn an_answer_leaves_out_what_it_does_not_have() {
        let line = encode(&Response::done()).unwrap_or_default();
        assert_eq!(String::from_utf8_lossy(&line), "{\"ok\":true}\n");
        let failed = Response::err("no such pane");
        let line = encode(&failed).unwrap_or_default();
        assert_eq!(decode_response(&line), Ok(failed));
    }

    #[test]
    fn a_pane_is_named_with_a_p() {
        assert_eq!(pane_name(3), "p3");
        assert_eq!(parse_pane_name("p3"), Some(3));
        assert_eq!(parse_pane_name("3"), Some(3));
        assert_eq!(parse_pane_name("pane"), None);
    }

    #[test]
    fn an_oversized_message_is_not_sent() {
        let big = request(Command::Web {
            target: "x".repeat(MAX_LINE_BYTES),
            down: false,
        });
        assert!(encode(&big).is_err());
    }
}
