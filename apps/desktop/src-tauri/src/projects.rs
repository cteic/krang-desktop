use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::agents::agent_path;

/// The one program this module runs. The window names no program and passes
/// no arguments, so the projects pane cannot be used to run anything else.
const KRANG: &str = "krang";

/// Every issue, open or closed, as JSON. 500 is the most `krang issue ls`
/// returns in one call.
const ISSUE_ARGS: [&str; 6] = ["issue", "ls", "--all", "--json", "--limit", "500"];

fn find_krang(home: Option<&str>, inherited: Option<&str>) -> Option<PathBuf> {
    agent_path(home, inherited)
        .split(':')
        .map(|dir| PathBuf::from(dir).join(KRANG))
        .find(|candidate| candidate.is_file())
}

/// Reads the krang work store's issues as the JSON text `krang issue ls`
/// prints. The pane checks the shape; Rust only runs the command.
#[tauri::command(async)]
pub fn projects_read() -> Result<String, String> {
    read_issues()
}

fn read_issues() -> Result<String, String> {
    let home = std::env::var("HOME").ok();
    let inherited = std::env::var("PATH").ok();
    let krang = find_krang(home.as_deref(), inherited.as_deref())
        .ok_or_else(|| "krang is not installed: no `krang` on the usual paths".to_string())?;
    let output = Command::new(&krang)
        .args(ISSUE_ARGS)
        .env("PATH", agent_path(home.as_deref(), inherited.as_deref()))
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("could not start krang: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("krang issue ls failed: {}", stderr.trim()));
    }
    String::from_utf8(output.stdout).map_err(|_| "krang printed text that is not UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn finds_krang_in_a_home_bin_directory() {
        let home = std::env::temp_dir().join(format!("projects-test-{}", std::process::id()));
        let bin = home.join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        let path = bin.join(KRANG);
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();

        let found = find_krang(home.to_str(), Some(""));
        fs::remove_dir_all(&home).unwrap();

        assert_eq!(found, Some(path));
    }
}
