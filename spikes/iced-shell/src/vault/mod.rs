//! A vault: a folder of Markdown notes, as Obsidian keeps one.

pub mod frontmatter;
pub mod fuzzy;
pub mod index;
pub mod links;
pub mod markdown;

use std::path::{Path, PathBuf};

/// The vault Obsidian opened last, from the text of its `obsidian.json`.
pub fn recent_obsidian_vault(list: &str) -> Option<PathBuf> {
    let list: serde_json::Value = serde_json::from_str(list).ok()?;
    list.get("vaults")?
        .as_object()?
        .values()
        .filter_map(|vault| {
            let path = PathBuf::from(vault.get("path")?.as_str()?);
            let opened = vault.get("ts").and_then(serde_json::Value::as_u64)?;
            path.is_dir().then_some((opened, path))
        })
        .max_by_key(|(opened, _)| *opened)
        .map(|(_, path)| path)
}

/// The vault a new editor opens when none is named: the one asked for, or
/// the folder the app started in, or the vault Obsidian opened last. An
/// app opened from the Dock starts in `/`, and neither that nor a home
/// folder is a vault, so those two never win over a real one.
pub fn default_root(
    asked: Option<PathBuf>,
    started_in: Option<PathBuf>,
    home: Option<&Path>,
    obsidian_list: Option<&str>,
) -> PathBuf {
    let bare = |dir: &PathBuf| dir.parent().is_none() || Some(dir.as_path()) == home;
    asked
        .or_else(|| started_in.clone().filter(|dir| !bare(dir)))
        .or_else(|| obsidian_list.and_then(recent_obsidian_vault))
        .or_else(|| home.map(Path::to_path_buf))
        .or(started_in)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_vault_is_never_the_whole_disk() {
        let base = std::env::temp_dir().join(format!("krang-default-{}", std::process::id()));
        let (old, new) = (base.join("old"), base.join("new"));
        let _ = std::fs::create_dir_all(&old);
        let _ = std::fs::create_dir_all(&new);
        let list = serde_json::json!({ "vaults": {
            "a": { "path": old, "ts": 1 },
            "b": { "path": new, "ts": 2, "open": true },
            "c": { "path": base.join("gone"), "ts": 3 },
        }})
        .to_string();
        let home = Path::new("/Users/x");
        let root = || Some(PathBuf::from("/"));

        assert_eq!(default_root(None, root(), Some(home), Some(&list)), new);
        assert_eq!(
            default_root(None, Some(home.to_path_buf()), Some(home), Some(&list)),
            new
        );
        assert_eq!(default_root(None, root(), Some(home), None), home);
        assert_eq!(default_root(None, root(), Some(home), Some("junk")), home);
        assert_eq!(
            default_root(
                None,
                Some(PathBuf::from("/work/notes")),
                Some(home),
                Some(&list)
            ),
            PathBuf::from("/work/notes")
        );
        assert_eq!(
            default_root(
                Some(PathBuf::from("/asked")),
                root(),
                Some(home),
                Some(&list)
            ),
            PathBuf::from("/asked")
        );
        let _ = std::fs::remove_dir_all(base);
    }
}
