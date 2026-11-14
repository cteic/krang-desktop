use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::startup::expand_home;

/// Files larger than this are not opened as text. An editor pane that loads
/// a multi-gigabyte log would take the window down with it.
const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// Milliseconds since the Unix epoch. Zero when the system cannot say.
    modified_ms: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// The directory as resolved: home expanded, made absolute.
    path: String,
    parent: Option<String>,
    entries: Vec<DirEntry>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    path: String,
    text: String,
}

fn resolve(path: &str) -> String {
    let home = std::env::var("HOME").ok();
    expand_home(path, home.as_deref())
}

pub fn list_dir(path: &str) -> Result<DirListing, String> {
    let resolved = fs::canonicalize(path).map_err(|error| format!("{path}: {error}"))?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&resolved).map_err(|error| format!("{path}: {error}"))? {
        let Ok(entry) = entry else { continue };
        // Follow links, so a link to a directory opens as one. A broken link
        // still lists, as a file of size zero.
        let metadata = fs::metadata(entry.path()).ok();
        let modified_ms = metadata
            .as_ref()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.as_ref().is_some_and(fs::Metadata::is_dir),
            size: metadata.as_ref().map_or(0, fs::Metadata::len),
            modified_ms,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirListing {
        parent: resolved
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        path: resolved.to_string_lossy().into_owned(),
        entries,
    })
}

pub fn read_text(path: &str) -> Result<TextFile, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("{path}: {error}"))?;
    if metadata.is_dir() {
        return Err(format!("{path} is a directory"));
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "{path} is {} bytes, over the {MAX_TEXT_BYTES} byte limit for the editor",
            metadata.len()
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("{path}: {error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{path} is not UTF-8 text"))?;
    Ok(TextFile {
        path: path.to_string(),
        text,
    })
}

/// Writes through a temporary file in the same directory and renames it into
/// place, so a crash mid-write cannot leave a half-written file.
pub fn write_text(path: &str, text: &str) -> Result<(), String> {
    let target = Path::new(path);
    let dir = target
        .parent()
        .ok_or_else(|| format!("{path} has no parent directory"))?;
    let name = target
        .file_name()
        .ok_or_else(|| format!("{path} has no file name"))?
        .to_string_lossy();
    let temporary = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    fs::write(&temporary, text).map_err(|error| format!("{path}: {error}"))?;
    if let Ok(existing) = fs::metadata(target) {
        let _ = fs::set_permissions(&temporary, existing.permissions());
    }
    fs::rename(&temporary, target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("{path}: {error}")
    })
}

#[tauri::command]
pub fn fs_home() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| String::from("HOME is not set"))
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<DirListing, String> {
    list_dir(&resolve(&path))
}

#[tauri::command]
pub fn fs_read_text(path: String) -> Result<TextFile, String> {
    read_text(&resolve(&path))
}

#[tauri::command]
pub fn fs_write_text(path: String, text: String) -> Result<(), String> {
    write_text(&resolve(&path), &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fs-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_directories_first_then_by_name() {
        let dir = scratch("list");
        fs::write(dir.join("b.txt"), "bb").unwrap();
        fs::write(dir.join("A.txt"), "a").unwrap();
        fs::create_dir(dir.join("zeta")).unwrap();

        let listing = list_dir(dir.to_str().unwrap()).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zeta", "A.txt", "b.txt"]);
        assert!(listing.entries[0].is_dir);
        assert_eq!(listing.entries[2].size, 2);
        assert!(listing.parent.is_some());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn listing_a_missing_directory_is_an_error() {
        assert!(list_dir("/definitely/not/here").is_err());
    }

    #[test]
    fn text_round_trips_and_replaces_the_old_content() {
        let dir = scratch("write");
        let file = dir.join("note.md");
        let path = file.to_str().unwrap();

        write_text(path, "first").unwrap();
        write_text(path, "second ✓").unwrap();
        assert_eq!(read_text(path).unwrap().text, "second ✓");

        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_binary_and_directories() {
        let dir = scratch("binary");
        let file = dir.join("blob.bin");
        fs::write(&file, [0xff, 0xfe, 0x00]).unwrap();

        assert!(read_text(file.to_str().unwrap())
            .unwrap_err()
            .contains("not UTF-8"));
        assert!(read_text(dir.to_str().unwrap())
            .unwrap_err()
            .contains("is a directory"));

        fs::remove_dir_all(&dir).unwrap();
    }
}
