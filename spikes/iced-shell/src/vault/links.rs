//! `[[wikilinks]]` and `#tags` in a note's body.

/// One `[[target#heading|label]]` link and where it sits in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    pub target: String,
    pub heading: Option<String>,
    pub label: Option<String>,
    /// Byte range of the whole `[[...]]`, brackets included.
    pub range: std::ops::Range<usize>,
    /// `![[...]]`: an embed, such as an image.
    pub embed: bool,
}

/// Every wikilink in the text, skipping fenced and inline code.
pub fn wikilinks(text: &str) -> Vec<WikiLink> {
    let mut links = Vec::new();
    for (start, line) in code_free_lines(text) {
        let mut search = 0;
        while let Some(open) = line[search..].find("[[") {
            let open = search + open;
            let Some(close) = line[open + 2..].find("]]") else {
                break;
            };
            let inner = &line[open + 2..open + 2 + close];
            search = open + 2 + close + 2;
            if inner.is_empty() || inner.contains("[[") || in_inline_code(line, open) {
                continue;
            }
            let (target_part, label) = match inner.split_once('|') {
                Some((target, label)) => (target, Some(label.trim().to_string())),
                None => (inner, None),
            };
            let (target, heading) = match target_part.split_once('#') {
                Some((target, heading)) => (target, Some(heading.trim().to_string())),
                None => (target_part, None),
            };
            let embed = open > 0 && line.as_bytes()[open - 1] == b'!';
            let begin = start + open - usize::from(embed);
            links.push(WikiLink {
                target: target.trim().to_string(),
                heading,
                label,
                range: begin..start + search,
                embed,
            });
        }
    }
    links
}

fn in_inline_code(line: &str, at: usize) -> bool {
    line[..at].matches('`').count() % 2 == 1
}

/// The lines outside fenced code blocks, with their byte offsets.
fn code_free_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut offset = 0;
    let mut fenced = false;
    text.split_inclusive('\n').filter_map(move |line| {
        let start = offset;
        offset += line.len();
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            return None;
        }
        (!fenced).then_some((start, line))
    })
}

/// Every `#tag` in the body, outside code and headings. A tag may hold
/// letters, digits, `_`, `-` and `/`, and must not be only digits.
pub fn tags(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (_, line) in code_free_lines(text) {
        let bytes = line.as_bytes();
        for (index, _) in line.match_indices('#') {
            let before_ok = index == 0 || bytes[index - 1].is_ascii_whitespace() || bytes[index - 1] == b'(';
            if !before_ok || in_inline_code(line, index) {
                continue;
            }
            let tag: String = line[index + 1..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
                .collect();
            if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) && !found.contains(&tag) {
                found.push(tag);
            }
        }
    }
    found
}

/// The partial link being typed at `cursor`: the text after an open `[[`
/// with no `]]` yet, on the same line.
pub fn open_link_at(line: &str, cursor: usize) -> Option<&str> {
    let before = line.get(..cursor)?;
    let open = before.rfind("[[")?;
    let typed = &before[open + 2..];
    (!typed.contains("]]") && !typed.contains('|')).then_some(typed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_targets_headings_labels_and_embeds() {
        let text = "See [[Alpha]], [[Beta#Part|the beta]] and ![[pic.png]].";
        let links = wikilinks(text);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].target, "Alpha");
        assert_eq!(&text[links[0].range.clone()], "[[Alpha]]");
        assert_eq!(links[1].heading.as_deref(), Some("Part"));
        assert_eq!(links[1].label.as_deref(), Some("the beta"));
        assert!(links[2].embed);
        assert_eq!(&text[links[2].range.clone()], "![[pic.png]]");
    }

    #[test]
    fn code_is_not_a_link() {
        let text = "`[[not]]` [[yes]]\n```\n[[fenced]]\n```\n[[after]]";
        let targets: Vec<String> = wikilinks(text).into_iter().map(|link| link.target).collect();
        assert_eq!(targets, ["yes", "after"]);
    }

    #[test]
    fn finds_tags_but_not_headings_numbers_or_anchors() {
        let text = "# Heading\nA #bread note #lab/proof, issue #123 and x#y.\n```\n#code\n```";
        assert_eq!(tags(text), ["bread", "lab/proof"]);
    }

    #[test]
    fn finds_the_link_being_typed() {
        assert_eq!(open_link_at("go to [[Alp", 11), Some("Alp"));
        assert_eq!(open_link_at("go to [[", 8), Some(""));
        assert_eq!(open_link_at("[[done]] x", 10), None);
        assert_eq!(open_link_at("plain", 5), None);
    }
}
