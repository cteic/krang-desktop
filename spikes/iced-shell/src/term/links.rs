//! Finds a URL in a row of terminal text.

use std::sync::LazyLock;

use regex::Regex;

static URL: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(?:https?|file|ftp)://[^\s<>"'`{}|\\^\[\]]+|mailto:[^\s<>"']+"#).ok()
});

/// The URL that covers `column`, with trailing punctuation that is more
/// likely prose than URL left out.
pub fn url_at(text: &str, column: usize) -> Option<String> {
    let regex = URL.as_ref()?;
    // Columns count chars, the regex counts bytes.
    let byte = text.char_indices().nth(column).map(|(index, _)| index)?;
    regex.find_iter(text).find_map(|found| {
        let url = found.as_str().trim_end_matches(['.', ',', ';', ':', ')', '!', '?']);
        let end = found.start() + url.len();
        (found.start() <= byte && byte < end).then(|| url.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_url_under_the_column() {
        let text = "see https://example.org/x?y=1, then more";
        assert_eq!(url_at(text, 4).as_deref(), Some("https://example.org/x?y=1"));
        assert_eq!(url_at(text, 28).as_deref(), Some("https://example.org/x?y=1"));
        assert_eq!(url_at(text, 29), None);
        assert_eq!(url_at(text, 0), None);
    }

    #[test]
    fn a_column_past_the_end_is_nothing() {
        assert_eq!(url_at("http://a", 100), None);
    }
}
