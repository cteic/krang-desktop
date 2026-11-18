//! Fuzzy matching for the quick switcher: the query's characters must
//! appear in order; matches at word starts and in a row score higher.

fn is_word_start(original: &[char], index: usize) -> bool {
    index == 0
        || !original[index - 1].is_alphanumeric()
        || (original[index].is_uppercase() && original[index - 1].is_lowercase())
}

/// One pass over the candidate. With `prefer_starts` each query character
/// takes the next word start that matches it when there is one.
fn pass(query: &str, lower: &[char], original: &[char], prefer_starts: bool) -> Option<i32> {
    let mut score = 0;
    let mut at = 0;
    let mut previous: Option<usize> = None;
    for wanted in query.chars() {
        let first = (at..lower.len()).find(|&index| lower[index] == wanted)?;
        let found = if prefer_starts {
            (first..lower.len()).find(|&index| lower[index] == wanted && is_word_start(original, index)).unwrap_or(first)
        } else {
            first
        };
        score += 1;
        if is_word_start(original, found) {
            score += 8;
        }
        if previous.is_some_and(|previous| previous + 1 == found) {
            score += 5;
        }
        score -= i32::try_from(found - at).unwrap_or(i32::MAX).min(3);
        previous = Some(found);
        at = found + 1;
    }
    Some(score)
}

/// A score for `candidate` against a lower-case `query`, or `None` when it
/// does not match.
pub fn score(query: &str, candidate: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let lower: Vec<char> = candidate.to_lowercase().chars().collect();
    let original: Vec<char> = candidate.chars().collect();
    if lower.len() != original.len() {
        // A character whose lower case is longer: compare without the bonuses.
        return candidate.to_lowercase().contains(query).then_some(1);
    }
    let best = pass(query, &lower, &original, false)?.max(pass(query, &lower, &original, true).unwrap_or(i32::MIN));
    // Shorter names win a tie: the query covers more of them.
    Some(best * 4 - i32::try_from(lower.len()).unwrap_or(i32::MAX).min(200) / 8)
}

/// The best `limit` matches, best first.
pub fn rank<'a>(query: &str, candidates: impl Iterator<Item = &'a str>, limit: usize) -> Vec<&'a str> {
    let query = query.to_lowercase();
    let mut scored: Vec<(i32, &str)> = candidates.filter_map(|candidate| Some((score(&query, candidate)?, candidate))).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())).then(a.1.cmp(b.1)));
    scored.into_iter().take(limit).map(|(_, candidate)| candidate).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_must_come_in_order() {
        assert!(score("abc", "a big cat").is_some());
        assert!(score("cba", "a big cat").is_none());
    }

    #[test]
    fn word_starts_beat_scattered_letters() {
        let ranked = rank("mn", ["commonplace", "Meeting Notes", "mono"].into_iter(), 3);
        assert_eq!(ranked[0], "Meeting Notes");
    }

    #[test]
    fn an_exact_prefix_ranks_first() {
        let ranked = rank("note 12", ["Note 1234", "Note 12", "Another note 12"].into_iter(), 3);
        assert_eq!(ranked[0], "Note 12");
    }
}
