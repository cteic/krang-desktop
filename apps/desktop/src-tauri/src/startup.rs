use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State, WebviewWindow};

use crate::windows::{Source, WindowLayouts};

const DEBUG_DIR_ENV: &str = "DESKTOP_DEBUG_DIR";
const LAYOUT_FLAG: &str = "--layout";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutFile {
    path: String,
    text: String,
}

/// One layout a window was asked to show: its file, or why there is none.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutEntry {
    layout: Option<LayoutFile>,
    layout_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    layout: Option<LayoutFile>,
    layout_error: Option<String>,
    /// Every layout asked for, in tab order. Empty for a plain window. The
    /// two fields above repeat the first entry.
    layouts: Vec<LayoutEntry>,
    /// The workspace this window saved last time, if it is one that restores.
    saved: Option<String>,
    /// Whether this window should save its workspace as it changes.
    persist: bool,
    debug: bool,
}

/// Finds every layout path given as `--layout <path>` or `--layout=<path>`,
/// in order. The environment is used only when no flag names one.
pub fn layout_paths_from<I>(args: I, env_value: Option<String>) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut paths = Vec::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == LAYOUT_FLAG {
            if let Some(path) = args.next().filter(|path| !path.is_empty()) {
                paths.push(path);
            }
        } else if let Some(path) = arg.strip_prefix("--layout=") {
            if !path.is_empty() {
                paths.push(path.to_string());
            }
        }
    }
    if paths.is_empty() {
        paths.extend(env_value.filter(|path| !path.is_empty()));
    }
    paths
}

/// Reads what one source names. A file that cannot be read is an entry with
/// an error, so the layouts beside it still open.
fn entries_for(source: Source) -> Vec<LayoutEntry> {
    match source {
        Source::Default => Vec::new(),
        Source::Missing(reason) => vec![LayoutEntry {
            layout: None,
            layout_error: Some(reason),
        }],
        Source::File(path) => vec![match fs::read_to_string(&path) {
            Ok(text) => LayoutEntry {
                layout: Some(LayoutFile { path, text }),
                layout_error: None,
            },
            Err(error) => LayoutEntry {
                layout: None,
                layout_error: Some(format!("could not read {path}: {error}")),
            },
        }],
        Source::Tabs(sources) => sources.into_iter().flat_map(entries_for).collect(),
    }
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

fn debug_dir_from(value: Option<String>) -> Option<PathBuf> {
    value.filter(|dir| !dir.is_empty()).map(PathBuf::from)
}

pub fn debug_dir() -> Option<PathBuf> {
    debug_dir_from(std::env::var(DEBUG_DIR_ENV).ok())
}

/// Whether the app may come to the front or take the keyboard, given the
/// debug directory. A run with one set is an automated run: it must leave
/// the keyboard with whatever the person at the machine is typing into.
pub fn may_take_focus_given(debug: Option<&Path>) -> bool {
    debug.is_none()
}

/// Every place that could bring the app to the front, or give one of its
/// windows the keyboard, asks this first.
pub fn may_take_focus() -> bool {
    may_take_focus_given(debug_dir().as_deref())
}

/// Tells a window what to show. Rust only reads the file. Parsing and every
/// rule about what a layout means live in TypeScript.
#[tauri::command]
pub fn startup(
    app: AppHandle,
    window: WebviewWindow,
    layouts: State<'_, WindowLayouts>,
    ptys: State<'_, crate::pty::PtyState>,
    agents: State<'_, crate::agents::AgentState>,
) -> Startup {
    // A page that asks for its startup state is a fresh page. If the window
    // was reloaded, the old page never got to end its shells, so end them.
    ptys.kill_window(window.label());
    agents.kill_window(window.label());
    let entries = entries_for(layouts.source_of(window.label()));
    let (layout, layout_error) = match entries.first() {
        Some(first) => (first.layout.clone(), first.layout_error.clone()),
        None => (None, None),
    };
    let restore_key = layouts.restore_key(window.label());
    let saved = restore_key
        .as_deref()
        .and_then(|key| crate::state::load(&app, key));
    Startup {
        layout,
        layout_error,
        layouts: entries,
        saved,
        persist: restore_key.is_some(),
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
        let found = layout_paths_from(args(&["--layout", "/tmp/a.toml"]), None);
        assert_eq!(found, args(&["/tmp/a.toml"]));
    }

    #[test]
    fn layout_flag_with_equals() {
        let found = layout_paths_from(args(&["--layout=/tmp/b.toml"]), None);
        assert_eq!(found, args(&["/tmp/b.toml"]));
    }

    #[test]
    fn flag_wins_over_environment() {
        let found = layout_paths_from(
            args(&["--layout", "/tmp/a.toml"]),
            Some(String::from("/tmp/env.toml")),
        );
        assert_eq!(found, args(&["/tmp/a.toml"]));
    }

    #[test]
    fn environment_is_the_fallback() {
        let found = layout_paths_from(args(&["--other"]), Some(String::from("/tmp/env.toml")));
        assert_eq!(found, args(&["/tmp/env.toml"]));
    }

    #[test]
    fn nothing_given_means_no_layout() {
        assert!(layout_paths_from(args(&[]), None).is_empty());
        assert!(layout_paths_from(args(&["--layout"]), None).is_empty());
        assert!(layout_paths_from(args(&[]), Some(String::new())).is_empty());
    }

    #[test]
    fn every_layout_flag_is_kept_in_order() {
        let found = layout_paths_from(
            args(&["--layout", "/tmp/a.toml", "--x", "--layout=/tmp/b.toml"]),
            Some(String::from("/tmp/env.toml")),
        );
        assert_eq!(found, args(&["/tmp/a.toml", "/tmp/b.toml"]));
    }

    #[test]
    fn a_plain_window_has_no_layout_entries() {
        assert!(entries_for(Source::Default).is_empty());
    }

    #[test]
    fn several_layouts_are_read_in_order_and_one_failure_stays_alone() {
        let dir = std::env::temp_dir().join(format!("startup-tabs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let first = dir.join("first.toml").to_string_lossy().into_owned();
        let gone = dir.join("gone.toml").to_string_lossy().into_owned();
        let last = dir.join("last.toml").to_string_lossy().into_owned();
        fs::write(&first, "name = \"first\"").unwrap();
        fs::write(&last, "name = \"last\"").unwrap();

        let entries = entries_for(Source::Tabs(vec![
            Source::File(first.clone()),
            Source::File(gone.clone()),
            Source::Missing(String::from("no layout named \"x\"")),
            Source::File(last.clone()),
        ]));

        assert_eq!(entries.len(), 4);
        assert_eq!(
            entries[0],
            LayoutEntry {
                layout: Some(LayoutFile {
                    path: first,
                    text: String::from("name = \"first\""),
                }),
                layout_error: None,
            }
        );
        assert_eq!(entries[1].layout, None);
        assert!(entries[1]
            .layout_error
            .as_deref()
            .is_some_and(|reason| reason.starts_with(&format!("could not read {gone}"))));
        assert_eq!(
            entries[2].layout_error.as_deref(),
            Some("no layout named \"x\"")
        );
        assert_eq!(
            entries[3].layout.as_ref().map(|file| file.path.as_str()),
            Some(last.as_str())
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_run_with_a_debug_directory_never_takes_focus() {
        assert!(may_take_focus_given(None));
        assert!(!may_take_focus_given(Some(Path::new("/tmp/debug"))));
    }

    #[test]
    fn an_empty_debug_directory_is_a_normal_run() {
        assert_eq!(debug_dir_from(None), None);
        assert_eq!(debug_dir_from(Some(String::new())), None);
        assert!(may_take_focus_given(
            debug_dir_from(Some(String::new())).as_deref()
        ));
        let set = debug_dir_from(Some(String::from("/tmp/debug")));
        assert_eq!(set, Some(PathBuf::from("/tmp/debug")));
        assert!(!may_take_focus_given(set.as_deref()));
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
