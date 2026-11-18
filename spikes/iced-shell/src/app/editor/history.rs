//! Undo and redo for the editor, which iced's text editor does not have.
//!
//! A burst of typing is one step. The text is read once when the burst
//! starts and once when it ends, and the step stores only the part that
//! changed, as a replacement at a line and byte column, which is how the
//! editor addresses text. Undoing selects the new part and pastes the old.

/// A line and a byte offset within it.
pub type Position = (usize, usize);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub start: Position,
    pub removed: String,
    pub inserted: String,
}

/// Where `text` ends when it is inserted at `start`.
pub fn end_of(start: Position, text: &str) -> Position {
    match text.rfind('\n') {
        Some(last) => (start.0 + text.matches('\n').count(), text.len() - last - 1),
        None => (start.0, start.1 + text.len()),
    }
}

fn position_at(text: &str, byte: usize) -> Position {
    let before = &text[..byte];
    match before.rfind('\n') {
        Some(last) => (before.matches('\n').count(), byte - last - 1),
        None => (0, byte),
    }
}

/// The smallest replacement that turns `before` into `after`.
pub fn diff(before: &str, after: &str) -> Option<Change> {
    if before == after {
        return None;
    }
    let mut prefix = before.bytes().zip(after.bytes()).take_while(|(a, b)| a == b).count();
    while !before.is_char_boundary(prefix) || !after.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let limit = before.len().min(after.len()) - prefix;
    let mut suffix = before.bytes().rev().zip(after.bytes().rev()).take(limit).take_while(|(a, b)| a == b).count();
    while !before.is_char_boundary(before.len() - suffix) || !after.is_char_boundary(after.len() - suffix) {
        suffix -= 1;
    }
    Some(Change {
        start: position_at(before, prefix),
        removed: before[prefix..before.len() - suffix].to_string(),
        inserted: after[prefix..after.len() - suffix].to_string(),
    })
}

/// What to do to the editor to step through history: select from `start`
/// to `end` and paste `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replace {
    pub start: Position,
    pub end: Position,
    pub text: String,
}

#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Change>,
    redo: Vec<Change>,
}

const LIMIT: usize = 500;

impl History {
    pub fn record(&mut self, change: Change) {
        self.undo.push(change);
        if self.undo.len() > LIMIT {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn undo(&mut self) -> Option<Replace> {
        let change = self.undo.pop()?;
        let replace = Replace { start: change.start, end: end_of(change.start, &change.inserted), text: change.removed.clone() };
        self.redo.push(change);
        Some(replace)
    }

    pub fn redo(&mut self) -> Option<Replace> {
        let change = self.redo.pop()?;
        let replace = Replace { start: change.start, end: end_of(change.start, &change.removed), text: change.inserted.clone() };
        self.undo.push(change);
        Some(replace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applies a replacement to plain text, as the editor would.
    fn apply(text: &str, replace: &Replace) -> String {
        let offset = |(line, column): Position| -> usize {
            text.split_inclusive('\n').take(line).map(str::len).sum::<usize>() + column
        };
        let (start, end) = (offset(replace.start), offset(replace.end));
        format!("{}{}{}", &text[..start], replace.text, &text[end..])
    }

    #[test]
    fn a_change_inside_a_line() {
        let change = diff("one\ntwo three\n", "one\ntwo 2 three\n");
        assert_eq!(change, Some(Change { start: (1, 4), removed: String::new(), inserted: "2 ".into() }));
    }

    #[test]
    fn undo_and_redo_restore_the_text() {
        let steps = ["# Title\n", "# Title\nfirst line\n", "# Title\nfirst line\nsecond ü\n", "# Title\nsecond ü\n"];
        let mut history = History::default();
        for pair in steps.windows(2) {
            if let Some(change) = diff(pair[0], pair[1]) {
                history.record(change);
            }
        }
        let mut text = steps[3].to_string();
        for expected in steps[..3].iter().rev() {
            let Some(replace) = history.undo() else { panic!("history ran out") };
            text = apply(&text, &replace);
            assert_eq!(&text, expected);
        }
        assert_eq!(history.undo(), None);
        for expected in &steps[1..] {
            let Some(replace) = history.redo() else { panic!("redo ran out") };
            text = apply(&text, &replace);
            assert_eq!(&text, expected);
        }
    }

    #[test]
    fn multibyte_text_splits_on_character_boundaries() {
        let change = diff("aéb", "aêb");
        assert_eq!(change, Some(Change { start: (0, 1), removed: "é".into(), inserted: "ê".into() }));
    }

    #[test]
    fn a_new_edit_clears_redo() {
        let mut history = History::default();
        history.record(Change { start: (0, 0), removed: String::new(), inserted: "a".into() });
        let _ = history.undo();
        history.record(Change { start: (0, 0), removed: String::new(), inserted: "b".into() });
        assert_eq!(history.redo(), None);
    }

    #[test]
    fn end_positions() {
        assert_eq!(end_of((2, 3), "abc"), (2, 6));
        assert_eq!(end_of((2, 3), "a\nbc"), (3, 2));
        assert_eq!(end_of((0, 0), "\n"), (1, 0));
    }
}
