use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::fs::write_text;
use crate::links::is_safe_name;
use crate::windows::WindowLayouts;

const STATE_SUBDIR: &str = "workspaces";
/// A saved workspace is a few kilobytes. Anything near this is not one.
const MAX_STATE_BYTES: usize = 1024 * 1024;

pub fn state_file(app: &AppHandle, key: &str) -> Option<PathBuf> {
    if !is_safe_name(key) {
        return None;
    }
    let dir = app.path().app_data_dir().ok()?.join(STATE_SUBDIR);
    Some(dir.join(format!("{key}.json")))
}

/// Reads the saved workspace for a key. A missing or unreadable file is
/// simply "nothing saved": the window then opens fresh.
pub fn load(app: &AppHandle, key: &str) -> Option<String> {
    let path = state_file(app, key)?;
    fs::read_to_string(path).ok()
}

/// Saves the calling window's workspace. Only a window that was given a
/// restore key may save; the page cannot choose where the file goes.
#[tauri::command]
pub fn workspace_save(
    app: AppHandle,
    window: WebviewWindow,
    layouts: State<'_, WindowLayouts>,
    json: String,
) -> Result<(), String> {
    let key = layouts
        .restore_key(window.label())
        .ok_or_else(|| String::from("this window does not save its workspace"))?;
    if json.len() > MAX_STATE_BYTES {
        return Err(format!("workspace is {} bytes, over the limit", json.len()));
    }
    let path = state_file(&app, &key).ok_or_else(|| String::from("no place to save"))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("create state dir: {error}"))?;
    }
    write_text(&path.to_string_lossy(), &json)
}
