//! Prepares a note for the Markdown preview: frontmatter out, wikilinks and
//! embeds turned into ordinary links and images the preview can follow.

use super::{frontmatter, links};

pub const WIKI_SCHEME: &str = "wiki:";
pub const VAULT_SCHEME: &str = "vault:";

const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

fn encode(target: &str) -> String {
    let mut out = String::with_capacity(target.len());
    for byte in target.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' | b'~' => out.push(char::from(byte)),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = text.get(index + 1..index + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_image(target: &str) -> bool {
    target.rsplit_once('.').is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

fn escape_label(label: &str) -> String {
    label.replace('[', "\\[").replace(']', "\\]")
}

/// The note's body as plain CommonMark for the preview.
pub fn preview_source(text: &str) -> String {
    let body = &text[frontmatter::parse(text).body_start..];
    let mut out = String::with_capacity(body.len());
    let mut last = 0;
    for link in links::wikilinks(body) {
        out.push_str(&body[last..link.range.start]);
        last = link.range.end;
        if link.embed && is_image(&link.target) {
            out.push_str(&format!("![{}]({VAULT_SCHEME}{})", escape_label(&link.target), encode(&link.target)));
            continue;
        }
        let label = link.label.clone().unwrap_or_else(|| match &link.heading {
            Some(heading) => format!("{} > {heading}", link.target),
            None => link.target.clone(),
        });
        out.push_str(&format!("[{}]({WIKI_SCHEME}{})", escape_label(&label), encode(&link.target)));
    }
    out.push_str(&body[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilinks_become_followable_links() {
        let source = preview_source("---\na: 1\n---\nSee [[My Note|this]], [[Other#Part]] and ![[img one.png]].");
        assert_eq!(
            source,
            "See [this](wiki:My%20Note), [Other > Part](wiki:Other) and ![img one.png](vault:img%20one.png)."
        );
    }

    #[test]
    fn decoding_reverses_encoding() {
        assert_eq!(decode(&encode("a b/ü?")), "a b/ü?");
        assert_eq!(decode("100%"), "100%");
    }
}
