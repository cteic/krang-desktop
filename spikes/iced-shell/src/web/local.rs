//! The `localfile` scheme a web pane uses to show a file from disk, served
//! the way the current app serves it: the path keeps its slashes, so a
//! page's relative links to its own styles and images resolve, and each
//! page is sandboxed so its scripts cannot read other files.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use wry::http::{Request, Response, StatusCode};

pub const SCHEME: &str = "localfile";
pub const ORIGIN: &str = "localfile://localhost";

const PAGE_POLICY: &str = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" | "toml" | "yaml" | "yml" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn encode_path(path: &Path) -> String {
    let mut out = String::new();
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' | b'~' => {
                out.push(char::from(byte))
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn url_for(path: &Path) -> Option<String> {
    path.is_absolute()
        .then(|| format!("{ORIGIN}{}", encode_path(path)))
}

pub fn path_of(url: &str) -> Option<PathBuf> {
    let rest = url.strip_prefix(ORIGIN)?;
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    Some(PathBuf::from(crate::vault::markdown::decode(path)))
}

fn respond(status: StatusCode, kind: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Content-Type", kind)
        .header("Content-Security-Policy", PAGE_POLICY)
        .header("X-Content-Type-Options", "nosniff")
        .body(Cow::<'static, [u8]>::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

fn refuse(status: StatusCode, reason: &str) -> Response<Cow<'static, [u8]>> {
    respond(
        status,
        "text/plain; charset=utf-8",
        reason.as_bytes().to_vec(),
    )
}

pub fn serve(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    let Some(mut path) = path_of(&uri) else {
        return refuse(StatusCode::BAD_REQUEST, "not a local file URL");
    };
    if !path.is_absolute() {
        return refuse(StatusCode::BAD_REQUEST, "the path is not absolute");
    }
    if path.is_dir() {
        path.push("index.html");
    }
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > MAX_FILE_BYTES => refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "the file is larger than 64 MiB",
        ),
        Ok(meta) if meta.is_file() => match std::fs::read(&path) {
            Ok(body) => respond(StatusCode::OK, content_type(&path), body),
            Err(error) => refuse(StatusCode::FORBIDDEN, &error.to_string()),
        },
        _ => refuse(StatusCode::NOT_FOUND, "no such file"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(url: &str) -> Response<Cow<'static, [u8]>> {
        let request = Request::builder()
            .uri(url)
            .body(Vec::new())
            .unwrap_or_default();
        serve(&request)
    }

    #[test]
    fn serves_a_file_with_its_type_and_the_sandbox() {
        let dir = std::env::temp_dir().join(format!("krang-local-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join("sub dir"));
        let _ = std::fs::write(dir.join("sub dir/index.html"), "<h1>hi</h1>");
        let url = url_for(&dir.join("sub dir/index.html")).unwrap_or_default();
        let response = get(&url);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["Content-Type"],
            "text/html; charset=utf-8"
        );
        assert!(
            response.headers()["Content-Security-Policy"]
                .to_str()
                .is_ok_and(|policy| policy.starts_with("sandbox"))
        );
        assert_eq!(response.body().as_ref(), b"<h1>hi</h1>");
        // A folder serves its index.
        assert_eq!(
            get(&url_for(&dir.join("sub dir")).unwrap_or_default()).status(),
            StatusCode::OK
        );
        assert_eq!(
            get(&format!("{ORIGIN}/no/such/file.html")).status(),
            StatusCode::NOT_FOUND
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
