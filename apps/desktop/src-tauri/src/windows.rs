use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::links::{layout_name_from_url, layout_names_from_url, resolve_layout, MAX_LINK_LAYOUTS};
use crate::startup::{debug_dir, expand_home, layout_paths_from};

const LAYOUT_ENV: &str = "DESKTOP_LAYOUT";
const LAYOUT_SUBDIR: &str = "layouts";
/// Tab configs written for another terminal use the same file format, so
/// they are found by name too.
const COMPATIBLE_LAYOUT_DIR: &str = ".warp/tab_configs";

/// What a window was opened to show.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// One shell in the home directory.
    Default,
    /// A layout file at this path.
    File(String),
    /// A layout was asked for and could not be found. The text says why.
    Missing(String),
    /// Several layouts in one window, one tab each, in this order. Every
    /// entry is a `File` or a `Missing`.
    Tabs(Vec<Source>),
}

/// The restore key of the window that reopens as the person left it.
const DEFAULT_RESTORE_KEY: &str = "default";

#[derive(Default)]
pub struct WindowLayouts {
    by_label: Mutex<HashMap<String, Source>>,
    /// Which windows save their workspace, and under which key. A key is
    /// held by one live window at a time, so two windows never overwrite
    /// each other's saved state.
    restore_keys: Mutex<HashMap<String, String>>,
    counter: AtomicU32,
}

impl WindowLayouts {
    pub fn source_of(&self, label: &str) -> Source {
        self.by_label
            .lock()
            .ok()
            .and_then(|map| map.get(label).cloned())
            .unwrap_or(Source::Default)
    }

    pub fn forget(&self, label: &str) {
        if let Ok(mut map) = self.by_label.lock() {
            map.remove(label);
        }
        if let Ok(mut keys) = self.restore_keys.lock() {
            keys.remove(label);
        }
    }

    pub fn restore_key(&self, label: &str) -> Option<String> {
        self.restore_keys.lock().ok()?.get(label).cloned()
    }

    /// Gives `label` the default restore key if no live window holds it.
    pub fn claim_default(&self, label: &str) -> bool {
        let Ok(mut keys) = self.restore_keys.lock() else {
            return false;
        };
        if keys.values().any(|key| key == DEFAULT_RESTORE_KEY) {
            return false;
        }
        keys.insert(label.to_string(), DEFAULT_RESTORE_KEY.to_string());
        true
    }
}

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

/// The source for one layout name, looked up in `dirs`.
fn source_for_name(name: &str, dirs: &[PathBuf]) -> Source {
    match resolve_layout(name, dirs) {
        Some(path) => Source::File(path.to_string_lossy().into_owned()),
        None => {
            let searched: Vec<String> = dirs
                .iter()
                .map(|dir| dir.to_string_lossy().into_owned())
                .collect();
            Source::Missing(format!(
                "no layout named \"{name}\" in {}",
                searched.join(" or ")
            ))
        }
    }
}

/// What a layout link opens, given where layouts are kept. A link that names
/// one layout opens it. A link that names several opens one window with a tab
/// for each, and a name that is unsafe or not found fails alone.
pub fn source_from_link(url: &str, dirs: &[PathBuf]) -> Source {
    if let Some(name) = layout_name_from_url(url) {
        return source_for_name(&name, dirs);
    }
    let names = match layout_names_from_url(url) {
        Some(names) if names.len() > 1 => names,
        Some(_) => return Source::Missing(format!("{url} is not a layout link")),
        None => {
            return Source::Missing(format!(
                "{url} is not a layout link. A link names one to {MAX_LINK_LAYOUTS} layouts"
            ))
        }
    };
    Source::Tabs(
        names
            .iter()
            .map(|name| match name {
                Ok(name) => source_for_name(name, dirs),
                Err(name) => Source::Missing(format!("\"{name}\" is not a layout name")),
            })
            .collect(),
    )
}

pub fn source_from_url(app: &AppHandle, url: &str) -> Source {
    source_from_link(url, &layout_dirs(app))
}

/// The layouts named on a command line, or in the environment when
/// `use_env` is set. Only the first launch reads the environment: a second
/// launch hands over its arguments, not its environment. One `--layout` is
/// one layout; several open as tabs of one window.
pub fn source_from_args<I>(args: I, use_env: bool) -> Option<Source>
where
    I: IntoIterator<Item = String>,
{
    let env_value = if use_env {
        std::env::var(LAYOUT_ENV).ok()
    } else {
        None
    };
    let home = std::env::var("HOME").ok();
    let mut files: Vec<Source> = layout_paths_from(args, env_value)
        .into_iter()
        .map(|path| Source::File(expand_home(&path, home.as_deref())))
        .collect();
    match files.len() {
        0 => None,
        1 => files.pop(),
        _ => Some(Source::Tabs(files)),
    }
}

pub fn open_window(app: &AppHandle, source: Source) -> tauri::Result<()> {
    let layouts = app.state::<WindowLayouts>();
    let number = layouts.counter.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("window-{number}");
    // Only a plain window restores, and never in an automated run, which
    // must neither read nor overwrite the person's saved arrangement.
    if source == Source::Default && debug_dir().is_none() {
        layouts.claim_default(&label);
    }
    if let Ok(mut map) = layouts.by_label.lock() {
        map.insert(label.clone(), source);
    }
    let title = app.config().product_name.clone().unwrap_or_default();
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1400.0, 900.0)
        .min_inner_size(480.0, 320.0)
        // An automated run must not take the keyboard from whatever the
        // person at the machine is typing into.
        .focused(debug_dir().is_none())
        .build();
    if let Err(error) = built {
        layouts.forget(&label);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_with_no_record_shows_the_default() {
        let layouts = WindowLayouts::default();
        assert_eq!(layouts.source_of("window-9"), Source::Default);
    }

    #[test]
    fn forgetting_a_window_drops_its_layout() {
        let layouts = WindowLayouts::default();
        layouts.by_label.lock().unwrap().insert(
            String::from("window-1"),
            Source::File(String::from("/a.toml")),
        );
        assert_eq!(
            layouts.source_of("window-1"),
            Source::File(String::from("/a.toml"))
        );
        layouts.forget("window-1");
        assert_eq!(layouts.source_of("window-1"), Source::Default);
    }

    #[test]
    fn one_live_window_holds_the_default_restore_key() {
        let layouts = WindowLayouts::default();
        assert!(layouts.claim_default("window-1"));
        assert!(!layouts.claim_default("window-2"));
        assert_eq!(layouts.restore_key("window-1").as_deref(), Some("default"));
        assert_eq!(layouts.restore_key("window-2"), None);

        layouts.forget("window-1");
        assert!(layouts.claim_default("window-2"));
    }

    #[test]
    fn a_layout_flag_becomes_a_file_source() {
        let args = vec![String::from("--layout"), String::from("/tmp/a.toml")];
        assert_eq!(
            source_from_args(args, false),
            Some(Source::File(String::from("/tmp/a.toml")))
        );
        assert_eq!(source_from_args(Vec::new(), false), None);
    }

    #[test]
    fn several_layout_flags_become_tabs_in_order() {
        let args = vec![
            String::from("--layout"),
            String::from("/tmp/a.toml"),
            String::from("--layout=/tmp/b.toml"),
        ];
        assert_eq!(
            source_from_args(args, false),
            Some(Source::Tabs(vec![
                Source::File(String::from("/tmp/a.toml")),
                Source::File(String::from("/tmp/b.toml")),
            ]))
        );
    }

    fn layout_dir(name: &str, files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("link-source-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for file in files {
            std::fs::write(dir.join(file), "").unwrap();
        }
        dir
    }

    #[test]
    fn a_link_with_one_name_opens_that_layout() {
        let dir = layout_dir("one", &["lab.toml"]);
        let dirs = vec![dir.clone()];
        assert_eq!(
            source_from_link("app://layout/lab", &dirs),
            Source::File(dir.join("lab.toml").to_string_lossy().into_owned())
        );
        assert!(matches!(
            source_from_link("app://layout/.hidden", &dirs),
            Source::Missing(reason) if reason.contains("is not a layout link")
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_link_with_several_names_opens_a_tab_for_each() {
        let dir = layout_dir("several", &["lab.toml", "board.toml"]);
        let dirs = vec![dir.clone()];
        let path = |name: &str| dir.join(name).to_string_lossy().into_owned();

        assert_eq!(
            source_from_link("app://layout/lab+board", &dirs),
            Source::Tabs(vec![
                Source::File(path("lab.toml")),
                Source::File(path("board.toml")),
            ])
        );

        let Source::Tabs(tabs) = source_from_link("app://layout/lab+gone+..+board", &dirs) else {
            panic!("expected tabs");
        };
        assert_eq!(tabs.len(), 4);
        assert_eq!(tabs[0], Source::File(path("lab.toml")));
        assert!(
            matches!(&tabs[1], Source::Missing(reason) if reason.contains("no layout named \"gone\""))
        );
        assert!(
            matches!(&tabs[2], Source::Missing(reason) if reason.contains("is not a layout name"))
        );
        assert_eq!(tabs[3], Source::File(path("board.toml")));

        assert!(matches!(
            source_from_link("app://layout/a+b+c+d+e+f+g", &dirs),
            Source::Missing(reason) if reason.contains("one to 6 layouts")
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
