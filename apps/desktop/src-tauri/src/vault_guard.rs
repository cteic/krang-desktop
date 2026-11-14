//! Keeps every read and write of a vault's files inside the vault.
//!
//! A vault may be a directory someone downloaded, so a link in it is not
//! trusted to lead somewhere safe. A path is used only when, with its links
//! followed, it is still under the vault's own directory, and the file or
//! folder that is read or written is never itself a link.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
}

fn link_refused(path: &Path) -> String {
    format!(
        "{} is a symbolic link, and nothing in a vault is read or written through a link",
        path.display()
    )
}

fn outside(root: &Path, path: &Path) -> String {
    format!(
        "{} leads outside the vault at {}",
        path.display(),
        root.display()
    )
}

/// The real path of `path`, which must be inside the vault at `root`.
/// `root` is the vault's directory with its links already followed.
///
/// The path may name something that does not exist yet. The part of it
/// that exists has its links followed and must end up under `root`. The
/// last part must not be a link.
pub fn inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if is_link(path) {
        return Err(link_refused(path));
    }
    let existing = path
        .ancestors()
        .find(|ancestor| fs::symlink_metadata(ancestor).is_ok())
        .ok_or_else(|| outside(root, path))?;
    let real = fs::canonicalize(existing).map_err(|_| outside(root, path))?;
    if !real.starts_with(root) {
        return Err(outside(root, path));
    }
    let rest = path
        .strip_prefix(existing)
        .map_err(|_| outside(root, path))?;
    if !rest
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(outside(root, path));
    }
    // Joining an empty rest would add a trailing separator.
    if rest.as_os_str().is_empty() {
        Ok(real)
    } else {
        Ok(real.join(rest))
    }
}

/// The real path of a file inside the vault. The file may be missing. When
/// it exists it must be a regular file.
pub fn file_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let real = inside(root, path)?;
    match fs::symlink_metadata(&real) {
        Ok(metadata) if !metadata.is_file() => {
            Err(format!("{} is not a regular file", path.display()))
        }
        _ => Ok(real),
    }
}

/// Makes a directory inside the vault, with any missing directories above
/// it, and returns its real path. The check is made before anything is
/// created and again after, so a link put in the way meanwhile is seen.
pub fn create_dir_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let real = inside(root, path)?;
    fs::create_dir_all(&real).map_err(|error| format!("{}: {error}", path.display()))?;
    let made = fs::canonicalize(&real).map_err(|error| format!("{}: {error}", path.display()))?;
    if made != real || is_link(&real) || !real.is_dir() {
        return Err(outside(root, path));
    }
    Ok(real)
}

/// Opens a regular file for reading. A link is not followed, and a pipe or
/// a device is refused without waiting on it.
pub fn open_regular(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    Ok(file)
}

/// Creates a file that must not exist yet, for writing. A link at that
/// name is not followed.
pub fn create_new(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
}

/// Reads a whole file inside the vault unless it is over `limit` bytes.
/// A missing file is `None`.
pub fn read_inside(root: &Path, path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let real = file_inside(root, path)?;
    let file = match open_regular(&real) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let too_big = |size: u64| {
        format!(
            "{} is {size} bytes, over the {limit} byte limit",
            path.display()
        )
    };
    let size = file
        .metadata()
        .map_err(|error| format!("{}: {error}", path.display()))?
        .len();
    if size > limit {
        return Err(too_big(size));
    }
    // The file may grow after its size is read, so the read is capped too.
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let read = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if read > limit {
        return Err(too_big(read));
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("guard-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn a_path_is_used_only_when_it_stays_inside_the_vault() {
        let base = scratch("inside");
        let (root, far) = (base.join("vault"), base.join("far"));
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::create_dir_all(far.join("deep")).unwrap();
        fs::write(root.join("notes/a.md"), "a").unwrap();
        fs::write(far.join("secret.md"), "s").unwrap();

        assert_eq!(inside(&root, &root), Ok(root.clone()));
        assert_eq!(
            inside(&root, &root.join("notes/a.md")),
            Ok(root.join("notes/a.md"))
        );
        // Something that does not exist yet, under folders that do not either.
        assert_eq!(
            inside(&root, &root.join("new/deeper/b.md")),
            Ok(root.join("new/deeper/b.md"))
        );
        for escape in [far.join("secret.md"), root.join("notes/../../far/x.md")] {
            let error = inside(&root, &escape).unwrap_err();
            assert!(error.contains("outside the vault"), "{error}");
        }
        assert!(inside(&root, &root.join("new/../../far/x.md")).is_err());

        // A linked folder is followed, and judged by where it leads.
        symlink(&far, root.join("out")).unwrap();
        symlink(root.join("notes"), root.join("alias")).unwrap();
        symlink(root.join("gone"), root.join("dangling")).unwrap();
        for escape in ["out/secret.md", "out/deep/new.md", "out/new/x.md"] {
            let error = inside(&root, &root.join(escape)).unwrap_err();
            assert!(error.contains("outside the vault"), "{escape}: {error}");
        }
        assert!(inside(&root, &root.join("dangling/x.md")).is_err());
        assert_eq!(
            inside(&root, &root.join("alias/a.md")),
            Ok(root.join("notes/a.md"))
        );
        assert_eq!(
            inside(&root, &root.join("alias/new.md")),
            Ok(root.join("notes/new.md"))
        );
        // The last part is never a link, wherever it leads.
        symlink(root.join("notes/a.md"), root.join("notes/link.md")).unwrap();
        for refused in ["out", "alias", "dangling", "notes/link.md"] {
            let error = inside(&root, &root.join(refused)).unwrap_err();
            assert!(error.contains("symbolic link"), "{refused}: {error}");
        }
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_directory_is_made_only_inside_the_vault() {
        let base = scratch("mkdir");
        let (root, far) = (base.join("vault"), base.join("far"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&far).unwrap();
        symlink(&far, root.join("out")).unwrap();

        assert_eq!(
            create_dir_inside(&root, &root.join("a/b")),
            Ok(root.join("a/b"))
        );
        assert!(root.join("a/b").is_dir());
        assert_eq!(
            create_dir_inside(&root, &root.join("a")),
            Ok(root.join("a"))
        );
        assert!(create_dir_inside(&root, &root.join("out/planted/deep")).is_err());
        assert!(create_dir_inside(&root, &root.join("out")).is_err());
        assert_eq!(fs::read_dir(&far).unwrap().count(), 0);
        fs::write(root.join("file"), "x").unwrap();
        assert!(create_dir_inside(&root, &root.join("file")).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn only_a_regular_file_of_a_fair_size_is_read() {
        let base = scratch("read");
        let (root, far) = (base.join("vault"), base.join("far"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&far).unwrap();
        fs::write(root.join("a.md"), "12345").unwrap();
        fs::write(far.join("secret.md"), "s").unwrap();
        symlink(far.join("secret.md"), root.join("link.md")).unwrap();

        assert_eq!(
            read_inside(&root, &root.join("a.md"), 5),
            Ok(Some(b"12345".to_vec()))
        );
        assert_eq!(read_inside(&root, &root.join("none.md"), 5), Ok(None));
        let big = read_inside(&root, &root.join("a.md"), 4).unwrap_err();
        assert!(big.ends_with("is 5 bytes, over the 4 byte limit"), "{big}");
        assert!(read_inside(&root, &root.join("link.md"), 5)
            .unwrap_err()
            .contains("symbolic link"));
        assert!(read_inside(&root, &far.join("secret.md"), 5)
            .unwrap_err()
            .contains("outside the vault"));
        assert!(read_inside(&root, &root, 5)
            .unwrap_err()
            .ends_with("is not a regular file"));

        // A pipe is refused at once. Opening one to read would wait for ever.
        let pipe = root.join("pipe");
        let name = std::ffi::CString::new(pipe.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: `name` is a valid C string that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_inside(&root, &pipe, 5)
            .unwrap_err()
            .ends_with("is not a regular file"));
        assert!(open_regular(&pipe).is_err());
        assert!(open_regular(&root.join("link.md")).is_err());

        symlink(far.join("new.md"), root.join("new.md")).unwrap();
        assert!(create_new(&root.join("new.md")).is_err());
        assert!(!far.join("new.md").exists());
        fs::remove_dir_all(base).unwrap();
    }
}
