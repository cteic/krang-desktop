//! YAML frontmatter: the block between `---` lines at the top of a note.
//!
//! Only what the properties panel shows is read: top-level keys with a
//! plain value or a list. The text itself is never rebuilt from what was
//! read, so a field this does not understand keeps every byte on save. An
//! edit to one scalar field replaces that one line and nothing else.

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Text(String),
    List(Vec<String>),
    /// Anything else, such as a nested map or a block string, shown raw.
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Property {
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Frontmatter {
    pub properties: Vec<Property>,
    /// The byte offset where the body starts, after the closing `---` line.
    pub body_start: usize,
}

/// The frontmatter block's inner lines and where the body starts.
fn block(text: &str) -> Option<(&str, usize, usize)> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let open = text.len() - rest.len();
    let mut offset = open;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((&text[open..offset], open, offset + line.len()));
        }
        offset += line.len();
    }
    None
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}

fn inline_list(value: &str) -> Option<Vec<String>> {
    let inner = value.trim().strip_prefix('[')?.strip_suffix(']')?;
    Some(
        inner
            .split(',')
            .map(unquote)
            .filter(|item| !item.is_empty())
            .collect(),
    )
}

pub fn parse(text: &str) -> Frontmatter {
    let Some((inner, _, body_start)) = block(text) else {
        return Frontmatter::default();
    };
    let lines: Vec<&str> = inner.lines().collect();
    let mut properties = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.starts_with([' ', '\t', '#', '-']) || line.trim().is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let nested: Vec<&str> = lines[index..]
            .iter()
            .take_while(|next| next.starts_with([' ', '\t']) || next.starts_with("- "))
            .copied()
            .collect();
        index += nested.len();
        let value = value.trim();
        let parsed = if value.is_empty() && !nested.is_empty() {
            let items: Option<Vec<String>> = nested
                .iter()
                .map(|item| item.trim().strip_prefix("- ").map(unquote))
                .collect();
            items.map_or_else(|| Value::Other(nested.join("\n")), Value::List)
        } else if let Some(items) = inline_list(value) {
            Value::List(items)
        } else if matches!(value, "|" | ">" | "|-" | ">-") || value.starts_with('{') {
            Value::Other(
                [value]
                    .into_iter()
                    .chain(nested)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        } else {
            Value::Text(unquote(value))
        };
        properties.push(Property {
            key: key.trim().to_string(),
            value: parsed,
        });
    }
    Frontmatter {
        properties,
        body_start,
    }
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.properties
            .iter()
            .find(|property| property.key == key)
            .map(|property| &property.value)
    }

    /// Tags listed in the `tags` (or `tag`) field.
    pub fn tags(&self) -> Vec<String> {
        let value = self.get("tags").or_else(|| self.get("tag"));
        match value {
            Some(Value::List(items)) => items
                .iter()
                .map(|tag| tag.trim_start_matches('#').to_string())
                .collect(),
            Some(Value::Text(text)) => text
                .split([',', ' '])
                .map(|tag| tag.trim().trim_start_matches('#'))
                .filter(|tag| !tag.is_empty())
                .map(String::from)
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// Sets one scalar field. The key's own line is replaced and every other
/// byte stays as it was; a missing key is added at the end of the block, and
/// a note with no frontmatter gets one. Returns `None` for a key whose value
/// spans lines, which this does not rewrite.
pub fn set_text(text: &str, key: &str, value: &str) -> Option<String> {
    let needs_quotes = value.is_empty()
        || value.contains([':', '#', '\'', '"', '[', ']', '{', '}'])
        || value != value.trim();
    let rendered = if needs_quotes {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    };
    let Some((inner, open, _)) = block(text) else {
        return Some(format!("---\n{key}: {rendered}\n---\n{text}"));
    };
    let mut offset = open;
    let lines: Vec<&str> = inner.split_inclusive('\n').collect();
    for (index, line) in lines.iter().enumerate() {
        if let Some((found, current)) = line.split_once(':')
            && found == key
        {
            let multi_line = current.trim().is_empty()
                && lines
                    .get(index + 1)
                    .is_some_and(|next| next.starts_with([' ', '\t']) || next.starts_with("- "));
            if multi_line || matches!(current.trim(), "|" | ">" | "|-" | ">-") {
                return None;
            }
            let ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            let mut out = String::with_capacity(text.len() + value.len());
            out.push_str(&text[..offset]);
            out.push_str(&format!("{key}: {rendered}{ending}"));
            out.push_str(&text[offset + line.len()..]);
            return Some(out);
        }
        offset += line.len();
    }
    let mut out = String::with_capacity(text.len() + key.len() + value.len() + 4);
    out.push_str(&text[..offset]);
    out.push_str(&format!("{key}: {rendered}\n"));
    out.push_str(&text[offset..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "---\ntitle: \"Lab note\"\ntags: [bread, \"#proof\"]\naliases:\n  - Loaf\n  - Sourdough\nnodeInstanceId: 019a-xx\nweird: {a: 1, b: [2]}\nblock: |\n  line one\n  line two\n---\n# Body\n";

    #[test]
    fn reads_scalars_lists_and_leaves_the_rest_raw() {
        let front = parse(NOTE);
        assert_eq!(front.get("title"), Some(&Value::Text("Lab note".into())));
        assert_eq!(
            front.get("aliases"),
            Some(&Value::List(vec!["Loaf".into(), "Sourdough".into()]))
        );
        assert_eq!(front.tags(), ["bread", "proof"]);
        assert!(matches!(front.get("weird"), Some(Value::Other(_))));
        assert_eq!(
            front.get("block"),
            Some(&Value::Other("|\n  line one\n  line two".into()))
        );
        assert_eq!(&NOTE[front.body_start..], "# Body\n");
    }

    #[test]
    fn setting_one_field_keeps_every_other_byte() {
        let edited = set_text(NOTE, "title", "New: title").unwrap_or_default();
        assert_eq!(
            edited,
            NOTE.replace("title: \"Lab note\"", "title: \"New: title\"")
        );
        let added = set_text(NOTE, "status", "draft").unwrap_or_default();
        assert_eq!(
            added,
            NOTE.replace("---\n# Body", "status: draft\n---\n# Body")
        );
    }

    #[test]
    fn a_multi_line_field_is_not_rewritten() {
        assert_eq!(set_text(NOTE, "aliases", "x"), None);
        assert_eq!(set_text(NOTE, "block", "x"), None);
    }

    #[test]
    fn a_note_without_frontmatter() {
        assert_eq!(parse("# Just a note\n"), Frontmatter::default());
        assert_eq!(
            set_text("body\n", "a", "1").as_deref(),
            Some("---\na: 1\n---\nbody\n")
        );
        // An unclosed block is not frontmatter.
        assert!(parse("---\na: 1\nno end").properties.is_empty());
    }

    #[test]
    fn crlf_line_endings_survive_an_edit() {
        let text = "---\r\na: 1\r\nb: 2\r\n---\r\nbody";
        assert_eq!(
            set_text(text, "a", "9").as_deref(),
            Some("---\r\na: 9\r\nb: 2\r\n---\r\nbody")
        );
    }
}
