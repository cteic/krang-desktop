//! The vault's file tree as a flat list of rows, so only the rows on
//! screen need widgets however many notes the vault has.

use std::collections::{BTreeMap, HashSet};

use crate::vault::index::Index;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowKind {
    Folder { path: String, expanded: bool },
    Note { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub depth: usize,
    pub label: String,
    pub kind: RowKind,
}

#[derive(Default)]
struct Folder<'a> {
    folders: BTreeMap<&'a str, Folder<'a>>,
    notes: Vec<(&'a str, &'a str)>,
}

fn walk(folder: &Folder<'_>, prefix: &str, depth: usize, expanded: &HashSet<String>, rows: &mut Vec<Row>) {
    for (name, child) in &folder.folders {
        let path = if prefix.is_empty() { (*name).to_string() } else { format!("{prefix}/{name}") };
        let open = expanded.contains(&path);
        rows.push(Row { depth, label: (*name).to_string(), kind: RowKind::Folder { path: path.clone(), expanded: open } });
        if open {
            walk(child, &path, depth + 1, expanded, rows);
        }
    }
    for (name, path) in &folder.notes {
        rows.push(Row { depth, label: (*name).to_string(), kind: RowKind::Note { path: (*path).to_string() } });
    }
}

/// Folders first, then notes, each sorted by name; a closed folder's
/// contents are left out.
pub fn rows(index: &Index, expanded: &HashSet<String>) -> Vec<Row> {
    let mut root = Folder::default();
    for note in index.notes() {
        let mut folder = &mut root;
        let mut parts: Vec<&str> = note.path.split('/').collect();
        parts.pop();
        for part in parts {
            folder = folder.folders.entry(part).or_default();
        }
        folder.notes.push((note.name.as_str(), note.path.as_str()));
    }
    fn sort(folder: &mut Folder<'_>) {
        folder.notes.sort_by_key(|(name, _)| name.to_lowercase());
        for child in folder.folders.values_mut() {
            sort(child);
        }
    }
    sort(&mut root);
    let mut rows = Vec::new();
    walk(&root, "", 0, expanded, &mut rows);
    rows
}

/// The rows to build for a scroll position: the visible ones and a margin.
pub fn window(total: usize, row_height: f32, offset: f32, height: f32) -> std::ops::Range<usize> {
    let first = ((offset / row_height).floor().max(0.0) as usize).saturating_sub(10).min(total);
    let count = (height / row_height).ceil() as usize + 20;
    first..(first + count).min(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_first_and_closed_folders_hide_their_notes() {
        let root = std::env::temp_dir().join(format!("krang-tree-{}", std::process::id()));
        let _ = std::fs::create_dir_all(root.join("b/c"));
        for path in ["z.md", "a.md", "b/n.md", "b/c/deep.md"] {
            let _ = std::fs::write(root.join(path), "x");
        }
        let index = Index::open(&root);
        let closed: Vec<String> = rows(&index, &HashSet::new()).into_iter().map(|row| row.label).collect();
        assert_eq!(closed, ["b", "a", "z"]);
        let open: HashSet<String> = ["b".to_string()].into();
        let labels: Vec<(usize, String)> = rows(&index, &open).into_iter().map(|row| (row.depth, row.label)).collect();
        assert_eq!(labels, [(0, "b".into()), (1, "c".into()), (1, "n".into()), (0, "a".into()), (0, "z".into())]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_window_covers_the_screen_and_a_margin() {
        assert_eq!(window(5000, 20.0, 0.0, 400.0), 0..40);
        assert_eq!(window(5000, 20.0, 2000.0, 400.0), 90..130);
        assert_eq!(window(30, 20.0, 0.0, 400.0), 0..30);
    }
}
