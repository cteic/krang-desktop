//! A folder tree that reads one directory at a time.
//!
//! Nothing is read until a folder is opened, and each folder is read once
//! and then kept. The open rows are one flat list of small indices, so a
//! folder with tens of thousands of entries costs one listing and one pass,
//! and the view builds widgets only for the rows on screen.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
}

impl Entry {
    pub fn is_hidden(&self) -> bool {
        self.name.starts_with('.')
    }
}

/// Reads one directory: folders first, then files, each by name without
/// regard to case. This blocks, so it runs off the window's thread.
pub fn list(dir: &Path) -> Result<Vec<Entry>, String> {
    let reader = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => {
                // A link to a folder opens like a folder.
                std::fs::metadata(entry.path()).is_ok_and(|target| target.is_dir())
            }
            Ok(kind) => kind.is_dir(),
            Err(_) => false,
        };
        entries.push(Entry { name, is_dir });
    }
    entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
    Ok(entries)
}

#[derive(Debug, Clone)]
enum Listing {
    Loaded(Arc<Vec<Entry>>),
    Failed(String),
}

/// One line of the tree: an entry of a listed folder, by index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Row {
    folder: usize,
    entry: usize,
    pub depth: usize,
}

/// What a row shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    File,
    Closed,
    Open,
    /// Open, and its listing has not arrived yet.
    Loading,
    /// Open, and it could not be read.
    Unreadable,
}

#[derive(Debug)]
pub struct Tree {
    root: PathBuf,
    show_hidden: bool,
    /// Open folders, as paths under the root with `/` between parts.
    expanded: BTreeSet<String>,
    /// Listed folders. The root's path is the empty string.
    folders: Vec<(String, Listing)>,
    by_path: HashMap<String, usize>,
    rows: Vec<Row>,
}

fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_string()
    } else {
        format!("{folder}/{name}")
    }
}

/// The folder a path is in, and its name there.
fn split(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}

impl Tree {
    pub fn new(
        root: PathBuf,
        show_hidden: bool,
        expanded: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            root,
            show_hidden,
            expanded: expanded
                .into_iter()
                .filter(|path| !path.is_empty())
                .collect(),
            folders: Vec::new(),
            by_path: HashMap::new(),
            rows: Vec::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn show_hidden(&self) -> bool {
        self.show_hidden
    }

    pub fn set_show_hidden(&mut self, show: bool) {
        self.show_hidden = show;
        self.rebuild();
    }

    /// The open folders, for saving. A folder under a closed one stays in
    /// the list, so it is open again when its parent is.
    pub fn expanded(&self) -> Vec<String> {
        self.expanded.iter().cloned().collect()
    }

    pub fn absolute(&self, path: &str) -> PathBuf {
        if path.is_empty() {
            self.root.clone()
        } else {
            self.root.join(path)
        }
    }

    /// Whether the root has been listed, or has failed to list.
    pub fn is_ready(&self) -> bool {
        self.by_path.contains_key("")
    }

    /// Why the root could not be read, when it could not.
    pub fn root_error(&self) -> Option<&str> {
        match self.by_path.get("").map(|index| &self.folders[*index].1) {
            Some(Listing::Failed(error)) => Some(error),
            _ => None,
        }
    }

    /// Folders that are on show and not listed yet: the root, and each open
    /// folder whose parent is listed and has it.
    pub fn wanted(&self) -> Vec<String> {
        let mut wanted = Vec::new();
        if !self.is_ready() {
            wanted.push(String::new());
        }
        for path in &self.expanded {
            if !self.by_path.contains_key(path) && self.is_shown_folder(path) {
                wanted.push(path.clone());
            }
        }
        wanted
    }

    /// Every folder that has been listed and is still on show, to read again.
    pub fn listed(&self) -> Vec<String> {
        self.folders
            .iter()
            .map(|(path, _)| path.clone())
            .filter(|path| self.is_on_show(path))
            .collect()
    }

    /// Whether a folder's own contents are on show: the root's always are,
    /// and another folder's when it is open and so is every folder above it.
    fn is_on_show(&self, path: &str) -> bool {
        path.is_empty() || (self.expanded.contains(path) && self.is_shown_folder(path))
    }

    /// Whether a path is a folder in a listed, open chain from the root.
    fn is_shown_folder(&self, path: &str) -> bool {
        let (parent, name) = split(path);
        let listed = match self
            .by_path
            .get(parent)
            .map(|index| &self.folders[*index].1)
        {
            Some(Listing::Loaded(entries)) => entries
                .iter()
                .any(|entry| entry.is_dir && entry.name == name),
            _ => false,
        };
        listed
            && (parent.is_empty()
                || (self.expanded.contains(parent) && self.is_shown_folder(parent)))
    }

    /// Takes a folder's listing, or the reason there is none.
    pub fn set_listing(&mut self, path: &str, listing: Result<Arc<Vec<Entry>>, String>) {
        let listing = match listing {
            Ok(entries) => Listing::Loaded(entries),
            Err(error) => Listing::Failed(error),
        };
        match self.by_path.get(path) {
            Some(index) => self.folders[*index].1 = listing,
            None => {
                self.by_path.insert(path.to_string(), self.folders.len());
                self.folders.push((path.to_string(), listing));
            }
        }
        self.rebuild();
    }

    /// Forgets the listings of folders that are no longer on show, so a
    /// refresh reads only what can be seen and a reopened folder is read anew.
    pub fn forget_hidden(&mut self) {
        let keep: Vec<(String, Listing)> = self
            .folders
            .iter()
            .filter(|(path, _)| self.is_on_show(path))
            .cloned()
            .collect();
        self.by_path = keep
            .iter()
            .enumerate()
            .map(|(index, (path, _))| (path.clone(), index))
            .collect();
        self.folders = keep;
        self.rebuild();
    }

    pub fn set_expanded(&mut self, path: &str, open: bool) {
        let changed = if open {
            self.expanded.insert(path.to_string())
        } else {
            self.expanded.remove(path)
        };
        if changed {
            self.rebuild();
        }
    }

    fn rebuild(&mut self) {
        let mut rows = Vec::new();
        if let Some(root) = self.by_path.get("") {
            let mut path = String::new();
            self.walk(*root, 0, &mut path, &mut rows);
        }
        self.rows = rows;
    }

    fn walk(&self, folder: usize, depth: usize, path: &mut String, rows: &mut Vec<Row>) {
        let Listing::Loaded(entries) = &self.folders[folder].1 else {
            return;
        };
        let base = path.len();
        for (index, entry) in entries.iter().enumerate() {
            if !self.show_hidden && entry.is_hidden() {
                continue;
            }
            rows.push(Row {
                folder,
                entry: index,
                depth,
            });
            // No folder is open in most listings, and then no path is built.
            if !entry.is_dir || self.expanded.is_empty() {
                continue;
            }
            if base > 0 {
                path.push('/');
            }
            path.push_str(&entry.name);
            if self.expanded.contains(path.as_str())
                && let Some(child) = self.by_path.get(path.as_str())
            {
                self.walk(*child, depth + 1, path, rows);
            }
            path.truncate(base);
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn entry(&self, row: &Row) -> Option<&Entry> {
        match &self.folders.get(row.folder)?.1 {
            Listing::Loaded(entries) => entries.get(row.entry),
            Listing::Failed(_) => None,
        }
    }

    /// A row's path under the root.
    pub fn path(&self, row: &Row) -> Option<String> {
        let entry = self.entry(row)?;
        Some(join(&self.folders[row.folder].0, &entry.name))
    }

    pub fn state(&self, row: &Row) -> State {
        let Some(entry) = self.entry(row) else {
            return State::File;
        };
        if !entry.is_dir {
            return State::File;
        }
        let path = join(&self.folders[row.folder].0, &entry.name);
        if !self.expanded.contains(&path) {
            return State::Closed;
        }
        match self.by_path.get(&path).map(|index| &self.folders[*index].1) {
            Some(Listing::Loaded(_)) => State::Open,
            Some(Listing::Failed(_)) => State::Unreadable,
            None => State::Loading,
        }
    }

    /// The row of a path, when it is on show.
    pub fn position(&self, path: &str) -> Option<usize> {
        let (parent, name) = split(path);
        let folder = *self.by_path.get(parent)?;
        self.rows.iter().position(|row| {
            row.folder == folder && self.entry(row).is_some_and(|entry| entry.name == name)
        })
    }

    /// The row of the folder a row is in, or `None` at the top level.
    pub fn parent(&self, index: usize) -> Option<usize> {
        let depth = self.rows.get(index)?.depth;
        if depth == 0 {
            return None;
        }
        self.rows[..index]
            .iter()
            .rposition(|row| row.depth == depth - 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(names: &[&str]) -> Result<Arc<Vec<Entry>>, String> {
        Ok(Arc::new(
            names
                .iter()
                .map(|name| Entry {
                    name: name.trim_end_matches('/').to_string(),
                    is_dir: name.ends_with('/'),
                })
                .collect(),
        ))
    }

    fn shown(tree: &Tree) -> Vec<(usize, String)> {
        tree.rows()
            .iter()
            .filter_map(|row| Some((row.depth, tree.path(row)?)))
            .collect()
    }

    fn sample() -> Tree {
        let mut tree = Tree::new(PathBuf::from("/demo"), false, []);
        tree.set_listing("", entries(&["docs/", "src/", ".env", "README.md"]));
        tree
    }

    #[test]
    fn nothing_is_read_until_a_folder_is_opened() {
        let mut tree = Tree::new(PathBuf::from("/demo"), false, []);
        assert_eq!(tree.wanted(), [""]);
        assert!(tree.is_empty());
        tree.set_listing("", entries(&["docs/", "src/", ".env", "README.md"]));
        assert!(tree.wanted().is_empty());
        assert_eq!(
            shown(&tree),
            [
                (0, "docs".into()),
                (0, "src".into()),
                (0, "README.md".into())
            ]
        );
        tree.set_expanded("src", true);
        assert_eq!(tree.wanted(), ["src"]);
        assert_eq!(tree.state(&tree.rows()[1]), State::Loading);
        tree.set_listing("src", entries(&["app/", "main.rs"]));
        assert_eq!(tree.state(&tree.rows()[1]), State::Open);
        assert_eq!(
            shown(&tree),
            [
                (0, "docs".into()),
                (0, "src".into()),
                (1, "src/app".into()),
                (1, "src/main.rs".into()),
                (0, "README.md".into())
            ]
        );
        assert_eq!(
            tree.absolute("src/main.rs"),
            PathBuf::from("/demo/src/main.rs")
        );
    }

    #[test]
    fn hidden_files_show_when_asked() {
        let mut tree = sample();
        assert_eq!(tree.position(".env"), None);
        tree.set_show_hidden(true);
        assert_eq!(tree.position(".env"), Some(2));
        assert_eq!(tree.len(), 4);
    }

    #[test]
    fn a_closed_folder_keeps_what_was_open_inside_it() {
        let mut tree = sample();
        tree.set_expanded("src", true);
        tree.set_listing("src", entries(&["app/", "main.rs"]));
        tree.set_expanded("src/app", true);
        tree.set_listing("src/app", entries(&["mod.rs"]));
        assert_eq!(tree.len(), 6);
        assert_eq!(tree.parent(3), Some(2));
        assert_eq!(tree.parent(2), Some(1));
        assert_eq!(tree.parent(1), None);
        tree.set_expanded("src", false);
        assert_eq!(tree.len(), 3);
        assert_eq!(tree.expanded(), ["src/app"]);
        // Only what is on show is read again.
        assert_eq!(tree.listed(), [""]);
        tree.forget_hidden();
        tree.set_expanded("src", true);
        assert_eq!(tree.wanted(), ["src"]);
        tree.set_listing("src", entries(&["app/", "main.rs"]));
        assert_eq!(tree.wanted(), ["src/app"]);
    }

    #[test]
    fn restored_folders_are_asked_for_as_their_parents_arrive() {
        let mut tree = Tree::new(
            PathBuf::from("/demo"),
            false,
            [
                String::from("src/app"),
                String::from("src"),
                String::from("gone"),
            ],
        );
        assert_eq!(tree.wanted(), [""]);
        tree.set_listing("", entries(&["src/", "README.md"]));
        assert_eq!(tree.wanted(), ["src"]);
        tree.set_listing("src", entries(&["app/"]));
        assert_eq!(tree.wanted(), ["src/app"]);
        tree.set_listing("src/app", Err(String::from("permission denied")));
        assert!(tree.wanted().is_empty());
        assert_eq!(tree.state(&tree.rows()[1]), State::Unreadable);
    }

    #[test]
    fn a_folder_that_cannot_be_read_says_why() {
        let mut tree = Tree::new(PathBuf::from("/nowhere"), false, []);
        tree.set_listing("", Err(String::from("No such file or directory")));
        assert!(tree.is_ready());
        assert_eq!(tree.root_error(), Some("No such file or directory"));
        assert!(tree.is_empty());
    }

    #[test]
    fn a_directory_lists_folders_first_without_regard_to_case() {
        let root = std::env::temp_dir().join(format!("krang-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(root.join("Zeta"));
        let _ = std::fs::create_dir_all(root.join("alpha"));
        for name in ["b.md", "A.md", ".hidden"] {
            let _ = std::fs::write(root.join(name), "x");
        }
        let names: Vec<(String, bool)> = list(&root)
            .unwrap_or_default()
            .into_iter()
            .map(|entry| (entry.name, entry.is_dir))
            .collect();
        assert_eq!(
            names,
            [
                ("alpha".into(), true),
                ("Zeta".into(), true),
                (".hidden".into(), false),
                ("A.md".into(), false),
                ("b.md".into(), false)
            ]
        );
        assert!(list(&root.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn fifty_thousand_entries_are_one_pass() {
        let names: Vec<String> = (0..50_000).map(|n| format!("file-{n:05}.txt")).collect();
        let listing = Arc::new(
            names
                .iter()
                .map(|name| Entry {
                    name: name.clone(),
                    is_dir: false,
                })
                .collect::<Vec<_>>(),
        );
        let mut tree = Tree::new(PathBuf::from("/big"), false, []);
        let started = std::time::Instant::now();
        tree.set_listing("", Ok(listing));
        let took = started.elapsed();
        assert_eq!(tree.len(), 50_000);
        assert_eq!(tree.position("file-49999.txt"), Some(49_999));
        // A frame at 60 Hz is 16 ms. This takes well under one in a debug
        // build; the bound is loose so a busy machine does not fail it.
        assert!(took.as_millis() < 100, "{took:?}");
    }
}
