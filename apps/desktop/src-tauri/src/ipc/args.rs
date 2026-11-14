//! Reads the tool's command line. Pure: no files, no environment.

pub const USAGE: &str = "\
kd: drive the app from inside one of its panes

Usage:
  kd view <path> [--down]                      open a file or directory beside this pane
  kd web <url-or-path> [--down]                open a web page beside this pane
  kd term [dir] [-- command...]                open a terminal, optionally running a command
  kd chat [--agent claude|codex] [dir]         open a chat pane
  kd graph [dir]                               open a graph of a Discourse Graphs vault
  kd title <text> | --clear                    set or clear this pane's title
  kd badge <text> [--color <#rrggbb>] | --clear  set or clear this pane's badge
  kd layout <name-or-path>                     open a layout as a new tab
  kd panes                                     print this window's tabs and panes as JSON
  kd <command> --help                          show help for one command

The app binary accepts the same commands after `ctl`.";

const VIEW_USAGE: &str = "\
Usage: kd view <path> [--down]

Opens <path> beside this pane: a directory in a files pane, a file in an
editor pane. A relative path is taken from the current directory.

  --down   split below instead of beside";

const WEB_USAGE: &str = "\
Usage: kd web <url-or-path> [--down]

Opens a web pane beside this pane. An argument containing `://` is a URL.
Anything else is a path to a file on disk, such as a built HTML page.

  --down   split below instead of beside";

const TERM_USAGE: &str = "\
Usage: kd term [dir] [-- command...]

Opens a terminal pane beside this pane, in [dir] or the current directory.
Everything after `--` is typed into the new shell as its first command. One
argument after `--` is typed as it is, so it may hold shell syntax. Several
arguments are quoted where needed and joined with spaces.";

const CHAT_USAGE: &str = "\
Usage: kd chat [--agent claude|codex] [dir]

Opens a chat pane beside this pane, in [dir] or the current directory.

  --agent <name>   which agent answers: claude or codex";

const GRAPH_USAGE: &str = "\
Usage: kd graph [dir]

Opens a graph pane beside this pane, on the notes vault in [dir] or the
current directory. The vault is one that uses the Discourse Graphs plugin
for Obsidian.";

const TITLE_USAGE: &str = "\
Usage: kd title <text>
       kd title --clear

Sets this pane's title, or clears it so the pane names itself again.";

const BADGE_USAGE: &str = "\
Usage: kd badge <text> [--color <#rrggbb>]
       kd badge --clear

Sets or clears the badge in this pane's title bar.

  --color <#rrggbb>   badge colour, as six hex digits";

const LAYOUT_USAGE: &str = "\
Usage: kd layout <name-or-path>

Opens a layout file as a new tab in this window. A bare name such as `review`
is looked up in the app's layout directories. An argument containing `/` or
ending in `.toml` is a path.";

const PANES_USAGE: &str = "\
Usage: kd panes

Prints this window's tabs and panes as JSON.";

const AGENTS: [&str; 2] = ["claude", "codex"];

#[derive(Debug, Clone, PartialEq)]
pub struct BadgeArgs {
    pub text: String,
    pub color: Option<String>,
}

/// What the command line asked for, before any path is looked at.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// Print this text and exit 0.
    Help(&'static str),
    View {
        path: String,
        down: bool,
    },
    Web {
        target: String,
        down: bool,
    },
    Term {
        dir: Option<String>,
        command: Vec<String>,
    },
    Chat {
        agent: Option<String>,
        dir: Option<String>,
    },
    Graph {
        dir: Option<String>,
    },
    /// `None` clears the title.
    Title(Option<String>),
    /// `None` clears the badge.
    Badge(Option<BadgeArgs>),
    Layout(String),
    Panes,
}

/// A command line the tool cannot act on. It exits 2 after printing both.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageError {
    pub message: String,
    pub usage: &'static str,
}

fn usage_for(name: &str) -> Option<&'static str> {
    match name {
        "view" => Some(VIEW_USAGE),
        "web" => Some(WEB_USAGE),
        "term" => Some(TERM_USAGE),
        "chat" => Some(CHAT_USAGE),
        "graph" => Some(GRAPH_USAGE),
        "title" => Some(TITLE_USAGE),
        "badge" => Some(BADGE_USAGE),
        "layout" => Some(LAYOUT_USAGE),
        "panes" => Some(PANES_USAGE),
        _ => None,
    }
}

fn is_help(arg: &str) -> bool {
    arg == "--help" || arg == "-h"
}

struct Spec {
    usage: &'static str,
    /// Options that are on or off.
    switches: &'static [&'static str],
    /// Options that take a value.
    valued: &'static [&'static str],
}

#[derive(Default)]
struct Scanned {
    switches: Vec<String>,
    values: Vec<(String, String)>,
    positionals: Vec<String>,
    /// Everything after a `--`, if there was one.
    trailing: Option<Vec<String>>,
}

impl Scanned {
    fn has(&self, switch: &str) -> bool {
        self.switches.iter().any(|each| each == switch)
    }

    fn value(&self, option: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(name, _)| name == option)
            .map(|(_, value)| value.as_str())
    }

    /// Positional arguments on both sides of a `--`.
    fn words(&self) -> Vec<String> {
        let mut words = self.positionals.clone();
        words.extend(self.trailing.iter().flatten().cloned());
        words
    }
}

impl Spec {
    fn error(&self, message: impl Into<String>) -> UsageError {
        UsageError {
            message: message.into(),
            usage: self.usage,
        }
    }

    fn scan(&self, args: &[String]) -> Result<Scanned, UsageError> {
        let mut scanned = Scanned::default();
        let mut rest = args.iter();
        while let Some(arg) = rest.next() {
            if arg == "--" {
                scanned.trailing = Some(rest.cloned().collect());
                break;
            }
            if arg.len() < 2 || !arg.starts_with('-') {
                scanned.positionals.push(arg.clone());
                continue;
            }
            let (name, inline) = match arg.split_once('=') {
                Some((name, value)) if name.starts_with("--") => (name, Some(value)),
                _ => (arg.as_str(), None),
            };
            if self.switches.contains(&name) {
                if inline.is_some() {
                    return Err(self.error(format!("{name} takes no value")));
                }
                scanned.switches.push(name.to_string());
            } else if self.valued.contains(&name) {
                let value = match inline {
                    Some(value) => value.to_string(),
                    None => rest
                        .next()
                        .cloned()
                        .ok_or_else(|| self.error(format!("{name} needs a value")))?,
                };
                scanned.values.push((name.to_string(), value));
            } else {
                return Err(self.error(format!(
                    "unknown option {name} (put `--` before text that starts with a dash)"
                )));
            }
        }
        Ok(scanned)
    }

    /// The one argument a command needs, named `what` in messages.
    fn exactly_one(&self, words: Vec<String>, what: &str) -> Result<String, UsageError> {
        let mut words = words.into_iter();
        match (words.next(), words.next()) {
            (Some(word), None) if !word.is_empty() => Ok(word),
            (Some(_), None) => Err(self.error(format!("{what} is empty"))),
            (None, _) => Err(self.error(format!("missing {what}"))),
            (Some(_), Some(extra)) => Err(self.error(format!("unexpected argument {extra}"))),
        }
    }

    fn at_most_one(&self, words: Vec<String>) -> Result<Option<String>, UsageError> {
        let mut words = words.into_iter();
        match (words.next(), words.next()) {
            (word, None) => Ok(word.filter(|word| !word.is_empty())),
            (_, Some(extra)) => Err(self.error(format!("unexpected argument {extra}"))),
        }
    }

    /// Free text: the words joined with spaces. `None` when there are none.
    fn text(&self, words: &[String]) -> Option<String> {
        let text = words.join(" ");
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

fn is_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|digit| digit.is_ascii_hexdigit())
}

fn parse_view(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: VIEW_USAGE,
        switches: &["--down"],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    Ok(Command::View {
        path: spec.exactly_one(scanned.words(), "path")?,
        down: scanned.has("--down"),
    })
}

fn parse_web(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: WEB_USAGE,
        switches: &["--down"],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    Ok(Command::Web {
        target: spec.exactly_one(scanned.words(), "url or path")?,
        down: scanned.has("--down"),
    })
}

fn parse_term(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: TERM_USAGE,
        switches: &[],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    let command = scanned.trailing.clone().unwrap_or_default();
    if scanned.trailing.is_some() && spec.text(&command).is_none() {
        return Err(spec.error("missing command after `--`"));
    }
    Ok(Command::Term {
        dir: spec.at_most_one(scanned.positionals)?,
        command,
    })
}

fn parse_chat(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: CHAT_USAGE,
        switches: &[],
        valued: &["--agent"],
    };
    let scanned = spec.scan(args)?;
    let agent = scanned.value("--agent").map(str::to_string);
    if let Some(agent) = &agent {
        if !AGENTS.contains(&agent.as_str()) {
            return Err(spec.error(format!(
                "unknown agent {agent} (expected {})",
                AGENTS.join(" or ")
            )));
        }
    }
    Ok(Command::Chat {
        agent,
        dir: spec.at_most_one(scanned.words())?,
    })
}

fn parse_graph(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: GRAPH_USAGE,
        switches: &[],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    Ok(Command::Graph {
        dir: spec.at_most_one(scanned.words())?,
    })
}

fn parse_title(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: TITLE_USAGE,
        switches: &["--clear"],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    let text = spec.text(&scanned.words());
    match (scanned.has("--clear"), text) {
        (true, None) => Ok(Command::Title(None)),
        (true, Some(_)) => Err(spec.error("--clear takes no text")),
        (false, Some(text)) => Ok(Command::Title(Some(text))),
        (false, None) => Err(spec.error("missing title text")),
    }
}

fn parse_badge(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: BADGE_USAGE,
        switches: &["--clear"],
        valued: &["--color"],
    };
    let scanned = spec.scan(args)?;
    let color = scanned.value("--color").map(str::to_string);
    if let Some(color) = &color {
        if !is_color(color) {
            return Err(spec.error(format!(
                "{color} is not a colour (expected six hex digits, like #ff8800)"
            )));
        }
    }
    let text = spec.text(&scanned.words());
    match (scanned.has("--clear"), text) {
        (true, None) if color.is_none() => Ok(Command::Badge(None)),
        (true, _) => Err(spec.error("--clear takes no text and no colour")),
        (false, Some(text)) => Ok(Command::Badge(Some(BadgeArgs { text, color }))),
        (false, None) => Err(spec.error("missing badge text")),
    }
}

fn parse_layout(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: LAYOUT_USAGE,
        switches: &[],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    Ok(Command::Layout(
        spec.exactly_one(scanned.words(), "layout name or path")?,
    ))
}

fn parse_panes(args: &[String]) -> Result<Command, UsageError> {
    let spec = Spec {
        usage: PANES_USAGE,
        switches: &[],
        valued: &[],
    };
    let scanned = spec.scan(args)?;
    match scanned.words().first() {
        Some(extra) => Err(spec.error(format!("unexpected argument {extra}"))),
        None => Ok(Command::Panes),
    }
}

/// Reads the arguments that follow the tool's own name.
pub fn parse_args(args: &[String]) -> Result<Command, UsageError> {
    let general = |message: String| UsageError {
        message,
        usage: USAGE,
    };
    let Some((name, rest)) = args.split_first() else {
        return Err(general(String::from("missing command")));
    };
    if is_help(name) {
        return Ok(Command::Help(USAGE));
    }
    if name == "help" {
        return match rest.first() {
            None => Ok(Command::Help(USAGE)),
            Some(topic) => usage_for(topic)
                .map(Command::Help)
                .ok_or_else(|| general(format!("unknown command {topic}"))),
        };
    }
    let Some(usage) = usage_for(name) else {
        return Err(general(format!("unknown command {name}")));
    };
    // A help flag after `--` is text for the command, not a request for help.
    if rest
        .iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| is_help(arg))
    {
        return Ok(Command::Help(usage));
    }
    match name.as_str() {
        "view" => parse_view(rest),
        "web" => parse_web(rest),
        "term" => parse_term(rest),
        "chat" => parse_chat(rest),
        "graph" => parse_graph(rest),
        "title" => parse_title(rest),
        "badge" => parse_badge(rest),
        "layout" => parse_layout(rest),
        "panes" => parse_panes(rest),
        _ => Err(general(format!("unknown command {name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &[&str]) -> Result<Command, UsageError> {
        let args: Vec<String> = line.iter().map(|arg| (*arg).to_string()).collect();
        parse_args(&args)
    }

    fn message(line: &[&str]) -> String {
        parse(line).unwrap_err().message
    }

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn no_arguments_is_a_usage_error() {
        let error = parse(&[]).unwrap_err();
        assert_eq!(error.message, "missing command");
        assert_eq!(error.usage, USAGE);
    }

    #[test]
    fn unknown_commands_get_the_general_usage() {
        let error = parse(&["explode"]).unwrap_err();
        assert_eq!(error.message, "unknown command explode");
        assert_eq!(error.usage, USAGE);
        assert_eq!(message(&["--version"]), "unknown command --version");
        assert_eq!(message(&["help", "explode"]), "unknown command explode");
    }

    #[test]
    fn help_is_available_at_every_level() {
        assert_eq!(parse(&["--help"]), Ok(Command::Help(USAGE)));
        assert_eq!(parse(&["-h"]), Ok(Command::Help(USAGE)));
        assert_eq!(parse(&["help"]), Ok(Command::Help(USAGE)));
        assert_eq!(parse(&["help", "view"]), Ok(Command::Help(VIEW_USAGE)));
        for name in [
            "view", "web", "term", "chat", "graph", "title", "badge", "layout", "panes",
        ] {
            let usage = usage_for(name).unwrap();
            assert!(usage.starts_with(&format!("Usage: kd {name}")));
            assert_eq!(parse(&[name, "--help"]), Ok(Command::Help(usage)));
            assert_eq!(parse(&[name, "x", "-h"]), Ok(Command::Help(usage)));
            assert!(USAGE.contains(&format!("kd {name}")));
        }
    }

    #[test]
    fn a_help_flag_after_the_separator_is_plain_text() {
        assert_eq!(
            parse(&["title", "--", "--help"]),
            Ok(Command::Title(Some(String::from("--help"))))
        );
        assert_eq!(
            parse(&["term", "--", "cargo", "--help"]),
            Ok(Command::Term {
                dir: None,
                command: strings(&["cargo", "--help"]),
            })
        );
    }

    #[test]
    fn view_takes_one_path_and_an_optional_direction() {
        assert_eq!(
            parse(&["view", "notes.md"]),
            Ok(Command::View {
                path: String::from("notes.md"),
                down: false,
            })
        );
        assert_eq!(
            parse(&["view", "--down", "src"]),
            Ok(Command::View {
                path: String::from("src"),
                down: true,
            })
        );
        assert_eq!(
            parse(&["view", "src", "--down"]),
            Ok(Command::View {
                path: String::from("src"),
                down: true,
            })
        );
        assert_eq!(
            parse(&["view", "--", "-odd-name"]),
            Ok(Command::View {
                path: String::from("-odd-name"),
                down: false,
            })
        );
        assert_eq!(message(&["view"]), "missing path");
        assert_eq!(message(&["view", ""]), "path is empty");
        assert_eq!(message(&["view", "a", "b"]), "unexpected argument b");
        assert_eq!(
            message(&["view", "--down=yes", "a"]),
            "--down takes no value"
        );
        assert!(message(&["view", "--sideways", "a"]).starts_with("unknown option --sideways"));
        assert_eq!(parse(&["view"]).unwrap_err().usage, VIEW_USAGE);
    }

    #[test]
    fn web_takes_a_url_or_a_path() {
        assert_eq!(
            parse(&["web", "https://example.com/a?b=c"]),
            Ok(Command::Web {
                target: String::from("https://example.com/a?b=c"),
                down: false,
            })
        );
        assert_eq!(
            parse(&["web", "dist/index.html", "--down"]),
            Ok(Command::Web {
                target: String::from("dist/index.html"),
                down: true,
            })
        );
        assert_eq!(message(&["web"]), "missing url or path");
        assert_eq!(message(&["web", "a", "b"]), "unexpected argument b");
    }

    #[test]
    fn term_takes_a_directory_and_a_command() {
        assert_eq!(
            parse(&["term"]),
            Ok(Command::Term {
                dir: None,
                command: Vec::new(),
            })
        );
        assert_eq!(
            parse(&["term", "api"]),
            Ok(Command::Term {
                dir: Some(String::from("api")),
                command: Vec::new(),
            })
        );
        assert_eq!(
            parse(&["term", "--", "pnpm", "dev", "--port", "3000"]),
            Ok(Command::Term {
                dir: None,
                command: strings(&["pnpm", "dev", "--port", "3000"]),
            })
        );
        assert_eq!(
            parse(&["term", "api", "--", "make", "--", "test"]),
            Ok(Command::Term {
                dir: Some(String::from("api")),
                command: strings(&["make", "--", "test"]),
            })
        );
        assert_eq!(message(&["term", "a", "b"]), "unexpected argument b");
        assert_eq!(message(&["term", "--"]), "missing command after `--`");
        assert!(message(&["term", "--down"]).starts_with("unknown option --down"));
    }

    #[test]
    fn chat_takes_an_agent_and_a_directory() {
        assert_eq!(
            parse(&["chat"]),
            Ok(Command::Chat {
                agent: None,
                dir: None,
            })
        );
        assert_eq!(
            parse(&["chat", "--agent", "codex", "api"]),
            Ok(Command::Chat {
                agent: Some(String::from("codex")),
                dir: Some(String::from("api")),
            })
        );
        assert_eq!(
            parse(&["chat", "api", "--agent=claude"]),
            Ok(Command::Chat {
                agent: Some(String::from("claude")),
                dir: Some(String::from("api")),
            })
        );
        assert_eq!(message(&["chat", "--agent"]), "--agent needs a value");
        assert_eq!(
            message(&["chat", "--agent", "hal"]),
            "unknown agent hal (expected claude or codex)"
        );
        assert_eq!(message(&["chat", "a", "b"]), "unexpected argument b");
    }

    #[test]
    fn graph_takes_an_optional_directory() {
        assert_eq!(parse(&["graph"]), Ok(Command::Graph { dir: None }));
        assert_eq!(
            parse(&["graph", "vault"]),
            Ok(Command::Graph {
                dir: Some(String::from("vault")),
            })
        );
        assert_eq!(message(&["graph", "a", "b"]), "unexpected argument b");
        assert!(message(&["graph", "--down"]).starts_with("unknown option --down"));
        assert_eq!(parse(&["graph", "a", "b"]).unwrap_err().usage, GRAPH_USAGE);
    }

    #[test]
    fn title_sets_or_clears() {
        assert_eq!(
            parse(&["title", "build"]),
            Ok(Command::Title(Some(String::from("build"))))
        );
        assert_eq!(
            parse(&["title", "tests", "are", "red"]),
            Ok(Command::Title(Some(String::from("tests are red"))))
        );
        assert_eq!(parse(&["title", "--clear"]), Ok(Command::Title(None)));
        assert_eq!(
            parse(&["title", "--", "--clear"]),
            Ok(Command::Title(Some(String::from("--clear"))))
        );
        assert_eq!(message(&["title"]), "missing title text");
        assert_eq!(message(&["title", ""]), "missing title text");
        assert_eq!(message(&["title", "--clear", "x"]), "--clear takes no text");
    }

    #[test]
    fn badge_sets_or_clears() {
        assert_eq!(
            parse(&["badge", "!"]),
            Ok(Command::Badge(Some(BadgeArgs {
                text: String::from("!"),
                color: None,
            })))
        );
        assert_eq!(
            parse(&["badge", "needs", "you", "--color", "#FF8800"]),
            Ok(Command::Badge(Some(BadgeArgs {
                text: String::from("needs you"),
                color: Some(String::from("#FF8800")),
            })))
        );
        assert_eq!(
            parse(&["badge", "--color=#00ff00", "ok"]),
            Ok(Command::Badge(Some(BadgeArgs {
                text: String::from("ok"),
                color: Some(String::from("#00ff00")),
            })))
        );
        assert_eq!(parse(&["badge", "--clear"]), Ok(Command::Badge(None)));
        assert_eq!(message(&["badge"]), "missing badge text");
        assert_eq!(message(&["badge", "x", "--color"]), "--color needs a value");
        for bad in ["red", "#fff", "#gggggg", "ff8800f", "#ff88001"] {
            assert!(
                message(&["badge", "x", "--color", bad]).contains("is not a colour"),
                "{bad}"
            );
        }
        assert_eq!(
            message(&["badge", "--clear", "x"]),
            "--clear takes no text and no colour"
        );
        assert_eq!(
            message(&["badge", "--clear", "--color", "#ff0000"]),
            "--clear takes no text and no colour"
        );
    }

    #[test]
    fn layout_takes_one_name_or_path() {
        assert_eq!(
            parse(&["layout", "review"]),
            Ok(Command::Layout(String::from("review")))
        );
        assert_eq!(
            parse(&["layout", "./tabs/review.toml"]),
            Ok(Command::Layout(String::from("./tabs/review.toml")))
        );
        assert_eq!(message(&["layout"]), "missing layout name or path");
        assert_eq!(message(&["layout", "a", "b"]), "unexpected argument b");
    }

    #[test]
    fn panes_takes_nothing() {
        assert_eq!(parse(&["panes"]), Ok(Command::Panes));
        assert_eq!(message(&["panes", "x"]), "unexpected argument x");
        assert!(message(&["panes", "--json"]).starts_with("unknown option --json"));
    }

    #[test]
    fn a_lone_dash_is_an_argument() {
        assert_eq!(
            parse(&["title", "-"]),
            Ok(Command::Title(Some(String::from("-"))))
        );
    }
}
