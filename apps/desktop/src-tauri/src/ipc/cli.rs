//! The tool's side: turn a parsed command line into one request, send it,
//! and report the answer.

use std::path::{Component, Path, PathBuf};

use super::args::{self, parse_args};
use super::protocol::{Badge, Command, Direction, LayoutTarget, PathKind, Request, WebTarget};
use super::socket;

pub const SOCKET_ENV: &str = "DESKTOP_SOCKET";
pub const CLI_ENV: &str = "DESKTOP_CLI";
const WINDOW_ENV: &str = "DESKTOP_WINDOW";
const PANE_ENV: &str = "DESKTOP_PANE_ID";

const OUTSIDE_APP: &str = "kd only works inside a pane of the app (DESKTOP_SOCKET is not set)";

/// Where the tool was run from, and what its pane told it.
pub struct Caller {
    pub socket: Option<String>,
    pub window: Option<String>,
    pub pane: Option<String>,
    pub cwd: Option<PathBuf>,
}

impl Caller {
    fn from_process() -> Self {
        let read = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        Self {
            socket: read(SOCKET_ENV),
            window: read(WINDOW_ENV),
            pane: read(PANE_ENV),
            cwd: std::env::current_dir().ok(),
        }
    }
}

/// Makes a path absolute against `cwd` and folds away `.` and `..`, without
/// following links: the pane should show the path the person typed.
fn absolute(cwd: &Path, path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in cwd.join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn text_of(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{} is not valid UTF-8", path.display()))
}

fn existing_directory(cwd: &Path, dir: Option<&str>) -> Result<String, String> {
    let path = absolute(cwd, dir.unwrap_or("."));
    if !path.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    text_of(&path)
}

fn needs_quotes(word: &str) -> bool {
    word.is_empty()
        || !word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c))
}

/// The line typed into a new terminal. One word is taken as written, so it
/// can hold pipes and `&&`. Several words are quoted so each stays one word.
fn shell_line(words: &[String]) -> Option<String> {
    match words {
        [] => None,
        [only] => Some(only.clone()),
        many => Some(
            many.iter()
                .map(|word| {
                    if needs_quotes(word) {
                        format!("'{}'", word.replace('\'', "'\\''"))
                    } else {
                        word.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
    }
}

fn direction(down: bool) -> Direction {
    if down {
        Direction::Column
    } else {
        Direction::Row
    }
}

/// Resolves a parsed command line into the command that crosses the socket.
/// Paths are checked here because only the tool knows its working directory.
fn to_wire(command: args::Command, cwd: &Path) -> Result<Command, String> {
    match command {
        args::Command::Help(_) => Err(String::from("help is not sent to the app")),
        args::Command::View { path, down } => {
            let path = absolute(cwd, &path);
            let kind = if path.is_dir() {
                PathKind::Directory
            } else if path.is_file() {
                PathKind::File
            } else {
                return Err(format!("no such file or directory: {}", path.display()));
            };
            Ok(Command::View {
                path: text_of(&path)?,
                kind,
                direction: direction(down),
            })
        }
        args::Command::Web { target, down } => {
            let target = if target.contains("://") {
                WebTarget::Url(target)
            } else {
                let path = absolute(cwd, &target);
                if !path.is_file() {
                    return Err(format!(
                        "no such file: {} (a web address needs its scheme, like https://)",
                        path.display()
                    ));
                }
                WebTarget::Path(text_of(&path)?)
            };
            Ok(Command::Web {
                target,
                direction: direction(down),
            })
        }
        args::Command::Term { dir, command } => Ok(Command::Term {
            directory: existing_directory(cwd, dir.as_deref())?,
            command: shell_line(&command),
        }),
        args::Command::Chat { agent, dir } => Ok(Command::Chat {
            agent,
            directory: existing_directory(cwd, dir.as_deref())?,
        }),
        args::Command::Title(title) => Ok(Command::Title { title }),
        args::Command::Badge(badge) => Ok(Command::Badge {
            badge: badge.map(|badge| Badge {
                text: badge.text,
                color: badge.color,
            }),
        }),
        args::Command::Layout(target) => {
            let target = if target.contains('/') || target.ends_with(".toml") {
                let path = absolute(cwd, &target);
                if !path.is_file() {
                    return Err(format!("no such layout file: {}", path.display()));
                }
                LayoutTarget::Path(text_of(&path)?)
            } else {
                LayoutTarget::Name(target)
            };
            Ok(Command::Layout { target })
        }
        args::Command::Panes => Ok(Command::Panes),
    }
}

/// Sends one command to the app. Returns what to print, if anything.
pub fn execute(command: args::Command, caller: &Caller) -> Result<Option<String>, String> {
    let Some(socket) = &caller.socket else {
        return Err(String::from(OUTSIDE_APP));
    };
    let (Some(window), Some(pane)) = (&caller.window, &caller.pane) else {
        return Err(format!(
            "kd needs {WINDOW_ENV} and {PANE_ENV}, which the app sets in each pane's shell"
        ));
    };
    let cwd = caller
        .cwd
        .as_deref()
        .ok_or_else(|| String::from("could not read the current directory"))?;
    let request = Request {
        window: window.clone(),
        pane: pane.clone(),
        command: to_wire(command, cwd)?,
    };
    let response = socket::send(Path::new(socket), &request)?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| String::from("the app refused the request")));
    }
    match response.data {
        None => Ok(None),
        Some(data) => serde_json::to_string_pretty(&data)
            .map(Some)
            .map_err(|error| format!("could not print the reply: {error}")),
    }
}

/// Runs the tool with the arguments that follow its name. Returns the exit
/// code: 0 done, 1 failed, 2 the command line was wrong.
pub fn run(args: &[String]) -> i32 {
    match parse_args(args) {
        Err(error) => {
            eprintln!("kd: {}\n\n{}", error.message, error.usage);
            2
        }
        Ok(args::Command::Help(text)) => {
            println!("{text}");
            0
        }
        Ok(command) => match execute(command, &Caller::from_process()) {
            Ok(Some(output)) => {
                println!("{output}");
                0
            }
            Ok(None) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::protocol::Response;
    use crate::ipc::socket::test_support::temp_dir;
    use serde_json::json;
    use std::fs;
    use std::os::unix::net::UnixListener;
    use std::sync::{Arc, Mutex};

    fn words(line: &[&str]) -> Vec<String> {
        line.iter().map(|word| (*word).to_string()).collect()
    }

    fn parsed(line: &[&str]) -> args::Command {
        parse_args(&words(line)).unwrap()
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn paths_are_made_absolute_without_following_links() {
        let cwd = Path::new("/work/app");
        assert_eq!(
            absolute(cwd, "src/main.rs"),
            Path::new("/work/app/src/main.rs")
        );
        assert_eq!(absolute(cwd, "./a/../b"), Path::new("/work/app/b"));
        assert_eq!(absolute(cwd, "../../../.."), Path::new("/"));
        assert_eq!(absolute(cwd, "/etc/hosts"), Path::new("/etc/hosts"));
        assert_eq!(absolute(cwd, "."), Path::new("/work/app"));
    }

    #[test]
    fn a_single_command_word_is_typed_as_written() {
        assert_eq!(shell_line(&[]), None);
        assert_eq!(
            shell_line(&words(&["pnpm test && echo done"])).as_deref(),
            Some("pnpm test && echo done")
        );
        assert_eq!(
            shell_line(&words(&["pnpm", "dev", "--port=3000"])).as_deref(),
            Some("pnpm dev --port=3000")
        );
        assert_eq!(
            shell_line(&words(&["git", "commit", "-m", "it's done", ""])).as_deref(),
            Some("git commit -m 'it'\\''s done' ''")
        );
    }

    #[test]
    fn view_tells_files_from_directories() {
        let dir = temp_dir("view");
        fs::write(dir.join("notes.md"), "hello").unwrap();
        fs::create_dir(dir.join("src")).unwrap();

        assert_eq!(
            to_wire(parsed(&["view", "notes.md"]), &dir),
            Ok(Command::View {
                path: text(&dir.join("notes.md")),
                kind: PathKind::File,
                direction: Direction::Row,
            })
        );
        assert_eq!(
            to_wire(parsed(&["view", "./src/", "--down"]), &dir),
            Ok(Command::View {
                path: text(&dir.join("src")),
                kind: PathKind::Directory,
                direction: Direction::Column,
            })
        );
        let missing = to_wire(parsed(&["view", "nope.md"]), &dir).unwrap_err();
        assert!(
            missing.starts_with("no such file or directory: "),
            "{missing}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn web_tells_addresses_from_files() {
        let dir = temp_dir("web");
        fs::write(dir.join("index.html"), "<p>hi</p>").unwrap();

        assert_eq!(
            to_wire(parsed(&["web", "http://localhost:3000/a"]), &dir),
            Ok(Command::Web {
                target: WebTarget::Url(String::from("http://localhost:3000/a")),
                direction: Direction::Row,
            })
        );
        assert_eq!(
            to_wire(parsed(&["web", "index.html", "--down"]), &dir),
            Ok(Command::Web {
                target: WebTarget::Path(text(&dir.join("index.html"))),
                direction: Direction::Column,
            })
        );
        let missing = to_wire(parsed(&["web", "example.com"]), &dir).unwrap_err();
        assert!(
            missing.contains("a web address needs its scheme"),
            "{missing}"
        );

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn term_and_chat_default_to_the_working_directory() {
        let dir = temp_dir("term");
        fs::create_dir(dir.join("api")).unwrap();

        assert_eq!(
            to_wire(parsed(&["term"]), &dir),
            Ok(Command::Term {
                directory: text(&dir),
                command: None,
            })
        );
        assert_eq!(
            to_wire(parsed(&["term", "api", "--", "pnpm", "dev"]), &dir),
            Ok(Command::Term {
                directory: text(&dir.join("api")),
                command: Some(String::from("pnpm dev")),
            })
        );
        assert_eq!(
            to_wire(parsed(&["chat", "--agent", "codex"]), &dir),
            Ok(Command::Chat {
                agent: Some(String::from("codex")),
                directory: text(&dir),
            })
        );
        let missing = to_wire(parsed(&["chat", "nope"]), &dir).unwrap_err();
        assert!(missing.ends_with("is not a directory"), "{missing}");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn title_badge_and_panes_need_no_files() {
        let cwd = Path::new("/");
        assert_eq!(
            to_wire(parsed(&["title", "--clear"]), cwd),
            Ok(Command::Title { title: None })
        );
        assert_eq!(
            to_wire(parsed(&["badge", "!", "--color", "#ff8800"]), cwd),
            Ok(Command::Badge {
                badge: Some(Badge {
                    text: String::from("!"),
                    color: Some(String::from("#ff8800")),
                }),
            })
        );
        assert_eq!(to_wire(parsed(&["panes"]), cwd), Ok(Command::Panes));
    }

    #[test]
    fn layout_tells_names_from_paths() {
        let dir = temp_dir("layout");
        fs::write(dir.join("review.toml"), "name = \"review\"").unwrap();

        assert_eq!(
            to_wire(parsed(&["layout", "review"]), &dir),
            Ok(Command::Layout {
                target: LayoutTarget::Name(String::from("review")),
            })
        );
        assert_eq!(
            to_wire(parsed(&["layout", "review.toml"]), &dir),
            Ok(Command::Layout {
                target: LayoutTarget::Path(text(&dir.join("review.toml"))),
            })
        );
        let missing = to_wire(parsed(&["layout", "./nope"]), &dir).unwrap_err();
        assert!(missing.starts_with("no such layout file: "), "{missing}");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn outside_the_app_every_command_fails_the_same_way() {
        let caller = Caller {
            socket: None,
            window: None,
            pane: None,
            cwd: Some(PathBuf::from("/")),
        };
        for line in [
            &["view", "/definitely/not/here"][..],
            &["panes"],
            &["title", "x"],
        ] {
            assert_eq!(
                execute(parsed(line), &caller).unwrap_err(),
                "kd only works inside a pane of the app (DESKTOP_SOCKET is not set)"
            );
        }
    }

    #[test]
    fn a_pane_id_is_required() {
        let caller = Caller {
            socket: Some(String::from("/nonexistent/s.sock")),
            window: Some(String::from("window-1")),
            pane: None,
            cwd: Some(PathBuf::from("/")),
        };
        let error = execute(parsed(&["panes"]), &caller).unwrap_err();
        assert!(error.contains("DESKTOP_PANE_ID"), "{error}");
    }

    #[test]
    fn a_command_line_travels_to_the_app_and_its_answer_is_printed() {
        let dir = temp_dir("exec");
        let socket = dir.join("s.sock");
        let seen = Arc::new(Mutex::new(Vec::<Request>::new()));
        let record = Arc::clone(&seen);
        socket::serve(UnixListener::bind(&socket).unwrap(), move |request| {
            let reply = match &request.command {
                Command::Panes => Response::ok_with(json!({"tabs": []})),
                Command::Layout { .. } => Response::err("not valid TOML"),
                _ => Response::ok(),
            };
            record.lock().unwrap().push(request);
            reply
        })
        .unwrap();
        let caller = Caller {
            socket: Some(text(&socket)),
            window: Some(String::from("window-2")),
            pane: Some(String::from("p7")),
            cwd: Some(dir.clone()),
        };

        assert_eq!(execute(parsed(&["title", "build"]), &caller), Ok(None));
        assert_eq!(
            execute(parsed(&["panes"]), &caller),
            Ok(Some(String::from("{\n  \"tabs\": []\n}")))
        );
        assert_eq!(
            execute(parsed(&["layout", "review"]), &caller),
            Err(String::from("not valid TOML"))
        );
        assert_eq!(
            seen.lock().unwrap().first(),
            Some(&Request {
                window: String::from("window-2"),
                pane: String::from("p7"),
                command: Command::Title {
                    title: Some(String::from("build")),
                },
            })
        );

        fs::remove_file(&socket).unwrap();
        let gone = execute(parsed(&["panes"]), &caller).unwrap_err();
        assert!(gone.starts_with("could not reach the app at "), "{gone}");
        fs::remove_dir_all(dir).unwrap();
    }
}
