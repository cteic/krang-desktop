//! An in-memory index of a vault: every note's text, links and tags, and
//! the backlinks they make. Built once when the vault opens and updated per
//! note on save, so a lookup never touches the disk.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use super::{frontmatter, links};

#[derive(Debug, Clone)]
pub struct Note {
    /// Relative to the vault root, with `/` separators.
    pub path: String,
    /// The file name without `.md`: what a wikilink names.
    pub name: String,
    pub text: String,
    /// Link targets, normalised for lookup.
    pub links: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Index {
    pub root: PathBuf,
    notes: BTreeMap<String, Note>,
    /// Normalised name to note paths; several notes may share a name.
    by_name: HashMap<String, Vec<String>>,
    /// Normalised target name to the paths of notes that link to it.
    backlinks: HashMap<String, BTreeSet<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

pub fn normalise(name: &str) -> String {
    let name = name.trim();
    let name = name.strip_suffix(".md").unwrap_or(name);
    // A link may carry a folder; notes are found by file name.
    name.rsplit('/').next().unwrap_or(name).to_lowercase()
}

fn note_name(path: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    file.strip_suffix(".md").unwrap_or(file).to_string()
}

fn read_note(path: String, text: String) -> Note {
    let front = frontmatter::parse(&text);
    let body = &text[front.body_start..];
    let mut tags = front.tags();
    for tag in links::tags(body) {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    let links = links::wikilinks(body)
        .into_iter()
        .filter(|link| !link.embed)
        .map(|link| normalise(&link.target))
        .collect();
    Note {
        name: note_name(&path),
        path,
        text,
        links,
        tags,
    }
}

/// Every `.md` file under `root`, skipping hidden folders such as `.obsidian`
/// and `.git`, and never following a symbolic link.
fn markdown_files(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                found.push(path);
            }
        }
    }
    found
}

pub fn relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

impl Index {
    /// Reads every note. Files are read on all cores, since a large vault
    /// spends most of its open time here.
    pub fn open(root: &Path) -> Self {
        let files = markdown_files(root);
        let workers = std::thread::available_parallelism()
            .map_or(4, usize::from)
            .min(8);
        let chunk = files.len().div_ceil(workers).max(1);
        let notes: Vec<Note> = std::thread::scope(|scope| {
            let handles: Vec<_> = files
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        part.iter()
                            .filter_map(|file| {
                                let text = std::fs::read_to_string(file).ok()?;
                                Some(read_note(relative(root, file)?, text))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|handle| handle.join().unwrap_or_default())
                .collect()
        });
        let mut index = Index {
            root: root.to_path_buf(),
            ..Index::default()
        };
        for note in notes {
            index.insert(note);
        }
        index
    }

    fn insert(&mut self, note: Note) {
        let key = normalise(&note.name);
        self.by_name.entry(key).or_default().push(note.path.clone());
        for target in &note.links {
            self.backlinks
                .entry(target.clone())
                .or_default()
                .insert(note.path.clone());
        }
        self.notes.insert(note.path.clone(), note);
    }

    fn remove(&mut self, path: &str) {
        let Some(note) = self.notes.remove(path) else {
            return;
        };
        if let Some(paths) = self.by_name.get_mut(&normalise(&note.name)) {
            paths.retain(|known| known != path);
        }
        for target in &note.links {
            if let Some(sources) = self.backlinks.get_mut(target) {
                sources.remove(path);
            }
        }
    }

    /// Takes a note's new text, after a save or a change on disk.
    pub fn update(&mut self, path: &str, text: String) {
        self.remove(path);
        self.insert(read_note(path.to_string(), text));
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }

    pub fn note(&self, path: &str) -> Option<&Note> {
        self.notes.get(path)
    }

    pub fn notes(&self) -> impl Iterator<Item = &Note> {
        self.notes.values()
    }

    /// The note a wikilink names. When several share the name, the one
    /// with the shortest path wins, as in Obsidian.
    pub fn resolve(&self, target: &str) -> Option<&Note> {
        let key = normalise(target);
        if let Some(note) = self
            .notes
            .get(target.trim())
            .or_else(|| self.notes.get(&format!("{}.md", target.trim())))
        {
            return Some(note);
        }
        self.by_name
            .get(&key)?
            .iter()
            .min_by_key(|path| (path.matches('/').count(), path.len()))
            .and_then(|path| self.notes.get(path))
    }

    /// The notes that link to `path`, by path.
    pub fn backlinks(&self, path: &str) -> Vec<&Note> {
        let Some(note) = self.notes.get(path) else {
            return Vec::new();
        };
        self.backlinks
            .get(&normalise(&note.name))
            .into_iter()
            .flatten()
            .filter(|source| source.as_str() != path)
            .filter_map(|source| self.notes.get(source))
            .collect()
    }

    /// Every tag in the vault and how many notes carry it.
    pub fn tags(&self) -> Vec<(String, usize)> {
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for note in self.notes.values() {
            for tag in &note.tags {
                *counts.entry(tag).or_default() += 1;
            }
        }
        counts
            .into_iter()
            .map(|(tag, count)| (tag.to_string(), count))
            .collect()
    }

    /// Case-insensitive search over every line of every note. A query that
    /// starts with `#` finds notes carrying that tag.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        if let Some(tag) = query.strip_prefix('#').filter(|tag| !tag.contains(' ')) {
            return self
                .notes
                .values()
                .filter(|note| {
                    note.tags
                        .iter()
                        .any(|known| known.eq_ignore_ascii_case(tag))
                })
                .take(limit)
                .map(|note| SearchHit {
                    path: note.path.clone(),
                    line: 0,
                    text: format!("#{tag}"),
                })
                .collect();
        }
        let needle = query.to_lowercase();
        let ascii = needle.is_ascii();
        let mut hits = Vec::new();
        for note in self.notes.values() {
            // Most notes do not match at all: rule them out with one pass first.
            let matches = if ascii {
                contains_ascii_ci(&note.text, &needle)
            } else {
                note.text.to_lowercase().contains(&needle)
            };
            if !matches {
                continue;
            }
            for (line, text) in note.text.lines().enumerate() {
                let found = if ascii {
                    contains_ascii_ci(text, &needle)
                } else {
                    text.to_lowercase().contains(&needle)
                };
                if found {
                    hits.push(SearchHit {
                        path: note.path.clone(),
                        line,
                        text: text.trim().chars().take(160).collect(),
                    });
                    if hits.len() >= limit {
                        return hits;
                    }
                }
            }
        }
        hits
    }
}

/// ASCII case-insensitive substring test with no allocation. `needle` is lower case.
fn contains_ascii_ci(haystack: &str, needle: &str) -> bool {
    let (hay, needle) = (haystack.as_bytes(), needle.as_bytes());
    if needle.is_empty() {
        return true;
    }
    let first = needle[0];
    let upper = first.to_ascii_uppercase();
    hay.len() >= needle.len()
        && (0..=hay.len() - needle.len()).any(|at| {
            (hay[at] == first || hay[at] == upper)
                && hay[at..at + needle.len()].eq_ignore_ascii_case(needle)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (PathBuf, Index) {
        let root = std::env::temp_dir().join(format!(
            "krang-vault-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        let _ = std::fs::create_dir_all(root.join("sub"));
        let _ = std::fs::create_dir_all(root.join(".obsidian"));
        let write = |path: &str, text: &str| {
            let _ = std::fs::write(root.join(path), text);
        };
        write(
            "Alpha.md",
            "---\ntags: [science]\n---\nLinks to [[Beta]] and [[sub/Gamma|g]]. #draft\n",
        );
        write("Beta.md", "Back to [[alpha]]. The Quick brown fox.\n");
        write("sub/Gamma.md", "Nothing here but `[[Alpha]]` in code.\n");
        write(".obsidian/Hidden.md", "[[Beta]]");
        let index = Index::open(&root);
        (root, index)
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_nanos())
    }

    #[test]
    fn indexes_notes_and_skips_hidden_folders() {
        let (root, index) = vault();
        assert_eq!(index.len(), 3);
        assert_eq!(
            index.resolve("gamma").map(|note| note.path.as_str()),
            Some("sub/Gamma.md")
        );
        assert_eq!(
            index.resolve("sub/Gamma").map(|note| note.path.as_str()),
            Some("sub/Gamma.md")
        );
        assert!(index.resolve("Missing").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backlinks_follow_links_and_ignore_code() {
        let (root, mut index) = vault();
        let names = |index: &Index, path: &str| {
            index
                .backlinks(path)
                .iter()
                .map(|note| note.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&index, "Beta.md"), ["Alpha"]);
        assert_eq!(names(&index, "Alpha.md"), ["Beta"]);
        assert_eq!(names(&index, "sub/Gamma.md"), ["Alpha"]);

        index.update("Alpha.md", "No links now".into());
        assert!(names(&index, "Beta.md").is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn searches_text_and_tags() {
        let (root, index) = vault();
        let hits = index.search("quick BROWN", 10);
        assert_eq!(
            hits,
            [SearchHit {
                path: "Beta.md".into(),
                line: 0,
                text: "Back to [[alpha]]. The Quick brown fox.".into()
            }]
        );
        let tagged: Vec<String> = index
            .search("#science", 10)
            .into_iter()
            .map(|hit| hit.path)
            .collect();
        assert_eq!(tagged, ["Alpha.md"]);
        assert_eq!(index.tags(), [("draft".into(), 1), ("science".into(), 1)]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ascii_case_insensitive_search() {
        assert!(contains_ascii_ci("Hello World", "world"));
        assert!(!contains_ascii_ci("Hello", "hello!"));
        assert!(contains_ascii_ci("x", ""));
    }
}
