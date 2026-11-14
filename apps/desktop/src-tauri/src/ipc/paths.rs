//! Where the socket and the tool's link live on disk.

use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub const SOCKET_NAME: &str = "desktop.sock";
/// The name the tool is run by. The link with this name points at the app.
pub const TOOL_NAME: &str = "kd";
const TOOL_DIR: &str = "bin";
/// macOS holds a socket path in 104 bytes, one of them the closing zero.
const SOCKET_PATH_MAX: usize = 103;
const FALLBACK_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

pub fn socket_in(base: &Path) -> PathBuf {
    base.join(SOCKET_NAME)
}

pub fn tool_dir_in(base: &Path) -> PathBuf {
    base.join(TOOL_DIR)
}

fn socket_fits(base: &Path) -> bool {
    socket_in(base).as_os_str().as_bytes().len() <= SOCKET_PATH_MAX
}

/// The first directory whose socket path is short enough to bind.
pub fn choose_base<I>(candidates: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    candidates.into_iter().find(|base| socket_fits(base))
}

/// Makes a directory only its owner can enter. Fails if something else is
/// already there, or if it belongs to someone else.
pub fn make_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    if !fs::symlink_metadata(dir)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} is not a directory", dir.display()),
        ));
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

/// Points `link` at `target`, replacing whatever link was there. The new
/// link is renamed into place, so a pane never finds it missing.
pub fn refresh_link(link: &Path, target: &Path) -> io::Result<()> {
    let staged = link.with_file_name(format!(".{TOOL_NAME}-{}", std::process::id()));
    match fs::remove_file(&staged) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    std::os::unix::fs::symlink(target, &staged)?;
    fs::rename(&staged, link)
}

/// The `PATH` a pane starts with: the tool's directory, then what the app
/// itself was given.
pub fn pane_path(tool_dir: &Path, inherited: Option<&str>) -> String {
    let rest = inherited
        .filter(|path| !path.is_empty())
        .unwrap_or(FALLBACK_PATH);
    format!("{}:{rest}", tool_dir.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::socket::test_support::temp_dir;

    #[test]
    fn a_base_whose_socket_path_is_too_long_is_skipped() {
        let long = PathBuf::from(format!("/{}", "x".repeat(SOCKET_PATH_MAX)));
        let short = PathBuf::from("/tmp/desktop-ipc");
        assert_eq!(
            choose_base([long.clone(), short.clone()]),
            Some(short.clone())
        );
        assert_eq!(choose_base([short.clone(), long.clone()]), Some(short));
        assert_eq!(choose_base([long]), None);
    }

    #[test]
    fn the_limit_counts_the_socket_file_name() {
        let room = SOCKET_PATH_MAX - SOCKET_NAME.len() - 2;
        let fits = PathBuf::from(format!("/{}", "x".repeat(room)));
        let over = PathBuf::from(format!("/{}", "x".repeat(room + 1)));
        assert_eq!(socket_in(&fits).as_os_str().len(), SOCKET_PATH_MAX);
        assert!(socket_fits(&fits));
        assert!(!socket_fits(&over));
    }

    #[test]
    fn a_private_dir_is_closed_to_everyone_else() {
        let parent = temp_dir("private");
        let dir = parent.join("a").join("ipc");
        make_private_dir(&dir).unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        make_private_dir(&dir).unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let file = parent.join("file");
        fs::write(&file, "").unwrap();
        assert!(make_private_dir(&file).is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn the_link_is_replaced_on_every_start() {
        let dir = temp_dir("link");
        let link = dir.join(TOOL_NAME);
        let old = dir.join("old-app");
        let new = dir.join("new-app");

        refresh_link(&link, &old).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), old);
        refresh_link(&link, &new).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), new);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_tool_directory_leads_the_path() {
        let dir = Path::new("/cache/ipc/bin");
        assert_eq!(
            pane_path(dir, Some("/opt/bin:/usr/bin")),
            "/cache/ipc/bin:/opt/bin:/usr/bin"
        );
        assert_eq!(
            pane_path(dir, None),
            "/cache/ipc/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
        assert_eq!(
            pane_path(dir, Some("")),
            "/cache/ipc/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
    }
}
