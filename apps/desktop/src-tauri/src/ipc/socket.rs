//! The socket layer: one request per connection, one line each way.
//!
//! Nothing here knows about windows. The server hands each decoded request
//! to a handler and writes back whatever it returns.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use super::protocol::{decode_request, decode_response, encode_line, Request, Response};

/// The longest request line the server reads, newline included.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// How long the server waits for a client to finish its line.
const SERVER_READ_TIMEOUT: Duration = Duration::from_secs(5);
const SERVER_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Longer than any wait the server does on the tool's behalf.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);
/// A pause after a failed accept, so a lasting failure cannot spin a core.
const ACCEPT_RETRY: Duration = Duration::from_millis(50);

enum Line {
    Complete(Vec<u8>),
    TooLong,
}

/// Reads up to the first newline, and no more than `MAX_LINE_BYTES`.
fn read_line(stream: &UnixStream) -> io::Result<Line> {
    let mut line = Vec::new();
    let limit = u64::try_from(MAX_LINE_BYTES).unwrap_or(u64::MAX);
    let mut reader = BufReader::new(stream.take(limit.saturating_add(1)));
    reader.read_until(b'\n', &mut line)?;
    if line.len() > MAX_LINE_BYTES {
        return Ok(Line::TooLong);
    }
    Ok(Line::Complete(line))
}

fn answer<H>(stream: &UnixStream, handler: &H) -> Response
where
    H: Fn(Request) -> Response,
{
    match read_line(stream) {
        Err(error) => Response::err(format!("could not read the request: {error}")),
        Ok(Line::TooLong) => Response::err("request is larger than 1 MB"),
        Ok(Line::Complete(line)) => match decode_request(&line) {
            Ok(request) => handler(request),
            Err(error) => Response::err(error),
        },
    }
}

fn handle_connection<H>(mut stream: UnixStream, handler: &H)
where
    H: Fn(Request) -> Response,
{
    // Without these a client that connects and says nothing would hold its
    // thread for ever.
    let _ = stream.set_read_timeout(Some(SERVER_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SERVER_WRITE_TIMEOUT));
    let response = answer(&stream, handler);
    match encode_line(&response) {
        // A client that has gone away is not worth reporting.
        Ok(line) => {
            let _ = stream.write_all(&line).and_then(|()| stream.flush());
        }
        Err(error) => eprintln!("pane socket: {error}"),
    }
}

/// Answers connections on `listener` for as long as the process lives. Each
/// connection gets its own thread, so a slow client never holds up the next.
pub fn serve<H>(listener: UnixListener, handler: H) -> io::Result<()>
where
    H: Fn(Request) -> Response + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    thread::Builder::new()
        .name(String::from("pane-socket"))
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let handler = Arc::clone(&handler);
                        let spawned = thread::Builder::new()
                            .name(String::from("pane-socket-client"))
                            .spawn(move || handle_connection(stream, handler.as_ref()));
                        if let Err(error) = spawned {
                            eprintln!("pane socket: could not start a thread: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("pane socket: accept failed: {error}");
                        thread::sleep(ACCEPT_RETRY);
                    }
                }
            }
        })?;
    Ok(())
}

/// Writes one line and reads one line back.
pub fn send_line(socket: &Path, line: &[u8]) -> io::Result<Vec<u8>> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(CLIENT_TIMEOUT))?;
    stream.set_write_timeout(Some(CLIENT_TIMEOUT))?;
    // The server may answer and hang up before it has read everything, when
    // the line is too long. Its answer is still there to read, so a failed
    // write is only reported if no answer follows.
    let written = stream.write_all(line).and_then(|()| stream.flush());
    let mut reply = Vec::new();
    let read = BufReader::new(&stream).read_until(b'\n', &mut reply);
    match (written, read) {
        (_, Ok(count)) if count > 0 => Ok(reply),
        (Err(error), _) | (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(_)) => Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the app closed the connection without answering",
        )),
    }
}

/// Sends one request to the app and returns its answer.
pub fn send(socket: &Path, request: &Request) -> Result<Response, String> {
    let line = encode_line(request)?;
    if line.len() > MAX_LINE_BYTES {
        return Err(String::from("request is larger than 1 MB"));
    }
    let reply = send_line(socket, &line)
        .map_err(|error| format!("could not reach the app at {}: {error}", socket.display()))?;
    decode_response(&reply)
}

#[cfg(test)]
pub mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT: AtomicU32 = AtomicU32::new(0);

    /// A fresh directory with a short path, so a socket inside it fits.
    pub fn temp_dir(tag: &str) -> PathBuf {
        let number = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("pane-{tag}-{}-{number}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::temp_dir;
    use super::*;
    use crate::ipc::protocol::Command;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Instant;

    fn start<H>(tag: &str, handler: H) -> (PathBuf, PathBuf)
    where
        H: Fn(Request) -> Response + Send + Sync + 'static,
    {
        let dir = temp_dir(tag);
        let socket = dir.join("s.sock");
        serve(UnixListener::bind(&socket).unwrap(), handler).unwrap();
        (dir, socket)
    }

    fn panes_request() -> Request {
        Request {
            window: String::from("window-1"),
            pane: String::from("p3"),
            command: Command::Panes,
        }
    }

    #[test]
    fn a_request_reaches_the_handler_and_its_answer_comes_back() {
        let (dir, socket) = start("round", |request| {
            Response::ok_with(json!({
                "window": request.window,
                "pane": request.pane,
                "command": request.command,
            }))
        });

        let response = send(&socket, &panes_request()).unwrap();
        assert_eq!(
            response,
            Response::ok_with(json!({
                "window": "window-1",
                "pane": "p3",
                "command": {"name": "panes"},
            }))
        );

        let refused = start("refuse", |_| Response::err("no window named window-1"));
        assert_eq!(
            send(&refused.1, &panes_request()).unwrap(),
            Response::err("no window named window-1")
        );

        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(refused.0).unwrap();
    }

    #[test]
    fn an_oversized_line_is_refused_without_reaching_the_handler() {
        let (dir, socket) = start("big", |_| panic!("the handler must not see this"));

        let mut line = vec![b'x'; MAX_LINE_BYTES + 4096];
        line.push(b'\n');
        let reply = send_line(&socket, &line).unwrap();
        assert_eq!(
            decode_response(&reply).unwrap(),
            Response::err("request is larger than 1 MB")
        );

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_client_refuses_to_send_an_oversized_request() {
        let request = Request {
            window: String::from("window-1"),
            pane: String::from("p3"),
            command: Command::Title {
                title: Some("x".repeat(MAX_LINE_BYTES)),
            },
        };
        let error = send(Path::new("/nonexistent/s.sock"), &request).unwrap_err();
        assert_eq!(error, "request is larger than 1 MB");
    }

    #[test]
    fn malformed_json_gets_an_error_reply() {
        let (dir, socket) = start("bad", |_| panic!("the handler must not see this"));

        for line in [&b"this is not json\n"[..], b"{\"window\":\"w\"}\n", b"\n"] {
            let reply = decode_response(&send_line(&socket, line).unwrap()).unwrap();
            assert!(!reply.ok);
            let error = reply.error.unwrap();
            assert!(error.starts_with("malformed request: "), "{error}");
        }

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_socket_is_a_connection_error() {
        let dir = temp_dir("gone");
        let socket = dir.join("s.sock");
        let error = send(&socket, &panes_request()).unwrap_err();
        assert!(error.starts_with("could not reach the app at "), "{error}");
        assert!(error.contains("No such file or directory"), "{error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_slow_request_does_not_block_the_next_one() {
        let (release, gate) = mpsc::channel::<()>();
        let gate = std::sync::Mutex::new(gate);
        let (dir, socket) = start("slow", move |request| {
            if request.pane == "slow" {
                let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(5));
            }
            Response::ok()
        });

        let slow_socket = socket.clone();
        let slow = thread::spawn(move || {
            let mut request = panes_request();
            request.pane = String::from("slow");
            send(&slow_socket, &request)
        });
        // A client that connects and never writes must not block either.
        let silent = UnixStream::connect(&socket).unwrap();

        let started = Instant::now();
        assert_eq!(send(&socket, &panes_request()).unwrap(), Response::ok());
        assert!(started.elapsed() < Duration::from_secs(2));

        release.send(()).unwrap();
        assert_eq!(slow.join().unwrap().unwrap(), Response::ok());
        drop(silent);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
