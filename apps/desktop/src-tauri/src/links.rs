use std::path::{Path, PathBuf};

use tauri::Url;

const LAYOUT_HOST: &str = "layout";
const MAX_NAME_LENGTH: usize = 100;

/// A layout name is a file stem, never a path. Letters, digits, `-`, `_` and
/// `.` only, and no leading dot, so a link cannot walk out of the layout
/// directories or reach a hidden file.
pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LENGTH
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Reads the layout name out of a link of the form `<scheme>://layout/<name>`.
pub fn layout_name_from_url(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    if url.host_str() != Some(LAYOUT_HOST) {
        return None;
    }
    let mut segments = url.path_segments()?;
    let name = segments.next()?;
    if segments.next().is_some() || !is_safe_name(name) {
        return None;
    }
    Some(name.to_string())
}

/// Finds `<name>.toml` in the first directory that has it.
pub fn resolve_layout(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if !is_safe_name(name) {
        return None;
    }
    dirs.iter()
        .map(|dir| dir.join(format!("{name}.toml")))
        .find(|path| Path::is_file(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_the_name_from_a_layout_link() {
        assert_eq!(
            layout_name_from_url("app://layout/cockpit-krang").as_deref(),
            Some("cockpit-krang")
        );
    }

    #[test]
    fn rejects_other_hosts_and_shapes() {
        assert_eq!(layout_name_from_url("app://other/cockpit"), None);
        assert_eq!(layout_name_from_url("app://layout/"), None);
        assert_eq!(layout_name_from_url("app://layout"), None);
        assert_eq!(layout_name_from_url("app://layout/a/b"), None);
        assert_eq!(layout_name_from_url("not a url"), None);
    }

    #[test]
    fn rejects_names_that_could_leave_the_directory() {
        assert_eq!(layout_name_from_url("app://layout/..%2F..%2Fetc"), None);
        assert_eq!(layout_name_from_url("app://layout/.hidden"), None);
        assert!(!is_safe_name("../secret"));
        assert!(!is_safe_name("a/b"));
        assert!(!is_safe_name(""));
        assert!(!is_safe_name(&"x".repeat(101)));
        assert!(is_safe_name("cockpit-pr_review.v2"));
    }

    #[test]
    fn resolves_in_directory_order() {
        let base = std::env::temp_dir().join(format!("layout-resolve-{}", std::process::id()));
        let first = base.join("first");
        let second = base.join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("only-second.toml"), "").unwrap();
        fs::write(first.join("both.toml"), "").unwrap();
        fs::write(second.join("both.toml"), "").unwrap();
        let dirs = vec![first.clone(), second.clone()];

        assert_eq!(resolve_layout("both", &dirs), Some(first.join("both.toml")));
        assert_eq!(
            resolve_layout("only-second", &dirs),
            Some(second.join("only-second.toml"))
        );
        assert_eq!(resolve_layout("missing", &dirs), None);
        assert_eq!(resolve_layout("../both", &dirs), None);

        fs::remove_dir_all(&base).unwrap();
    }
}
