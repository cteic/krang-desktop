//! What kind of file a name is, and which pane opens it.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Markdown,
    Web,
    Code,
    Data,
    Image,
    Text,
    Other,
}

/// The pane a file opens in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opens {
    /// The editor, with Markdown tools for a note and as plain text for
    /// anything else.
    Editor,
    Web,
}

fn extension(name: &str) -> Option<String> {
    let (stem, extension) = name.rsplit_once('.')?;
    (!stem.is_empty()).then(|| extension.to_lowercase())
}

impl Kind {
    pub fn of(name: &str) -> Self {
        let Some(extension) = extension(name) else {
            return Kind::Other;
        };
        match extension.as_str() {
            "md" | "markdown" | "mdx" => Kind::Markdown,
            "html" | "htm" => Kind::Web,
            "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rb" | "go" | "c" | "h"
            | "cc" | "cpp" | "hpp" | "java" | "kt" | "swift" | "sh" | "zsh" | "bash" | "fish"
            | "css" | "scss" | "sql" | "lua" | "php" | "zig" | "ex" | "exs" | "vue" | "svelte" => {
                Kind::Code
            }
            "json" | "toml" | "yaml" | "yml" | "xml" | "csv" | "tsv" | "ini" | "env" | "lock"
            | "plist" => Kind::Data,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "tiff" | "heic" => {
                Kind::Image
            }
            "txt" | "log" | "text" | "rst" | "org" => Kind::Text,
            _ => Kind::Other,
        }
    }

    /// The short marker drawn in front of the name.
    pub fn tag(self) -> &'static str {
        match self {
            Kind::Markdown => "md",
            Kind::Web => "web",
            Kind::Code => "src",
            Kind::Data => "cfg",
            Kind::Image => "img",
            Kind::Text => "txt",
            Kind::Other => "",
        }
    }

    pub fn opens(self) -> Opens {
        match self {
            Kind::Web => Opens::Web,
            _ => Opens::Editor,
        }
    }
}

/// The name the syntax highlighter knows a file's language by. A Markdown
/// note is `md`; a name with no extension is plain text.
pub fn syntax(name: &str) -> String {
    match Kind::of(name) {
        Kind::Markdown => String::from("md"),
        _ => extension(name).unwrap_or_else(|| String::from("txt")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_opens_by_its_type() {
        assert_eq!(Kind::of("README.md").opens(), Opens::Editor);
        assert_eq!(Kind::of("notes.MARKDOWN"), Kind::Markdown);
        assert_eq!(Kind::of("index.html").opens(), Opens::Web);
        assert_eq!(Kind::of("page.HTM").opens(), Opens::Web);
        assert_eq!(Kind::of("main.rs").opens(), Opens::Editor);
        assert_eq!(Kind::of("Makefile").opens(), Opens::Editor);
        assert_eq!(Kind::of("photo.png").opens(), Opens::Editor);
    }

    #[test]
    fn a_dot_file_has_no_extension() {
        assert_eq!(Kind::of(".html"), Kind::Other);
        assert_eq!(Kind::of(".gitignore"), Kind::Other);
        assert_eq!(Kind::of("archive.tar.gz"), Kind::Other);
        assert_eq!(Kind::of("Cargo.lock"), Kind::Data);
    }

    #[test]
    fn the_highlighter_is_told_the_extension() {
        assert_eq!(syntax("a/b/Note.md"), "md");
        assert_eq!(syntax("main.RS"), "rs");
        assert_eq!(syntax("Makefile"), "txt");
    }
}
