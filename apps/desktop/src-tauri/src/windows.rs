use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::links::{layout_name_from_url, resolve_layout};
use crate::startup::{debug_dir, expand_home, layout_path_from};

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
}

#[derive(Default)]
pub struct WindowLayouts {
    by_label: Mutex<HashMap<String, Source>>,
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

pub fn source_from_url(app: &AppHandle, url: &str) -> Source {
    let Some(name) = layout_name_from_url(url) else {
        return Source::Missing(format!("{url} is not a layout link"));
    };
    let dirs = layout_dirs(app);
    match resolve_layout(&name, &dirs) {
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

/// The layout named on a command line, or in the environment when
/// `use_env` is set. Only the first launch reads the environment: a second
/// launch hands over its arguments, not its environment.
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
    layout_path_from(args, env_value).map(|path| Source::File(expand_home(&path, home.as_deref())))
}

pub fn open_window(app: &AppHandle, source: Source) -> tauri::Result<()> {
    let layouts = app.state::<WindowLayouts>();
    let number = layouts.counter.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("window-{number}");
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
    fn a_layout_flag_becomes_a_file_source() {
        let args = vec![String::from("--layout"), String::from("/tmp/a.toml")];
        assert_eq!(
            source_from_args(args, false),
            Some(Source::File(String::from("/tmp/a.toml")))
        );
        assert_eq!(source_from_args(Vec::new(), false), None);
    }
}
