//! The answering side: a socket only its owner can reach, a secret for
//! each pane, and a loop that hands each request that carries the right
//! secret to the app.
//!
//! Nothing here knows about windows. The loop takes a handler, so the tests
//! run it against a stand-in for the app.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::protocol::{MAX_LINE_BYTES, Request, Response, decode_request, encode};

/// How long the app waits for a client to finish its line. Without it a
/// client that connects and says nothing would hold a thread for ever.
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// A pause after a failed accept, so a lasting failure cannot spin a core.
const ACCEPT_RETRY: Duration = Duration::from_millis(200);
/// Connections answered at once. More than this are told to try again.
const MAX_CONNECTIONS: usize = 16;
/// The longest path a Unix socket takes on macOS, less its ending zero.
const MAX_SOCKET_PATH: usize = 103;
const TOKEN_BYTES: usize = 32;

/// A secret no other process can guess, as hex. It comes from the system's
/// random source; there is no fallback, because a weak secret is worse
/// than no pane tool.
pub fn random_token() -> io::Result<String> {
    let mut bytes = [0_u8; TOKEN_BYTES];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Compares two secrets in time that does not depend on where they differ.
fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0_u8, |seen, (x, y)| seen | (x ^ y)) == 0
}

/// The secret of each pane that may use the tool.
#[derive(Debug, Clone, Default)]
pub struct Tokens {
    by_pane: Arc<Mutex<HashMap<u64, String>>>,
}

impl Tokens {
    /// Makes a pane's secret, replacing one it had.
    pub fn issue(&self, pane: u64) -> io::Result<String> {
        let token = random_token()?;
        let mut by_pane = self
            .by_pane
            .lock()
            .map_err(|_| io::Error::other("the pane secrets are poisoned"))?;
        by_pane.insert(pane, token.clone());
        Ok(token)
    }

    /// Forgets a pane's secret, when the pane closes.
    pub fn revoke(&self, pane: u64) {
        if let Ok(mut by_pane) = self.by_pane.lock() {
            by_pane.remove(&pane);
        }
    }

    pub fn allows(&self, pane: u64, token: &str) -> bool {
        self.by_pane
            .lock()
            .ok()
            .and_then(|by_pane| by_pane.get(&pane).map(|known| same(known, token)))
            .unwrap_or(false)
    }
}

fn user_id() -> u32 {
    // SAFETY: geteuid has no arguments and cannot fail.
    unsafe { libc::geteuid() }
}

/// Makes a directory that only its owner can enter, and checks that it is
/// one: a real directory, ours, closed to everyone else. A folder under a
/// shared temporary folder could have been made by someone else first.
fn private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let found = std::fs::symlink_metadata(dir)?;
    if !found.is_dir() || found.uid() != user_id() {
        return Err(io::Error::other(format!(
            "{} is not a directory of this user",
            dir.display()
        )));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Where the socket goes: the runtime directory where the system gives
/// one, or else the app's own folder, or else the temporary folder when
/// the path would be too long for a socket.
pub fn socket_dir(state_dir: Option<&Path>) -> PathBuf {
    let fits = |dir: &PathBuf| dir.as_os_str().len() + "/kd-4194304.sock".len() <= MAX_SOCKET_PATH;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join("krang-shell"));
    let state = state_dir.map(|dir| dir.join("run"));
    runtime
        .into_iter()
        .chain(state)
        .find(fits)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("krang-shell-{}", user_id())))
}

fn is_running(process: u32) -> bool {
    let Ok(process) = libc::pid_t::try_from(process) else {
        return false;
    };
    // SAFETY: signal 0 sends nothing; it only asks whether the process
    // exists. A process of another user answers EPERM, and exists.
    let status = unsafe { libc::kill(process, 0) };
    status == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The process a socket or a tool folder in the directory belongs to.
fn owner_of(name: &str) -> Option<u32> {
    name.strip_prefix("kd-")
        .and_then(|rest| rest.strip_suffix(".sock"))
        .or_else(|| name.strip_prefix("bin-"))
        .and_then(|process| process.parse().ok())
}

/// Removes what processes that are gone left behind: a crash never runs
/// the clean-up, and the directory would fill with dead sockets.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stale = owner_of(&name)
            .is_some_and(|process| process != std::process::id() && !is_running(process));
        if stale {
            let path = entry.path();
            let _ = std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir_all(&path));
        }
    }
}

/// The folder this process keeps its `kd` link in.
pub fn tool_dir(dir: &Path) -> PathBuf {
    dir.join(format!("bin-{}", std::process::id()))
}

/// Opens this process's socket in a private directory. The socket itself
/// is readable and writable by its owner alone.
pub fn bind(dir: &Path) -> io::Result<(UnixListener, PathBuf)> {
    private_dir(dir)?;
    sweep(dir);
    let socket = dir.join(format!("kd-{}.sock", std::process::id()));
    // A socket left by an earlier process that had this id.
    match std::fs::remove_file(&socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, socket))
}

/// Puts `kd` in a directory as a link to a program, and returns the link.
pub fn link_tool(dir: &Path, program: &Path) -> io::Result<PathBuf> {
    private_dir(dir)?;
    let link = dir.join("kd");
    match std::fs::remove_file(&link) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    std::os::unix::fs::symlink(program, &link)?;
    Ok(link)
}

/// Whether the process at the other end runs as this user. The socket's
/// permissions already keep others out; this holds if they are ever wrong.
fn peer_is_owner(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    // SAFETY: the descriptor is open for the life of `stream`, and the two
    // pointers are to live locals of the types getpeereid writes.
    let read = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } == 0;
    #[cfg(not(any(target_os = "macos", target_os = "freebsd")))]
    let read = {
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: the descriptor is open for the life of `stream`, and the
        // buffer is a live ucred of the size passed.
        let status = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&raw mut credentials).cast(),
                &mut size,
            )
        };
        (uid, gid) = (credentials.uid, credentials.gid);
        status == 0
    };
    let _ = gid;
    read && uid == user_id()
}

enum Line {
    Complete(Vec<u8>),
    TooLong,
}

/// Reads up to the first newline, and no more than `MAX_LINE_BYTES`.
fn read_line(stream: &UnixStream) -> io::Result<Line> {
    let mut line = Vec::new();
    let limit = MAX_LINE_BYTES as u64;
    BufReader::new(stream.take(limit + 1)).read_until(b'\n', &mut line)?;
    Ok(if line.len() > MAX_LINE_BYTES {
        Line::TooLong
    } else {
        Line::Complete(line)
    })
}

fn answer<H>(stream: &UnixStream, tokens: &Tokens, handler: &H) -> Response
where
    H: Fn(Request) -> Response,
{
    if !peer_is_owner(stream) {
        return Response::err("the request came from another user");
    }
    let line = match read_line(stream) {
        Err(error) => return Response::err(format!("could not read the request: {error}")),
        Ok(Line::TooLong) => return Response::err("the request is larger than 64 KiB"),
        Ok(Line::Complete(line)) => line,
    };
    let request = match decode_request(&line) {
        Ok(request) => request,
        Err(error) => return Response::err(error),
    };
    // One message for a pane that is unknown and for a secret that is
    // wrong, so the answer does not say which panes exist.
    if !tokens.allows(request.pane, &request.token) {
        return Response::err("the request does not carry this pane's secret");
    }
    handler(request)
}

fn handle<H>(mut stream: UnixStream, tokens: &Tokens, handler: &H)
where
    H: Fn(Request) -> Response,
{
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let response = answer(&stream, tokens, handler);
    let line = encode(&response)
        .or_else(|error| encode(&Response::err(error)))
        .unwrap_or_default();
    // A client that has gone away is not worth reporting.
    let _ = stream.write_all(&line).and_then(|()| stream.flush());
}

/// Answers connections for as long as the process lives. It blocks in
/// `accept`, so it costs nothing while nobody asks. Each connection gets
/// its own thread, so a slow client never holds up the next.
pub fn serve<H>(listener: UnixListener, tokens: Tokens, handler: H)
where
    H: Fn(Request) -> Response + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    let open = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(_) => {
                std::thread::sleep(ACCEPT_RETRY);
                continue;
            }
        };
        if open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::SeqCst);
            handle(stream, &tokens, &|_| {
                Response::err("the app is busy, try again")
            });
            continue;
        }
        // The place is given back when the thread ends, and also when the
        // thread could not start and its closure is dropped unrun.
        let slot = Slot(Arc::clone(&open));
        let (tokens, handler) = (tokens.clone(), Arc::clone(&handler));
        let _ = std::thread::Builder::new()
            .name(String::from("kd"))
            .spawn(move || {
                let _slot = slot;
                handle(stream, &tokens, handler.as_ref());
            });
    }
}

/// One of the connections answered at once.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kd::client;
    use crate::kd::protocol::{Command, PaneInfo, Panes, TabInfo, VERSION, pane_name};

    /// What stands in for the app: panes with titles.
    #[derive(Default)]
    struct FakeApp {
        titles: HashMap<u64, Option<String>>,
        opened: Vec<String>,
    }

    impl FakeApp {
        fn handle(&mut self, request: Request) -> Response {
            match request.command {
                Command::Title { text } => {
                    self.titles.insert(request.pane, text);
                    Response::done()
                }
                Command::View { path, down } => {
                    self.opened.push(format!("view {path} {down}"));
                    Response::done()
                }
                Command::Panes => {
                    let mut ids: Vec<u64> = self.titles.keys().copied().collect();
                    ids.sort_unstable();
                    let panes = Panes {
                        tabs: vec![TabInfo {
                            title: String::from("shell"),
                            active: true,
                            panes: ids
                                .into_iter()
                                .map(|id| PaneInfo {
                                    id: pane_name(id),
                                    title: self.titles[&id].clone().unwrap_or_default(),
                                    kind: String::from("terminal"),
                                    focused: id == request.pane,
                                })
                                .collect(),
                        }],
                    };
                    serde_json::to_value(panes)
                        .map_or_else(|_| Response::err("json"), Response::data)
                }
                _ => Response::err("not built in the stand-in"),
            }
        }
    }

    struct Running {
        dir: PathBuf,
        socket: PathBuf,
        tokens: Tokens,
        app: Arc<Mutex<FakeApp>>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Starts the real loop on a socket in a scratch directory.
    fn start(name: &str) -> Running {
        let dir = std::env::temp_dir().join(format!("krang-kd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (listener, socket) = match bind(&dir) {
            Ok(bound) => bound,
            Err(error) => panic!("could not open a socket in {}: {error}", dir.display()),
        };
        let tokens = Tokens::default();
        let app = Arc::new(Mutex::new(FakeApp::default()));
        let (serving, shared) = (tokens.clone(), Arc::clone(&app));
        std::thread::spawn(move || {
            serve(listener, serving, move |request| match shared.lock() {
                Ok(mut app) => app.handle(request),
                Err(_) => Response::err("poisoned"),
            });
        });
        Running {
            dir,
            socket,
            tokens,
            app,
        }
    }

    fn pane(running: &Running, id: u64) -> String {
        if let Ok(mut app) = running.app.lock() {
            app.titles.insert(id, None);
        }
        running.tokens.issue(id).unwrap_or_default()
    }

    fn ask(
        running: &Running,
        pane: u64,
        token: &str,
        command: Command,
    ) -> Result<Response, String> {
        client::call(
            &running.socket,
            &Request {
                v: VERSION,
                pane,
                token: token.to_string(),
                command,
            },
        )
    }

    #[test]
    fn a_pane_with_its_secret_drives_the_app() {
        let running = start("drive");
        let token = pane(&running, 3);
        let other = pane(&running, 4);
        assert_ne!(token, other);
        let title = Command::Title {
            text: Some(String::from("api tests")),
        };
        assert_eq!(ask(&running, 3, &token, title), Ok(Response::done()));
        let view = Command::View {
            path: String::from("/demo/README.md"),
            down: true,
        };
        assert_eq!(ask(&running, 3, &token, view), Ok(Response::done()));
        let listed = ask(&running, 4, &other, Command::Panes)
            .ok()
            .and_then(|response| response.data)
            .and_then(|data| serde_json::from_value::<Panes>(data).ok());
        let panes = listed
            .map(|panes| panes.tabs[0].panes.clone())
            .unwrap_or_default();
        assert_eq!(
            panes,
            [
                PaneInfo {
                    id: String::from("p3"),
                    title: String::from("api tests"),
                    kind: String::from("terminal"),
                    focused: false
                },
                PaneInfo {
                    id: String::from("p4"),
                    title: String::new(),
                    kind: String::from("terminal"),
                    focused: true
                }
            ]
        );
        let opened = running
            .app
            .lock()
            .map(|app| app.opened.clone())
            .unwrap_or_default();
        assert_eq!(opened, ["view /demo/README.md true"]);
    }

    #[test]
    fn a_request_without_the_panes_secret_never_reaches_the_app() {
        let running = start("secret");
        let token = pane(&running, 3);
        let other = pane(&running, 4);
        let title = || Command::Title {
            text: Some(String::from("taken over")),
        };
        let refused = |response: Result<Response, String>| {
            response.is_ok_and(|response| {
                !response.ok && response.error.is_some_and(|error| error.contains("secret"))
            })
        };
        assert!(refused(ask(&running, 3, "", title())));
        assert!(refused(ask(&running, 3, "guess", title())));
        // Another pane's secret does not speak for this one.
        assert!(refused(ask(&running, 3, &other, title())));
        // A pane the app never made.
        assert!(refused(ask(&running, 99, &token, title())));
        // A prefix of the secret is not the secret.
        assert!(refused(ask(
            &running,
            3,
            &token[..token.len() - 1],
            title()
        )));
        // A closed pane's secret stops working.
        running.tokens.revoke(4);
        assert!(refused(ask(&running, 4, &other, Command::Panes)));
        let titles = running
            .app
            .lock()
            .map(|app| app.titles.clone())
            .unwrap_or_default();
        assert_eq!(titles.get(&3), Some(&None));
        // The right secret still works afterwards.
        assert_eq!(ask(&running, 3, &token, title()), Ok(Response::done()));
    }

    #[test]
    fn junk_gets_an_error_and_the_loop_keeps_going() {
        let running = start("junk");
        let token = pane(&running, 1);
        let failed =
            |line: &[u8]| client::send(&running.socket, line).is_ok_and(|response| !response.ok);
        assert!(failed(b"hello\n"));
        assert!(failed(b"{}\n"));
        assert!(failed(b"\n"));
        assert!(failed(br#"{"v":9,"pane":1,"token":"x","cmd":"panes"}"#));
        let mut huge = vec![b'x'; MAX_LINE_BYTES + 10];
        huge.push(b'\n');
        let answer = client::send(&running.socket, &huge);
        assert!(answer.is_ok_and(|response| {
            response.error.is_some_and(|error| error.contains("64 KiB"))
        }));
        assert_eq!(
            ask(&running, 1, &token, Command::Panes).map(|r| r.ok),
            Ok(true)
        );
    }

    #[test]
    fn the_socket_is_closed_to_everyone_else() {
        let running = start("modes");
        let mode = |path: &Path| {
            std::fs::symlink_metadata(path)
                .map(|found| found.mode() & 0o777)
                .ok()
        };
        assert_eq!(mode(&running.dir), Some(0o700));
        assert_eq!(mode(&running.socket), Some(0o600));
    }

    #[test]
    fn a_directory_that_is_a_link_is_refused() {
        let base = std::env::temp_dir().join(format!("krang-kd-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::create_dir_all(base.join("real"));
        let link = base.join("link");
        assert!(std::os::unix::fs::symlink(base.join("real"), &link).is_ok());
        assert!(bind(&link).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn secrets_are_long_and_differ() {
        let (a, b) = (
            random_token().unwrap_or_default(),
            random_token().unwrap_or_default(),
        );
        assert_eq!(a.len(), TOKEN_BYTES * 2);
        assert_ne!(a, b);
        assert!(same(&a, &a) && !same(&a, &b) && !same(&a, &a[1..]));
    }

    #[test]
    fn the_socket_goes_where_its_path_fits() {
        let short = PathBuf::from("/tmp/state");
        let long = PathBuf::from(format!("/tmp/{}", "x".repeat(120)));
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            assert_eq!(socket_dir(Some(&short)), short.join("run"));
            assert!(socket_dir(Some(&long)).starts_with(std::env::temp_dir()));
            assert!(socket_dir(None).starts_with(std::env::temp_dir()));
        }
    }

    #[test]
    fn what_a_dead_process_left_is_swept_and_the_rest_is_kept() {
        let dir = std::env::temp_dir().join(format!("krang-kd-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(dir.join("bin-4000000"));
        let _ = std::fs::write(dir.join("bin-4000000/kd"), "");
        let _ = std::fs::write(dir.join("kd-4000000.sock"), "");
        let _ = std::fs::write(dir.join("kd-1.sock"), "");
        let _ = std::fs::write(dir.join("notes.txt"), "");
        // No process has an id this high; process 1 always runs.
        assert_eq!(owner_of("kd-4000000.sock"), Some(4_000_000));
        assert_eq!(owner_of("bin-12"), Some(12));
        assert_eq!(owner_of("notes.txt"), None);
        assert!(is_running(1) && !is_running(4_000_000));
        let bound = bind(&dir);
        assert!(bound.is_ok());
        assert!(!dir.join("kd-4000000.sock").exists());
        assert!(!dir.join("bin-4000000").exists());
        assert!(dir.join("kd-1.sock").exists());
        assert!(dir.join("notes.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn kd_is_a_link_to_the_program() {
        let dir = std::env::temp_dir().join(format!("krang-kd-bin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let program = Path::new("/usr/bin/true");
        let link = link_tool(&dir, program).ok();
        assert_eq!(link, Some(dir.join("kd")));
        assert_eq!(
            std::fs::read_link(dir.join("kd")).ok().as_deref(),
            Some(program)
        );
        // Linking again replaces the link.
        assert!(link_tool(&dir, program).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
