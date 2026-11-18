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
                tree: Tree::Pane(PaneSpec { title: None, kind: PaneKind::Web { url: "https://example.org".into() } }),
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
}
