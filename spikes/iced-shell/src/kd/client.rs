//! The asking side of the socket: one request, one answer.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use super::protocol::{MAX_LINE_BYTES, Request, Response, decode_response, encode};

/// Longer than any wait the app does on the tool's behalf.
const TIMEOUT: Duration = Duration::from_secs(10);

/// Sends raw bytes and returns the answer line. The tests use it to send
/// what `kd` itself never would.
pub fn send(socket: &Path, line: &[u8]) -> Result<Response, String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|error| format!("could not reach the app at {}: {error}", socket.display()))?;
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    stream
        .write_all(line)
        .and_then(|()| stream.flush())
        // One request goes over a connection, so the sending half closes
        // and the app never waits for more.
        .and_then(|()| stream.shutdown(std::net::Shutdown::Write))
        .map_err(|error| format!("could not send the request: {error}"))?;
    let mut answer = Vec::new();
    BufReader::new(stream.take(MAX_LINE_BYTES as u64))
        .read_until(b'\n', &mut answer)
        .map_err(|error| format!("the app did not answer: {error}"))?;
    if answer.is_empty() {
        return Err(String::from(
            "the app closed the connection without an answer",
        ));
    }
    decode_response(&answer)
}

pub fn call(socket: &Path, request: &Request) -> Result<Response, String> {
    send(socket, &encode(request)?)
}
