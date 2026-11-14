use std::fs;
use std::path::Path;

use tauri::http::{Request, Response, StatusCode};

/// The scheme a web pane uses to show a file from disk:
/// `localfile://localhost/<absolute path>`. Because the path keeps its
/// slashes, a page's relative links to its own styles and images resolve.
pub const SCHEME: &str = "localfile";

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

/// Decodes `%XX` escapes. Invalid escapes are left as they are.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn respond(status: StatusCode, kind: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", kind)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn serve(uri_path: &str) -> Response<Vec<u8>> {
    let decoded = percent_decode(uri_path);
    let mut path = Path::new(&decoded).to_path_buf();
    if !path.is_absolute() {
        return respond(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"path must be absolute".to_vec(),
        );
    }
    if path.is_dir() {
        path = path.join("index.html");
    }
    match fs::read(&path) {
        Ok(body) => respond(StatusCode::OK, content_type(&path), body),
        Err(error) => respond(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            format!("{}: {error}", path.display()).into_bytes(),
        ),
    }
}

pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    serve(request.uri().path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/a%20b/c%2Fd"), "/a b/c/d");
        assert_eq!(percent_decode("/caf%C3%A9"), "/café");
        assert_eq!(percent_decode("/bad%zz%4"), "/bad%zz%4");
    }

    #[test]
    fn serves_a_file_with_its_type_and_an_index_for_a_directory() {
        let dir = std::env::temp_dir().join(format!("localfile-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("index.html"), "<h1>hi</h1>").unwrap();
        fs::write(dir.join("my style.css"), "body{}").unwrap();

        let page = serve(dir.to_str().unwrap());
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.body(), b"<h1>hi</h1>");
        assert_eq!(page.headers()["Content-Type"], "text/html; charset=utf-8");

        let css = serve(&format!("{}/my%20style.css", dir.to_str().unwrap()));
        assert_eq!(css.headers()["Content-Type"], "text/css; charset=utf-8");

        assert_eq!(
            serve(&format!("{}/nope.html", dir.to_str().unwrap())).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(serve("relative/path").status(), StatusCode::BAD_REQUEST);

        fs::remove_dir_all(&dir).unwrap();
    }
}
