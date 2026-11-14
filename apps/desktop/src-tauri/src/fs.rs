use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
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

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes through a temporary file in the same directory and renames it into
/// place, so a crash mid-write cannot leave a half-written file.
///
/// A path that is a symbolic link is followed first. Renaming onto the link
/// itself would replace it with a plain file and leave the real one stale.
pub fn write_text(path: &str, text: &str) -> Result<(), String> {
    let given = Path::new(path);
    let target = fs::canonicalize(given).unwrap_or_else(|_| given.to_path_buf());
    let dir = target
        .parent()
        .ok_or_else(|| format!("{path} has no parent directory"))?;
    let name = target
        .file_name()
        .ok_or_else(|| format!("{path} has no file name"))?
        .to_string_lossy();
    // Unique per write, so two panes saving at once never share a file.
    let serial = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = dir.join(format!(".{name}.{}.{serial}.tmp", std::process::id()));

    // Private from the first byte. The target's own permissions are applied
    // before the rename, so a private file is never briefly readable.
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(text.as_bytes())
                .and_then(|()| file.sync_all())
        });
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(format!("{path}: {error}"));
    }
    let permissions = match fs::metadata(&target) {
        Ok(existing) => existing.permissions(),
        Err(_) => fs::Permissions::from_mode(0o644),
    };
    let _ = fs::set_permissions(&temporary, permissions);
    fs::rename(&temporary, &target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("{path}: {error}")
    })
}

#[tauri::command]
pub fn fs_home() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| String::from("HOME is not set"))
}

#[tauri::command(async)]
pub fn fs_list(path: String) -> Result<DirListing, String> {
    list_dir(&resolve(&path))
}

#[tauri::command(async)]
pub fn fs_read_text(path: String) -> Result<TextFile, String> {
    read_text(&resolve(&path))
}

#[tauri::command(async)]
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
    fn writing_through_a_symlink_keeps_the_link_and_updates_the_real_file() {
        let dir = scratch("symlink");
        let real = dir.join("real.txt");
        let link = dir.join("link.txt");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_text(link.to_str().unwrap(), "new").unwrap();

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_private_file_stays_private_and_a_new_file_is_ordinary() {
        let dir = scratch("modes");
        let private = dir.join("secret");
        fs::write(&private, "a").unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o600)).unwrap();

        write_text(private.to_str().unwrap(), "b").unwrap();
        assert_eq!(
            fs::metadata(&private).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let fresh = dir.join("fresh.md");
        write_text(fresh.to_str().unwrap(), "c").unwrap();
        assert_eq!(
            fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o644
        );

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
