use std::fs;
use std::io;
use std::path::Path;

/// Where the person's own zsh startup files live. Our wrapper files read it.
pub const USER_ZDOTDIR_ENV: &str = "DESKTOP_USER_ZDOTDIR";
/// The directory holding the pane tool. Our wrapper files put it on PATH.
pub const TOOL_DIR_ENV: &str = "DESKTOP_CLI_DIR";

// A pane's shell is a login shell, and a login profile is free to rebuild
// PATH from scratch. Setting PATH before the shell starts therefore proves
// nothing. Instead zsh is pointed at a directory of four small startup files.
// Each one loads the person's own file of the same name, and the last one
// adds the tool directory to PATH after everything else has run, then hands
// ZDOTDIR back so anything started later sees the person's own setting.

const SOURCE_USER_FILE: &str = r#"_desktop_app_zdotdir="$ZDOTDIR"
ZDOTDIR="${DESKTOP_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/@FILE@" ]] && source "$ZDOTDIR/@FILE@"
"#;

const KEEP_WRAPPING: &str = r#"DESKTOP_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$_desktop_app_zdotdir"
unset _desktop_app_zdotdir
"#;

const ADD_TOOL_TO_PATH: &str = r#"if [[ -n "$DESKTOP_CLI_DIR" && ":$PATH:" != *":$DESKTOP_CLI_DIR:"* ]]; then
  PATH="$DESKTOP_CLI_DIR:$PATH"
fi
"#;

const STOP_WRAPPING: &str = r#"if [[ "$ZDOTDIR" == "$HOME" ]]; then
  unset ZDOTDIR
fi
unset _desktop_app_zdotdir
"#;

// The system zshrc runs between our files and names the history file after
// ZDOTDIR, which at that moment is our directory. Point it back before the
// person's own zshrc runs, so their setting still wins.
const FIX_HISTORY_FILE: &str = r#"if [[ -n "$HISTFILE" && "$HISTFILE" == "$ZDOTDIR/"* ]]; then
  HISTFILE="${DESKTOP_USER_ZDOTDIR:-$HOME}/${HISTFILE:t}"
fi
"#;

fn source_user(file: &str) -> String {
    SOURCE_USER_FILE.replace("@FILE@", file)
}

/// The text of one wrapper file. `.zlogin` is the last file a login shell
/// reads, so that is where wrapping ends. A shell that is not a login shell
/// ends at `.zshrc`.
pub fn wrapper_text(file: &str) -> String {
    match file {
        ".zshrc" => format!(
            "{FIX_HISTORY_FILE}{}{ADD_TOOL_TO_PATH}if [[ -o login ]]; then\n{KEEP_WRAPPING}else\n{STOP_WRAPPING}fi\n",
            source_user(file)
        ),
        ".zlogin" => format!("{}{ADD_TOOL_TO_PATH}{STOP_WRAPPING}", source_user(file)),
        _ => format!("{}{KEEP_WRAPPING}", source_user(file)),
    }
}

pub const WRAPPER_FILES: [&str; 4] = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];

pub fn write_zsh_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    for file in WRAPPER_FILES {
        fs::write(dir.join(file), wrapper_text(file))?;
    }
    Ok(())
}

pub fn is_zsh(shell: &str) -> bool {
    Path::new(shell)
        .file_name()
        .is_some_and(|name| name == "zsh")
}

/// The environment that makes zsh read the wrapper files.
pub fn zsh_env(
    zsh_dir: &Path,
    tool_dir: &Path,
    user_zdotdir: Option<&str>,
    home: Option<&str>,
) -> Vec<(String, String)> {
    let mut env = vec![
        (
            String::from("ZDOTDIR"),
            zsh_dir.to_string_lossy().into_owned(),
        ),
        (
            String::from(TOOL_DIR_ENV),
            tool_dir.to_string_lossy().into_owned(),
        ),
    ];
    if let Some(user) = user_zdotdir.filter(|dir| !dir.is_empty()).or(home) {
        env.push((String::from(USER_ZDOTDIR_ENV), user.to_string()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shell-env-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognises_zsh_by_file_name() {
        assert!(is_zsh("/bin/zsh"));
        assert!(is_zsh("/opt/homebrew/bin/zsh"));
        assert!(!is_zsh("/bin/bash"));
        assert!(!is_zsh("/usr/local/bin/fish"));
    }

    #[test]
    fn the_user_directory_falls_back_to_home() {
        let env = zsh_env(
            Path::new("/app/zsh"),
            Path::new("/app/bin"),
            None,
            Some("/Users/x"),
        );
        assert!(env.contains(&(String::from("ZDOTDIR"), String::from("/app/zsh"))));
        assert!(env.contains(&(String::from(TOOL_DIR_ENV), String::from("/app/bin"))));
        assert!(env.contains(&(String::from(USER_ZDOTDIR_ENV), String::from("/Users/x"))));

        let custom = zsh_env(
            Path::new("/a"),
            Path::new("/b"),
            Some("/Users/x/.zsh"),
            Some("/Users/x"),
        );
        assert!(custom.contains(&(
            String::from(USER_ZDOTDIR_ENV),
            String::from("/Users/x/.zsh")
        )));
    }

    /// Runs a real login, interactive zsh against a made-up home whose
    /// startup files do what real ones do: replace PATH outright.
    #[test]
    fn the_tool_stays_on_path_even_when_the_profile_replaces_path() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let base = scratch("zsh");
        let home = base.join("home");
        let wrapper = base.join("zsh");
        let tool_dir = base.join("bin");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&tool_dir).unwrap();
        fs::write(home.join(".zshenv"), "export FROM_ZSHENV=1\n").unwrap();
        fs::write(home.join(".zprofile"), "export FROM_ZPROFILE=1\n").unwrap();
        fs::write(
            home.join(".zshrc"),
            "export PATH=/usr/bin:/bin\nexport FROM_ZSHRC=1\n",
        )
        .unwrap();
        fs::write(home.join(".zlogin"), "export FROM_ZLOGIN=1\n").unwrap();
        write_zsh_dir(&wrapper).unwrap();

        let output = Command::new("/bin/zsh")
            .args([
                "-l",
                "-i",
                "-c",
                "print -r -- \"PATH=$PATH\"; print -r -- \"ZDOTDIR=${ZDOTDIR-unset}\"; \
                 print -r -- \"HISTFILE=$HISTFILE\"; \
                 print -r -- \"FILES=$FROM_ZSHENV$FROM_ZPROFILE$FROM_ZSHRC$FROM_ZLOGIN\"",
            ])
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .envs(zsh_env(&wrapper, &tool_dir, None, home.to_str()))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);

        let path_line = text
            .lines()
            .find(|line| line.starts_with("PATH="))
            .unwrap_or("");
        assert!(
            path_line.starts_with(&format!("PATH={}:", tool_dir.display())),
            "tool directory is not first on PATH: {text}"
        );
        assert!(
            text.contains("FILES=1111"),
            "a user file was skipped: {text}"
        );
        assert!(
            text.contains("ZDOTDIR=unset"),
            "ZDOTDIR was not handed back: {text}"
        );
        assert!(
            !text.contains(&format!("HISTFILE={}", wrapper.display())),
            "history would be written into the wrapper directory: {text}"
        );

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_custom_user_zdotdir_is_restored() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let base = scratch("custom");
        let home = base.join("home");
        let user = home.join(".config/zsh");
        let wrapper = base.join("zsh");
        let tool_dir = base.join("bin");
        fs::create_dir_all(&user).unwrap();
        fs::create_dir_all(&tool_dir).unwrap();
        fs::write(user.join(".zshrc"), "export FROM_CUSTOM=1\n").unwrap();
        write_zsh_dir(&wrapper).unwrap();

        let output = Command::new("/bin/zsh")
            .args([
                "-l",
                "-i",
                "-c",
                "print -r -- \"Z=$ZDOTDIR C=$FROM_CUSTOM\"",
            ])
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .envs(zsh_env(&wrapper, &tool_dir, user.to_str(), home.to_str()))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);

        assert!(
            text.contains(&format!("Z={} C=1", user.display())),
            "custom ZDOTDIR was not used and restored: {text}"
        );

        fs::remove_dir_all(&base).unwrap();
    }
}
