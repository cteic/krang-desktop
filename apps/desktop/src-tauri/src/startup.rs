use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{State, WebviewWindow};

use crate::windows::{Source, WindowLayouts};

const DEBUG_DIR_ENV: &str = "DESKTOP_DEBUG_DIR";
const LAYOUT_FLAG: &str = "--layout";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutFile {
    path: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    layout: Option<LayoutFile>,
    layout_error: Option<String>,
    debug: bool,
}

/// Finds the layout path in `--layout <path>`, `--layout=<path>` or the
/// environment, in that order.
pub fn layout_path_from<I>(args: I, env_value: Option<String>) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == LAYOUT_FLAG {
            return args.next().filter(|path| !path.is_empty());
        }
        if let Some(path) = arg.strip_prefix("--layout=") {
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    env_value.filter(|path| !path.is_empty())
}

/// Expands a leading `~` to the home directory. Layout files are written by
/// hand and by scripts, and both use `~/project`.
pub fn expand_home(path: &str, home: Option<&str>) -> String {
    match (path, home) {
        ("~", Some(home)) => home.to_string(),
        (path, Some(home)) if path.starts_with("~/") => format!("{home}{}", &path[1..]),
        _ => path.to_string(),
    }
}

pub fn debug_dir() -> Option<PathBuf> {
    std::env::var(DEBUG_DIR_ENV)
        .ok()
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
}

/// Tells a window what to show. Rust only reads the file. Parsing and every
/// rule about what a layout means live in TypeScript.
#[tauri::command]
pub fn startup(window: WebviewWindow, layouts: State<'_, WindowLayouts>) -> Startup {
    let (layout, layout_error) = match layouts.source_of(window.label()) {
        Source::Default => (None, None),
        Source::Missing(reason) => (None, Some(reason)),
        Source::File(path) => match fs::read_to_string(&path) {
            Ok(text) => (Some(LayoutFile { path, text }), None),
            Err(error) => (None, Some(format!("could not read {path}: {error}"))),
        },
    };
    Startup {
        layout,
        layout_error,
        debug: debug_dir().is_some(),
    }
}

/// Writes one pane's visible text to the debug directory. Off unless the
/// debug directory is set, so a normal run never writes terminal contents
/// to disk.
#[tauri::command]
pub fn debug_snapshot(id: String, text: String) -> Result<(), String> {
    let dir = debug_dir().ok_or_else(|| String::from("debug snapshots are off"))?;
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err(String::from("pane id has no usable characters"));
    }
    fs::create_dir_all(&dir).map_err(|error| format!("create debug dir: {error}"))?;
    fs::write(dir.join(format!("{safe}.txt")), text).map_err(|error| format!("write: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn layout_flag_with_separate_value() {
        let found = layout_path_from(args(&["--layout", "/tmp/a.toml"]), None);
        assert_eq!(found.as_deref(), Some("/tmp/a.toml"));
    }

    #[test]
    fn layout_flag_with_equals() {
        let found = layout_path_from(args(&["--layout=/tmp/b.toml"]), None);
        assert_eq!(found.as_deref(), Some("/tmp/b.toml"));
    }

    #[test]
    fn flag_wins_over_environment() {
        let found = layout_path_from(
            args(&["--layout", "/tmp/a.toml"]),
            Some(String::from("/tmp/env.toml")),
        );
        assert_eq!(found.as_deref(), Some("/tmp/a.toml"));
    }

    #[test]
    fn environment_is_the_fallback() {
        let found = layout_path_from(args(&["--other"]), Some(String::from("/tmp/env.toml")));
        assert_eq!(found.as_deref(), Some("/tmp/env.toml"));
    }

    #[test]
    fn nothing_given_means_no_layout() {
        assert_eq!(layout_path_from(args(&[]), None), None);
        assert_eq!(layout_path_from(args(&["--layout"]), None), None);
        assert_eq!(layout_path_from(args(&[]), Some(String::new())), None);
    }

    #[test]
    fn home_is_expanded_only_at_the_start() {
        assert_eq!(expand_home("~/krang", Some("/Users/x")), "/Users/x/krang");
        assert_eq!(expand_home("~", Some("/Users/x")), "/Users/x");
        assert_eq!(expand_home("/a/~/b", Some("/Users/x")), "/a/~/b");
        assert_eq!(expand_home("~other/b", Some("/Users/x")), "~other/b");
        assert_eq!(expand_home("~/krang", None), "~/krang");
    }
}
