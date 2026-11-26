//! The `kd` command line: what it accepts, and what it sends.

use std::path::{Path, PathBuf};

use super::client;
use super::protocol::{
    Command, ENV_PANE, ENV_SOCKET, ENV_TOKEN, MAX_TITLE_CHARS, Request, VERSION, parse_pane_name,
};
use crate::chat::Agent;

pub const USAGE: &str = "\
kd drives the app from inside a terminal pane.

  kd view <path> [--down]             open a file in an editor, or a folder in a files pane
  kd web <url-or-path> [--down]       open a web pane
  kd term [dir] [--down] [-- cmd...]  open a terminal, and type a first command into it
  kd chat [--agent claude|codex|gemini|qwen|local] [dir] [--down]
                                      open a chat pane
  kd title <text>                     set this pane's title
  kd title --clear                    clear it
  kd panes                            print the window's tabs and panes as JSON
  kd mcp                              serve these commands as MCP tools on stdin and stdout

New panes open to the right of the calling pane, or below it with --down.
Relative paths are taken from the directory kd runs in.
Put -- before text that starts with a dash: kd title -- --draft
Exit codes: 0 done, 1 failed (the reason is on stderr), 2 the command line was wrong.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Help,
    Send(Command),
}

fn absolute(cwd: &Path, path: &str) -> String {
    let path = crate::shell::layout::expand_home(path);
    let joined = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    joined.to_string_lossy().into_owned()
}

/// Quotes an argument for the shell, so `kd term -- echo "a b"` types what
/// was meant.
fn quote(argument: &str) -> String {
    let plain = !argument.is_empty()
        && argument
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c));
    if plain {
        argument.to_string()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

/// Flags and plain arguments, up to a `--`. What follows `--` is returned
/// apart, untouched.
struct Words<'a> {
    flags: Vec<&'a str>,
    plain: Vec<&'a str>,
    rest: Option<&'a [String]>,
}

fn words(args: &[String]) -> Words<'_> {
    let split = args.iter().position(|arg| arg == "--");
    let (before, rest) = match split {
        Some(at) => (&args[..at], Some(&args[at + 1..])),
        None => (args, None),
    };
    let (flags, plain) = before
        .iter()
        .map(String::as_str)
        .partition(|arg| arg.starts_with("--"));
    Words { flags, plain, rest }
}

/// Takes `--down` out of the flags, and refuses any flag not in `known`.
fn take_down(flags: &[&str], known: &[&str]) -> Result<bool, String> {
    match flags
        .iter()
        .find(|flag| **flag != "--down" && !known.contains(flag))
    {
        Some(flag) => Err(format!("unknown option {flag}")),
        None => Ok(flags.contains(&"--down")),
    }
}

/// Reads the arguments after `kd`. An error is a line for standard error.
pub fn parse(args: &[String], cwd: &Path) -> Result<Parsed, String> {
    let Some((name, args)) = args.split_first() else {
        return Ok(Parsed::Help);
    };
    if matches!(name.as_str(), "--help" | "-h" | "help")
        || args
            .iter()
            .take_while(|arg| *arg != "--")
            .any(|arg| arg == "--help")
    {
        return Ok(Parsed::Help);
    }
    let Words { flags, plain, rest } = words(args);
    let command = match name.as_str() {
        "view" => {
            let down = take_down(&flags, &[])?;
            match (plain.as_slice(), rest) {
                ([path], None) => Command::View {
                    path: absolute(cwd, path),
                    down,
                },
                _ => return Err(String::from("kd view takes one path")),
            }
        }
        "web" => {
            let down = take_down(&flags, &[])?;
            let [target] = plain.as_slice() else {
                return Err(String::from("kd web takes one URL or path"));
            };
            let target = if target.contains("://") {
                (*target).to_string()
            } else {
                let file = absolute(cwd, target);
                if !Path::new(&file).is_file() {
                    return Err(format!(
                        "{target} is not a file. Write a URL in full, such as http://localhost:3000"
                    ));
                }
                file
            };
            Command::Web { target, down }
        }
        "term" => {
            let down = take_down(&flags, &[])?;
            let directory = match plain.as_slice() {
                [] => None,
                [directory] => Some(absolute(cwd, directory)),
                _ => return Err(String::from("kd term takes one directory")),
            };
            let command = match rest {
                None | Some([]) => None,
                // One argument is typed as written, so it can hold shell
                // syntax. Several are quoted one by one.
                Some([one]) => Some(one.clone()),
                Some(many) => Some(
                    many.iter()
                        .map(|argument| quote(argument))
                        .collect::<Vec<_>>()
                        .join(" "),
                ),
            };
            Command::Term {
                // A new terminal starts where kd ran, as a new pane does.
                directory: directory.or_else(|| Some(cwd.to_string_lossy().into_owned())),
                command,
                down,
            }
        }
        "chat" => {
            // `--agent codex` puts the agent's name among the plain words.
            let at = args.iter().position(|arg| arg == "--agent");
            let named = at.and_then(|at| args.get(at + 1)).map(String::as_str);
            let agent = match (at, named.and_then(Agent::from_name)) {
                (None, _) => Agent::Claude,
                (Some(_), Some(agent)) => agent,
                (Some(_), None) => {
                    return Err(String::from(
                        "--agent takes claude, codex, gemini, qwen or local",
                    ));
                }
            };
            let down = take_down(&flags, &["--agent"])?;
            let mut plain = plain;
            if let Some(named) = named
                && let Some(position) = plain.iter().position(|word| *word == named)
            {
                plain.remove(position);
            }
            let directory = match plain.as_slice() {
                [] => cwd.to_string_lossy().into_owned(),
                [directory] => absolute(cwd, directory),
                _ => return Err(String::from("kd chat takes one directory")),
            };
            Command::Chat {
                agent,
                directory: Some(directory),
                down,
            }
        }
        "title" => {
            let clear = flags.contains(&"--clear");
            if let Some(flag) = flags.iter().find(|flag| **flag != "--clear") {
                return Err(format!("unknown option {flag}"));
            }
            let mut text: Vec<&str> = plain;
            text.extend(rest.unwrap_or_default().iter().map(String::as_str));
            let text = text.join(" ");
            match (clear, text.trim()) {
                (true, "") => Command::Title { text: None },
                (true, _) => return Err(String::from("kd title takes text or --clear, not both")),
                (false, "") => return Err(String::from("kd title takes the text of the title")),
                (false, text) if text.chars().count() > MAX_TITLE_CHARS => {
                    return Err(format!("a title is at most {MAX_TITLE_CHARS} characters"));
                }
                (false, text) => Command::Title {
                    text: Some(text.to_string()),
                },
            }
        }
        "panes" => {
            if !args.is_empty() {
                return Err(String::from("kd panes takes no arguments"));
            }
            Command::Panes
        }
        other => return Err(format!("unknown command {other}")),
    };
    Ok(Parsed::Send(command))
}

/// Where to send a request and who is asking, from the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub socket: PathBuf,
    pub pane: u64,
    pub token: String,
}

impl Caller {
    pub fn from(variable: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let missing = |name: &str| {
            format!("kd only works inside a terminal pane of the app ({name} is not set)")
        };
        let socket = variable(ENV_SOCKET)
            .filter(|socket| !socket.is_empty())
            .ok_or_else(|| missing(ENV_SOCKET))?;
        let pane = variable(ENV_PANE).ok_or_else(|| missing(ENV_PANE))?;
        let token = variable(ENV_TOKEN).ok_or_else(|| missing(ENV_TOKEN))?;
        Ok(Self {
            socket: PathBuf::from(socket),
            pane: parse_pane_name(&pane).ok_or_else(|| format!("{ENV_PANE} is not a pane id"))?,
            token,
        })
    }
}

/// Runs `kd` with the arguments after its name, and returns its exit code.
pub fn run(args: &[String]) -> i32 {
    if let Some((name, rest)) = args.split_first()
        && name == "mcp"
    {
        return super::mcp::run(rest);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let command = match parse(args, &cwd) {
        Ok(Parsed::Help) => {
            println!("{USAGE}");
            return 0;
        }
        Ok(Parsed::Send(command)) => command,
        Err(error) => {
            eprintln!("kd: {error}\nTry kd --help");
            return 2;
        }
    };
    let caller = match Caller::from(|name| std::env::var(name).ok()) {
        Ok(caller) => caller,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let request = Request {
        v: VERSION,
        pane: caller.pane,
        token: caller.token,
        command,
    };
    match client::call(&caller.socket, &request) {
        Ok(response) if response.ok => {
            if let Some(data) = response.data {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
                );
            }
            0
        }
        Ok(response) => {
            eprintln!(
                "kd: {}",
                response
                    .error
                    .unwrap_or_else(|| String::from("the app refused"))
            );
            1
        }
        Err(error) => {
            eprintln!("kd: {error}");
            1
        }
    }
}

/// Whether the program was started under the name `kd`.
pub fn invoked_as_kd(program: Option<&str>) -> bool {
    program
        .and_then(|program| Path::new(program).file_name())
        .is_some_and(|name| name == "kd")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(line: &str) -> Result<Parsed, String> {
        let args: Vec<String> = line.split_whitespace().map(String::from).collect();
        parse(&args, Path::new("/work/demo"))
    }

    fn sent(line: &str) -> Option<Command> {
        match parsed(line) {
            Ok(Parsed::Send(command)) => Some(command),
            _ => None,
        }
    }

    #[test]
    fn view_takes_a_path_from_where_kd_runs() {
        assert_eq!(
            sent("view src/main.rs"),
            Some(Command::View {
                path: String::from("/work/demo/src/main.rs"),
                down: false
            })
        );
        assert_eq!(
            sent("view --down /etc/hosts"),
            Some(Command::View {
                path: String::from("/etc/hosts"),
                down: true
            })
        );
        assert!(parsed("view").is_err());
        assert!(parsed("view a b").is_err());
        assert!(parsed("view a --sideways").is_err());
    }

    #[test]
    fn web_takes_a_url_as_written_and_a_path_only_if_it_is_a_file() {
        assert_eq!(
            sent("web http://localhost:3000 --down"),
            Some(Command::Web {
                target: String::from("http://localhost:3000"),
                down: true
            })
        );
        let missing = parsed("web localhost:3000");
        assert!(missing.is_err_and(|error| error.contains("http://localhost:3000")));
        let dir = std::env::temp_dir().join(format!("krang-kd-web-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("index.html"), "<p>hi</p>");
        let args = [String::from("web"), String::from("index.html")];
        assert_eq!(
            parse(&args, &dir),
            Ok(Parsed::Send(Command::Web {
                target: dir.join("index.html").to_string_lossy().into_owned(),
                down: false
            }))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn term_types_one_argument_as_written_and_quotes_several() {
        let args =
            |list: &[&str]| -> Vec<String> { list.iter().map(|s| (*s).to_string()).collect() };
        let command = |list: &[&str]| match parse(&args(list), Path::new("/work/demo")) {
            Ok(Parsed::Send(Command::Term {
                directory, command, ..
            })) => Some((directory, command)),
            _ => None,
        };
        let here = Some(String::from("/work/demo"));
        assert_eq!(command(&["term"]), Some((here.clone(), None)));
        assert_eq!(
            command(&["term", "api", "--", "pnpm", "dev"]),
            Some((
                Some(String::from("/work/demo/api")),
                Some(String::from("pnpm dev"))
            ))
        );
        assert_eq!(
            command(&["term", "--", "pnpm test && pnpm build"]),
            Some((here.clone(), Some(String::from("pnpm test && pnpm build"))))
        );
        assert_eq!(
            command(&["term", "--", "echo", "a b", "it's", "--flag"]),
            Some((here, Some(String::from("echo 'a b' 'it'\\''s' --flag"))))
        );
        assert!(parsed("term a b").is_err());
    }

    #[test]
    fn chat_takes_an_agent_and_a_directory() {
        assert_eq!(
            sent("chat"),
            Some(Command::Chat {
                agent: Agent::Claude,
                directory: Some(String::from("/work/demo")),
                down: false
            })
        );
        assert_eq!(
            sent("chat --agent codex api --down"),
            Some(Command::Chat {
                agent: Agent::Codex,
                directory: Some(String::from("/work/demo/api")),
                down: true
            })
        );
        assert_eq!(
            sent("chat --agent gemini"),
            Some(Command::Chat {
                agent: Agent::Gemini,
                directory: Some(String::from("/work/demo")),
                down: false
            })
        );
        assert_eq!(
            sent("chat --agent local"),
            Some(Command::Chat {
                agent: Agent::Local,
                directory: Some(String::from("/work/demo")),
                down: false
            })
        );
        assert!(parsed("chat --agent").is_err());
        assert!(parsed("chat --agent gpt").is_err());
    }

    #[test]
    fn title_takes_text_or_clear() {
        assert_eq!(
            sent("title api tests"),
            Some(Command::Title {
                text: Some(String::from("api tests"))
            })
        );
        assert_eq!(sent("title --clear"), Some(Command::Title { text: None }));
        assert_eq!(
            sent("title -- --draft"),
            Some(Command::Title {
                text: Some(String::from("--draft"))
            })
        );
        assert!(parsed("title").is_err());
        assert!(parsed("title --clear now").is_err());
        assert!(parsed(&format!("title {}", "x".repeat(201))).is_err());
    }

    #[test]
    fn help_and_unknown_commands() {
        assert_eq!(parsed(""), Ok(Parsed::Help));
        assert_eq!(parsed("--help"), Ok(Parsed::Help));
        assert_eq!(parsed("view --help"), Ok(Parsed::Help));
        assert_eq!(sent("panes"), Some(Command::Panes));
        assert!(parsed("panes now").is_err());
        assert!(parsed("badge done").is_err_and(|error| error.contains("badge")));
    }

    #[test]
    fn the_caller_comes_from_the_panes_environment() {
        let inside = |name: &str| match name {
            ENV_SOCKET => Some(String::from("/run/kd.sock")),
            ENV_PANE => Some(String::from("p7")),
            ENV_TOKEN => Some(String::from("secret")),
            _ => None,
        };
        assert_eq!(
            Caller::from(inside),
            Ok(Caller {
                socket: PathBuf::from("/run/kd.sock"),
                pane: 7,
                token: String::from("secret")
            })
        );
        let outside = Caller::from(|_| None);
        assert!(outside.is_err_and(|error| error.contains("KRANG_SOCKET is not set")));
    }

    #[test]
    fn the_program_knows_the_name_it_was_started_under() {
        assert!(invoked_as_kd(Some("/run/krang/bin/kd")));
        assert!(invoked_as_kd(Some("kd")));
        assert!(!invoked_as_kd(Some(
            "/Applications/Krang Shell.app/Contents/MacOS/krang-shell"
        )));
        assert!(!invoked_as_kd(None));
    }
}
