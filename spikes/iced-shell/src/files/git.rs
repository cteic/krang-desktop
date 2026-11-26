//! What git says has changed under a folder, read with one `git status`.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};

/// How a path differs from the last commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflict,
}

impl Change {
    /// The letter `git status` uses.
    pub fn letter(self) -> &'static str {
        match self {
            Change::Modified => "M",
            Change::Added => "A",
            Change::Deleted => "D",
            Change::Renamed => "R",
            Change::Untracked => "?",
            Change::Conflict => "U",
        }
    }

    fn of(index: u8, worktree: u8) -> Option<Self> {
        Some(match (index, worktree) {
            (b'?', _) => Change::Untracked,
            (b'!', _) => return None,
            (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => Change::Conflict,
            (_, b'M') | (b'M', _) | (_, b'T') | (b'T', _) => Change::Modified,
            (_, b'D') | (b'D', _) => Change::Deleted,
            (b'R', _) | (_, b'R') | (b'C', _) | (_, b'C') => Change::Renamed,
            (b'A', _) | (_, b'A') => Change::Added,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    /// Changed paths, relative to the folder, with `/` between parts.
    changes: HashMap<String, Change>,
    /// Folders that hold a change somewhere inside.
    holding: HashSet<String>,
}

impl Status {
    /// Reads the output of `git status --porcelain=v1 -z`. Its paths start
    /// at the repository's top; `prefix` is the folder's place under it, as
    /// `git rev-parse --show-prefix` prints it, and is cut off.
    pub fn parse(output: &[u8], prefix: &str) -> Self {
        let mut status = Self::default();
        let mut records = output.split(|byte| *byte == 0);
        while let Some(record) = records.next() {
            if record.len() < 4 || record[2] != b' ' {
                continue;
            }
            let (index, worktree) = (record[0], record[1]);
            if index == b'R' || index == b'C' {
                // The path it was renamed or copied from follows.
                let _ = records.next();
            }
            let Some(change) = Change::of(index, worktree) else {
                continue;
            };
            let path = String::from_utf8_lossy(&record[3..]);
            let Some(path) = path.strip_prefix(prefix) else {
                continue;
            };
            let path = path.trim_end_matches('/');
            if path.is_empty() {
                continue;
            }
            let mut folder = path;
            while let Some((parent, _)) = folder.rsplit_once('/') {
                status.holding.insert(parent.to_string());
                folder = parent;
            }
            status.changes.insert(path.to_string(), change);
        }
        status
    }

    pub fn change(&self, path: &str) -> Option<Change> {
        self.changes.get(path).copied()
    }

    /// Whether a folder holds a change somewhere inside.
    pub fn holds(&self, folder: &str) -> bool {
        self.holding.contains(folder)
    }

    pub fn len(&self) -> usize {
        self.changes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

fn git(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        // Never take the index lock: a refresh must not get in the way of
        // a command the person is running.
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

/// Runs git for a folder. `None` when the folder is in no repository or
/// there is no git. This blocks, so it runs off the window's thread.
pub fn read(root: &Path) -> Option<Status> {
    let prefix = git(root, &["rev-parse", "--show-prefix"])?;
    let prefix = String::from_utf8_lossy(&prefix);
    let output = git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--",
            ".",
        ],
    )?;
    Some(Status::parse(&output, prefix.trim_end_matches('\n')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_porcelain_records() {
        let output = b" M src/main.rs\0?? notes/\0A  new.txt\0R  src/b.rs\0src/a.rs\0 D gone.md\0UU both.md\0!! target/\0";
        let status = Status::parse(output, "");
        assert_eq!(status.change("src/main.rs"), Some(Change::Modified));
        assert_eq!(status.change("notes"), Some(Change::Untracked));
        assert_eq!(status.change("new.txt"), Some(Change::Added));
        assert_eq!(status.change("src/b.rs"), Some(Change::Renamed));
        assert_eq!(status.change("src/a.rs"), None);
        assert_eq!(status.change("gone.md"), Some(Change::Deleted));
        assert_eq!(status.change("both.md"), Some(Change::Conflict));
        assert_eq!(status.change("target"), None);
        assert!(status.holds("src"));
        assert!(!status.holds("notes"));
        assert_eq!(status.len(), 6);
    }

    #[test]
    fn paths_are_cut_to_the_folder() {
        let output = b" M apps/web/src/deep/page.tsx\0 M apps/api/main.rs\0";
        let status = Status::parse(output, "apps/web/");
        assert_eq!(status.change("src/deep/page.tsx"), Some(Change::Modified));
        assert!(status.holds("src") && status.holds("src/deep"));
        assert_eq!(status.len(), 1);
    }

    #[test]
    fn junk_is_skipped() {
        assert!(Status::parse(b"", "").is_empty());
        assert!(Status::parse(b"\0\0x\0garbage here\0", "").is_empty());
    }

    #[test]
    fn a_real_repository_reports_its_changes() {
        let root = std::env::temp_dir().join(format!("krang-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(root.join("sub"));
        let run = |args: &[&str]| {
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        };
        if !run(&["init", "-q"]) {
            // No git on this machine: nothing to check.
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        let _ = std::fs::write(root.join("kept.md"), "one");
        let _ = std::fs::write(root.join("sub/inner.md"), "one");
        assert!(run(&["add", "."]));
        assert!(run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.org",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "-m",
            "first"
        ]));
        let _ = std::fs::write(root.join("sub/inner.md"), "two");
        let _ = std::fs::write(root.join("new.md"), "new");
        let status = read(&root);
        assert_eq!(
            status
                .as_ref()
                .and_then(|status| status.change("sub/inner.md")),
            Some(Change::Modified)
        );
        assert_eq!(
            status.as_ref().and_then(|status| status.change("new.md")),
            Some(Change::Untracked)
        );
        // From inside a subfolder the paths start there.
        let inner = read(&root.join("sub"));
        assert_eq!(
            inner.and_then(|status| status.change("inner.md")),
            Some(Change::Modified)
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
