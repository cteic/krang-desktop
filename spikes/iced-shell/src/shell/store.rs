//! Where the workspace is saved between runs.

use std::path::{Path, PathBuf};

use super::layout::{WORKSPACE_VERSION, Workspace};

/// `KRANG_STATE_DIR` when set, so a test run never touches the real state,
/// or else the platform's data folder.
pub fn state_dir() -> Option<PathBuf> {
    std::env::var_os("KRANG_STATE_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|dir| dir.join("ie.cteic.krang-shell")))
}

fn workspace_file(dir: &Path) -> PathBuf {
    dir.join("workspace.json")
}

pub fn load(dir: &Path) -> Option<Workspace> {
    let text = std::fs::read_to_string(workspace_file(dir)).ok()?;
    serde_json::from_str::<Workspace>(&text)
        .ok()
        .filter(|workspace| workspace.version == WORKSPACE_VERSION && !workspace.tabs.is_empty())
}

/// Writes to a temporary file and renames it over the old one, so a crash
/// mid-write leaves the last good workspace in place.
pub fn save(dir: &Path, workspace: &Workspace) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_vec_pretty(workspace).map_err(std::io::Error::other)?;
    let temporary = dir.join("workspace.json.tmp");
    std::fs::write(&temporary, json)?;
    std::fs::rename(temporary, workspace_file(dir))
}

/// The folder of layout files, beside the saved workspace.
pub fn layouts_dir(dir: &Path) -> PathBuf {
    dir.join("layouts")
}

/// A file name for a title: lower case letters and digits, with a dash
/// where anything else was. A title can hold any character, a path cannot.
pub fn slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        String::from("layout")
    } else {
        slug.chars().take(80).collect()
    }
}

/// Writes a layout into the layouts folder under a name made from its
/// title, replacing a layout saved under that name before.
pub fn save_layout(dir: &Path, title: &str, text: &str) -> std::io::Result<PathBuf> {
    let layouts = layouts_dir(dir);
    std::fs::create_dir_all(&layouts)?;
    let file = layouts.join(format!("{}.toml", slug(title)));
    let temporary = file.with_extension("toml.tmp");
    std::fs::write(&temporary, text)?;
    std::fs::rename(temporary, &file)?;
    Ok(file)
}

/// Where a layout named on the command line is: a path as given, or for a
/// bare name such as `review`, that file in the layouts folder.
pub fn resolve_layout(dir: Option<&Path>, given: &Path) -> PathBuf {
    let bare = given.components().count() == 1 && given.extension().is_none();
    match dir {
        Some(dir) if bare && !given.exists() => layouts_dir(dir).join(given).with_extension("toml"),
        _ => given.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::layout::{PaneKind, PaneSpec, TabSpec, Tree};

    #[test]
    fn saves_and_loads_and_refuses_junk() {
        let dir = std::env::temp_dir().join(format!("krang-store-{}", std::process::id()));
        let workspace = Workspace {
            version: WORKSPACE_VERSION,
            tabs: vec![TabSpec {
                title: "t".into(),
                tree: Tree::Pane(PaneSpec {
                    title: None,
                    kind: PaneKind::Web {
                        url: "https://example.org".into(),
                    },
                }),
                named: false,
                focus: Some(0),
                maximized: false,
            }],
            active: 0,
        };
        assert!(save(&dir, &workspace).is_ok());
        assert_eq!(load(&dir), Some(workspace));
        let _ = std::fs::write(workspace_file(&dir), "{not json");
        assert_eq!(load(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_title_becomes_a_safe_file_name() {
        assert_eq!(slug("API review"), "api-review");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug("  Café: notes!  "), "café-notes");
        assert_eq!(slug("///"), "layout");
        assert_eq!(slug(""), "layout");
    }

    #[test]
    fn a_saved_layout_is_found_by_its_name_and_reads_back() {
        use crate::shell::layout::{as_layout, parse_layout, write_layout};

        let dir = std::env::temp_dir().join(format!("krang-layouts-{}", std::process::id()));
        let tab = TabSpec {
            title: "API review".into(),
            named: true,
            tree: Tree::Pane(PaneSpec {
                title: Some("page".into()),
                kind: PaneKind::Web {
                    url: "https://example.org/".into(),
                },
            }),
            focus: Some(0),
            maximized: false,
        };
        let text = write_layout(&tab).unwrap_or_default();
        let file = save_layout(&dir, &tab.title, &text).ok();
        assert_eq!(file, Some(layouts_dir(&dir).join("api-review.toml")));
        let found = resolve_layout(Some(&dir), Path::new("api-review"));
        assert_eq!(Some(&found), file.as_ref());
        let back = std::fs::read_to_string(found)
            .map_err(|error| error.to_string())
            .and_then(|text| parse_layout(&text));
        assert_eq!(back, Ok(as_layout(&tab)));
        // A path is used as given.
        let path = Path::new("bench/quiet.toml");
        assert_eq!(resolve_layout(Some(&dir), path), path);
        let _ = std::fs::remove_dir_all(dir);
    }
}
