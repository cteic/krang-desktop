//! Lets a program inside a pane drive the app.
//!
//! The app binary doubles as a small command-line tool. Run as the tool, it
//! writes one request to a Unix socket and prints the answer. Run as the app,
//! it listens on that socket and passes each request to the window it names.
//! The window's page decides what the request means and answers through
//! `ipc_reply`.

mod args;
mod cli;
mod paths;
mod pending;
mod protocol;
mod socket;
mod vault;

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use crate::links::resolve_layout;
use pending::Pending;
use protocol::{page_command, LayoutFile, LayoutTarget, PageRequest, Request, Response};

/// The event a window's page listens for.
const REQUEST_EVENT: &str = "ipc-request";
/// How long a connection waits for the page to answer.
const REPLY_TIMEOUT: Duration = Duration::from_secs(2);
const IPC_SUBDIR: &str = "ipc";
const FALLBACK_SUBDIR: &str = "desktop-ipc";
const MAX_LAYOUT_BYTES: u64 = 1024 * 1024;
// The same two directories `windows.rs` searches for a layout by name.
const LAYOUT_SUBDIR: &str = "layouts";
const COMPATIBLE_LAYOUT_DIR: &str = ".warp/tab_configs";

struct Tool {
    dir: PathBuf,
    link: PathBuf,
}

struct Running {
    socket: PathBuf,
    /// Missing when the link could not be made. Panes then get the socket
    /// but no tool to reach it with.
    tool: Option<Tool>,
}

static RUNNING: OnceLock<Running> = OnceLock::new();
static PENDING: LazyLock<Pending> = LazyLock::new(Pending::default);

fn layout_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(config) = app.path().app_config_dir() {
        dirs.push(config.join(LAYOUT_SUBDIR));
    }
    if let Ok(home) = app.path().home_dir() {
        dirs.push(home.join(COMPATIBLE_LAYOUT_DIR));
    }
    dirs
}

/// Finds and reads a layout file. Parsing it is the page's job.
fn read_layout(target: &LayoutTarget, dirs: &[PathBuf]) -> Result<LayoutFile, String> {
    let path = match target {
        LayoutTarget::Path(path) => PathBuf::from(path),
        LayoutTarget::Name(name) => resolve_layout(name, dirs).ok_or_else(|| {
            let searched: Vec<String> = dirs
                .iter()
                .map(|dir| dir.to_string_lossy().into_owned())
                .collect();
            format!("no layout named \"{name}\" in {}", searched.join(" or "))
        })?,
    };
    let shown = path.to_string_lossy().into_owned();
    let size = fs::metadata(&path)
        .map_err(|error| format!("could not read {shown}: {error}"))?
        .len();
    if size > MAX_LAYOUT_BYTES {
        return Err(format!("{shown} is larger than 1 MB, too big for a layout"));
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("could not read {shown}: {error}"))?;
    Ok(LayoutFile { path: shown, text })
}

/// Passes one request to its window's page and waits for the page's answer.
fn forward(app: &AppHandle, request: Request) -> Response {
    if app.get_webview_window(&request.window).is_none() {
        return Response::err(format!("no window named {}", request.window));
    }
    let command = match page_command(&request.command, |target| {
        read_layout(target, &layout_dirs(app))
    }) {
        Ok(command) => command,
        Err(error) => return Response::err(error),
    };
    let (request_id, answer) = match PENDING.register() {
        Ok(registered) => registered,
        Err(error) => return Response::err(error),
    };
    let payload = PageRequest {
        request_id: request_id.clone(),
        pane: request.pane,
        command,
    };
    if let Err(error) = app.emit_to(request.window.as_str(), REQUEST_EVENT, payload) {
        PENDING.forget(&request_id);
        return Response::err(format!(
            "could not reach window {}: {error}",
            request.window
        ));
    }
    match answer.recv_timeout(REPLY_TIMEOUT) {
        Ok(reply) => serde_json::from_value(reply).unwrap_or_else(|error| {
            Response::err(format!(
                "the window sent an answer the app could not read: {error}"
            ))
        }),
        Err(_) => {
            PENDING.forget(&request_id);
            Response::err(format!(
                "window {} did not answer within {} seconds",
                request.window,
                REPLY_TIMEOUT.as_secs()
            ))
        }
    }
}

/// A window's page answers a request it was sent. The payload has the shape
/// of a reply to the tool: `{ ok, error?, data? }`.
#[tauri::command]
pub fn ipc_reply(request_id: String, payload: Value) -> Result<(), String> {
    PENDING.complete(&request_id, payload)
}

fn make_tool(base: &Path) -> io::Result<Tool> {
    let dir = paths::tool_dir_in(base);
    paths::make_private_dir(&dir)?;
    let link = dir.join(paths::TOOL_NAME);
    paths::refresh_link(&link, &std::env::current_exe()?)?;
    Ok(Tool { dir, link })
}

fn listen(app: &AppHandle) -> Result<Running, String> {
    let mut candidates = Vec::new();
    if let Ok(cache) = app.path().app_cache_dir() {
        candidates.push(cache.join(IPC_SUBDIR));
    }
    candidates.push(std::env::temp_dir().join(FALLBACK_SUBDIR));
    let base = paths::choose_base(candidates)
        .ok_or_else(|| String::from("no directory gives a socket path short enough to bind"))?;
    paths::make_private_dir(&base)
        .map_err(|error| format!("could not prepare {}: {error}", base.display()))?;

    let socket = paths::socket_in(&base);
    // A socket that still answers belongs to a running copy of the app.
    // Taking it over would cut that copy's panes off.
    if UnixStream::connect(&socket).is_ok() {
        return Err(format!(
            "another running copy of the app already answers on {}",
            socket.display()
        ));
    }
    match fs::remove_file(&socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            return Err(format!(
                "could not remove the stale socket {}: {error}",
                socket.display()
            ));
        }
        _ => {}
    }
    let listener = UnixListener::bind(&socket)
        .map_err(|error| format!("could not listen on {}: {error}", socket.display()))?;
    if let Err(error) = fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)) {
        eprintln!("pane tool: could not restrict the socket: {error}");
    }

    let tool = match make_tool(&base) {
        Ok(tool) => Some(tool),
        Err(error) => {
            eprintln!("pane tool: could not link the tool: {error}");
            None
        }
    };

    let handle = app.clone();
    socket::serve(listener, move |request| forward(&handle, request))
        .map_err(|error| format!("could not start the socket thread: {error}"))?;
    Ok(Running { socket, tool })
}

/// Removes the socket when the app exits. The app's run loop belongs to
/// `lib.rs`, so this watches for the exit event as a plugin instead.
fn remove_socket_on_exit(app: &AppHandle) {
    let plugin = tauri::plugin::Builder::<tauri::Wry>::new("pane-socket")
        .on_event(|_app, event| {
            if let RunEvent::Exit = event {
                if let Some(running) = RUNNING.get() {
                    let _ = fs::remove_file(&running.socket);
                }
            }
        })
        .build();
    let app = app.clone();
    // Registered from its own thread: setup runs inside the event loop, and
    // the plugin table may be in use there.
    let spawned = thread::Builder::new()
        .name(String::from("pane-socket-cleanup"))
        .spawn(move || {
            if let Err(error) = app.plugin(plugin) {
                eprintln!("pane tool: the socket will outlive the app: {error}");
            }
        });
    if let Err(error) = spawned {
        eprintln!("pane tool: the socket will outlive the app: {error}");
    }
}

/// Starts whatever lets a program inside a pane talk to the app.
pub fn start(app: &AppHandle) {
    if RUNNING.get().is_some() {
        return;
    }
    match listen(app) {
        Ok(running) => {
            if RUNNING.set(running).is_ok() {
                remove_socket_on_exit(app);
            }
        }
        Err(error) => eprintln!("pane tool is unavailable: {error}"),
    }
}

/// Extra environment for a pane's shell, such as where to reach the app.
pub fn pane_env() -> Vec<(String, String)> {
    let Some(running) = RUNNING.get() else {
        return Vec::new();
    };
    let mut env = vec![(
        String::from(cli::SOCKET_ENV),
        running.socket.to_string_lossy().into_owned(),
    )];
    if let Some(tool) = &running.tool {
        env.push((
            String::from(cli::CLI_ENV),
            tool.link.to_string_lossy().into_owned(),
        ));
        let inherited = std::env::var("PATH").ok();
        env.push((
            String::from("PATH"),
            paths::pane_path(&tool.dir, inherited.as_deref()),
        ));
        env.extend(zsh_wrapper_env(tool));
    }
    env
}

/// For zsh, the settings that keep the tool on PATH whatever the person's
/// startup files do to it. Other shells get the plain PATH entry only.
fn zsh_wrapper_env(tool: &Tool) -> Vec<(String, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| String::from("/bin/zsh"));
    if !crate::shell_env::is_zsh(&shell) {
        return Vec::new();
    }
    let Some(base) = tool.dir.parent() else {
        return Vec::new();
    };
    let zsh_dir = base.join("zsh");
    if let Err(error) = crate::shell_env::write_zsh_dir(&zsh_dir) {
        eprintln!("could not write the zsh startup files: {error}");
        return Vec::new();
    }
    crate::shell_env::zsh_env(
        &zsh_dir,
        &tool.dir,
        std::env::var("ZDOTDIR").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// The tool's own arguments, when the command line asks for the tool: the
/// binary was run under the tool's name, or its first argument is `ctl`.
fn tool_args(args: &[String]) -> Option<&[String]> {
    let (program, rest) = args.split_first()?;
    if Path::new(program).file_name() == Some(OsStr::new(paths::TOOL_NAME)) {
        return Some(rest);
    }
    match rest.split_first() {
        Some((first, rest)) if first == "ctl" => Some(rest),
        _ => None,
    }
}

/// Runs the command-line side when the binary was started as that tool
/// rather than as the app. Returns the exit code, or `None` to start the app.
pub fn run_cli<I>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = args.into_iter().collect();
    tool_args(&args).map(cli::run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use socket::test_support::temp_dir;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn the_tool_runs_under_its_own_name_or_after_ctl() {
        let cases = [
            (strings(&["kd", "panes"]), Some(strings(&["panes"]))),
            (
                strings(&["/cache/ipc/bin/kd", "title", "x"]),
                Some(strings(&["title", "x"])),
            ),
            (strings(&["kd"]), Some(Vec::new())),
            (
                strings(&["/app/desktop", "ctl", "view", "a"]),
                Some(strings(&["view", "a"])),
            ),
            (strings(&["/app/desktop", "ctl"]), Some(Vec::new())),
        ];
        for (args, expected) in cases {
            assert_eq!(tool_args(&args).map(<[String]>::to_vec), expected);
        }
    }

    #[test]
    fn any_other_command_line_starts_the_app() {
        for args in [
            strings(&[]),
            strings(&["/app/desktop"]),
            strings(&["/app/desktop", "--layout", "ctl"]),
            strings(&["/app/desktop", "--layout=/tmp/a.toml"]),
            strings(&["/app/kdx", "panes"]),
            strings(&["/kd/desktop", "panes"]),
        ] {
            assert_eq!(tool_args(&args), None);
            assert_eq!(run_cli(args), None);
        }
    }

    #[test]
    fn the_tool_exits_with_a_code_and_never_starts_the_app() {
        assert_eq!(run_cli(strings(&["kd", "--help"])), Some(0));
        assert_eq!(
            run_cli(strings(&["/app/desktop", "ctl", "--help"])),
            Some(0)
        );
        assert_eq!(run_cli(strings(&["kd", "explode"])), Some(2));
        assert_eq!(run_cli(strings(&["/app/desktop", "ctl"])), Some(2));
    }

    #[test]
    fn a_layout_is_found_by_name_or_read_by_path() {
        let base = temp_dir("layouts");
        let first = base.join("first");
        let second = base.join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("review.toml"), "name = \"review\"").unwrap();
        let dirs = vec![first.clone(), second.clone()];
        let path = second.join("review.toml").to_string_lossy().into_owned();

        let by_name = read_layout(&LayoutTarget::Name(String::from("review")), &dirs).unwrap();
        assert_eq!(by_name.path, path);
        assert_eq!(by_name.text, "name = \"review\"");
        let by_path = read_layout(&LayoutTarget::Path(path.clone()), &[]).unwrap();
        assert_eq!(by_path, by_name);

        let missing = read_layout(&LayoutTarget::Name(String::from("nope")), &dirs).unwrap_err();
        assert_eq!(
            missing,
            format!(
                "no layout named \"nope\" in {} or {}",
                first.display(),
                second.display()
            )
        );
        let unsafe_name = read_layout(&LayoutTarget::Name(String::from("../second/review")), &dirs);
        assert!(unsafe_name.is_err());
        let unreadable = read_layout(
            &LayoutTarget::Path(String::from("/definitely/not/here.toml")),
            &dirs,
        )
        .unwrap_err();
        assert!(unreadable.starts_with("could not read /definitely/not/here.toml: "));

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn nothing_is_added_to_a_pane_before_the_socket_is_up() {
        assert!(pane_env().is_empty());
    }
}
