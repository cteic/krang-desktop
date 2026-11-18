//! What the web pane's address bar accepts: a URL, `localhost:3000`, a host
//! name, or a path to an HTML file on disk.

use std::path::Path;

use crate::shell::layout::expand_home;

use super::local;

/// The URL to load for what was typed.
pub fn resolve(input: &str) -> Option<String> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    if input.contains("://") || input.starts_with("about:") || input.starts_with("data:") {
        return Some(input.to_string());
    }
    if input.starts_with('/') || input.starts_with("~/") || input.starts_with("./") || input == "~" {
        return local::url_for(&expand_home(input));
    }
    if input.starts_with("localhost") || input.starts_with("127.0.0.1") || input.starts_with("[::1]") {
        return Some(format!("http://{input}"));
    }
    let path = Path::new(input);
    if path.extension().is_some_and(|ext| ext == "html" || ext == "htm") && path.exists() {
        return std::fs::canonicalize(path).ok().and_then(|path| local::url_for(&path));
    }
    if input.contains('.') && !input.contains(' ') {
        return Some(format!("https://{input}"));
    }
    None
}

/// What the address bar shows for a loaded URL: a local file as its path.
pub fn display(url: &str) -> String {
    local::path_of(url).map_or_else(|| url.to_string(), |path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_urls() {
        assert_eq!(resolve("localhost:3000").as_deref(), Some("http://localhost:3000"));
        assert_eq!(resolve("example.org/x").as_deref(), Some("https://example.org/x"));
        assert_eq!(resolve("https://a.b").as_deref(), Some("https://a.b"));
        assert_eq!(resolve("two words"), None);
        assert_eq!(resolve("  "), None);
    }

    #[test]
    fn a_path_becomes_a_local_file_url_and_shows_as_a_path() {
        let url = resolve("/tmp/page one.html").unwrap_or_default();
        assert_eq!(url, format!("{}/tmp/page%20one.html", local::ORIGIN));
        assert_eq!(display(&url), "/tmp/page one.html");
    }
}
