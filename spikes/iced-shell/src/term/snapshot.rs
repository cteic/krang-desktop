//! A copy of what a terminal shows, taken under the lock and drawn after it
//! is released.
//!
//! Only the visible rows are copied, never the scrollback, so taking one costs
//! the same with ten lines of history or ten thousand. Colours, inverse video
//! and the selection are resolved here, so drawing is a plain walk over cells.

use std::hash::{DefaultHasher, Hash, Hasher};

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{CursorShape, Rgb};

use super::palette;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Style {
    pub fg: Rgb,
    pub bg: Rgb,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
}

impl Hash for Style {
    fn hash<H: Hasher>(&self, state: &mut H) {
        [
            self.fg.r, self.fg.g, self.fg.b, self.bg.r, self.bg.g, self.bg.b,
        ]
        .hash(state);
        [self.bold, self.italic, self.underline, self.strike].hash(state);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Cell {
    pub c: char,
    pub style: Style,
    /// Index into [`Snapshot::links`] for a cell inside an OSC 8 link.
    pub link: Option<u16>,
}

#[derive(Debug, Clone, Default)]
pub struct Row {
    pub cells: Vec<Cell>,
    /// Lets the renderer reuse the text it laid out for an unchanged row.
    pub hash: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub line: usize,
    pub column: usize,
    pub shape: CursorShape,
}

#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub columns: usize,
    pub rows: Vec<Row>,
    pub cursor: Option<Cursor>,
    pub mode: TermMode,
    pub display_offset: usize,
    pub links: Vec<String>,
}

impl Snapshot {
    pub fn take<T: EventListener>(term: &Term<T>) -> Self {
        let columns = term.columns();
        let screen_lines = term.screen_lines();
        let content = term.renderable_content();
        let colors = content.colors;
        let selection = content.selection;
        let display_offset = content.display_offset;
        let mode = content.mode;

        let blank = Cell {
            c: ' ',
            style: Style {
                fg: palette::FOREGROUND,
                bg: palette::BACKGROUND,
                bold: false,
                italic: false,
                underline: false,
                strike: false,
            },
            link: None,
        };
        let mut rows = vec![
            Row {
                cells: vec![blank; columns],
                hash: 0
            };
            screen_lines
        ];
        let mut links: Vec<String> = Vec::new();

        for indexed in content.display_iter {
            let Some(line) = usize::try_from(indexed.point.line.0 + display_offset as i32).ok()
            else {
                continue;
            };
            let column = indexed.point.column.0;
            let Some(slot) = rows.get_mut(line).and_then(|row| row.cells.get_mut(column)) else {
                continue;
            };
            let cell = indexed.cell;
            let flags = cell.flags;
            if flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let bold = flags.contains(Flags::BOLD);
            let mut fg = palette::resolve(cell.fg, colors, bold);
            let mut bg = palette::resolve(cell.bg, colors, false);
            if flags.contains(Flags::DIM) {
                fg = palette::dim(fg);
            }
            if flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if selection.is_some_and(|range| range.contains(indexed.point)) {
                bg = palette::SELECTION;
            }
            let c = if flags.contains(Flags::HIDDEN) {
                ' '
            } else {
                cell.c
            };
            let link = cell.hyperlink().and_then(|link| {
                let uri = link.uri();
                let index = match links.iter().position(|known| known == uri) {
                    Some(index) => index,
                    None => {
                        links.push(uri.to_string());
                        links.len() - 1
                    }
                };
                u16::try_from(index).ok()
            });
            *slot = Cell {
                c,
                style: Style {
                    fg,
                    bg,
                    bold,
                    italic: flags.contains(Flags::ITALIC),
                    underline: flags.intersects(Flags::ALL_UNDERLINES) || link.is_some(),
                    strike: flags.contains(Flags::STRIKEOUT),
                },
                link,
            };
        }

        for row in &mut rows {
            let mut hasher = DefaultHasher::new();
            row.cells.hash(&mut hasher);
            row.hash = hasher.finish();
        }

        let cursor = (mode.contains(TermMode::SHOW_CURSOR) && display_offset == 0)
            .then(|| {
                let point = content.cursor.point;
                Some(Cursor {
                    line: usize::try_from(point.line.0).ok()?,
                    column: point.column.0,
                    shape: content.cursor.shape,
                })
            })
            .flatten()
            .filter(|cursor| cursor.shape != CursorShape::Hidden);

        Self {
            columns,
            rows,
            cursor,
            mode,
            display_offset,
            links,
        }
    }

    pub fn row_text(&self, line: usize) -> String {
        self.rows
            .get(line)
            .map(|row| row.cells.iter().map(|cell| cell.c).collect())
            .unwrap_or_default()
    }

    /// The whole visible screen as text, one line per row, trailing blanks cut.
    pub fn text(&self) -> String {
        (0..self.rows.len())
            .map(|line| self.row_text(line).trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The link under a cell: an OSC 8 link, or a plain URL in the text.
    pub fn link_at(&self, line: usize, column: usize) -> Option<String> {
        let row = self.rows.get(line)?;
        if let Some(index) = row.cells.get(column)?.link {
            return self.links.get(usize::from(index)).cloned();
        }
        super::links::url_at(&self.row_text(line), column)
    }
}

/// The grid point, in the terminal's own coordinates, of a visible cell.
pub fn grid_point(display_offset: usize, line: usize, column: usize) -> Point {
    Point::new(Line(line as i32 - display_offset as i32), Column(column))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::Config;
    use alacritty_terminal::term::test::TermSize;
    use alacritty_terminal::vte::ansi::Processor;

    fn term_with(columns: usize, lines: usize, bytes: &[u8]) -> Term<VoidListener> {
        let mut term = Term::new(
            Config::default(),
            &TermSize::new(columns, lines),
            VoidListener,
        );
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, bytes);
        term
    }

    #[test]
    fn copies_text_and_true_colour() {
        let term = term_with(20, 3, b"plain \x1b[1;38;2;10;20;30mbold\x1b[0m");
        let snapshot = Snapshot::take(&term);
        assert_eq!(snapshot.row_text(0).trim_end(), "plain bold");
        let cell = snapshot.rows[0].cells[6];
        assert!(cell.style.bold);
        assert_eq!(
            cell.style.fg,
            Rgb {
                r: 10,
                g: 20,
                b: 30
            }
        );
        assert_eq!(snapshot.cursor.map(|cursor| cursor.column), Some(10));
    }

    #[test]
    fn inverse_swaps_colours() {
        let term = term_with(10, 2, b"\x1b[7mx");
        let cell = Snapshot::take(&term).rows[0].cells[0];
        assert_eq!(cell.style.fg, palette::BACKGROUND);
        assert_eq!(cell.style.bg, palette::FOREGROUND);
    }

    #[test]
    fn copies_only_the_screen_not_the_scrollback() {
        let mut output = Vec::new();
        for line in 0..5_000 {
            output.extend_from_slice(format!("line {line}\r\n").as_bytes());
        }
        let term = term_with(40, 10, &output);
        let snapshot = Snapshot::take(&term);
        assert_eq!(snapshot.rows.len(), 10);
        assert_eq!(snapshot.row_text(8).trim_end(), "line 4999");
    }

    #[test]
    fn an_unchanged_row_keeps_its_hash() {
        let first = Snapshot::take(&term_with(10, 3, b"same\r\nold"));
        let second = Snapshot::take(&term_with(10, 3, b"same\r\nnew"));
        assert_eq!(first.rows[0].hash, second.rows[0].hash);
        assert_ne!(first.rows[1].hash, second.rows[1].hash);
    }

    #[test]
    fn the_alternate_screen_and_a_hidden_cursor_show_in_the_mode() {
        let term = term_with(10, 3, b"\x1b[?1049h\x1b[?25l");
        let snapshot = Snapshot::take(&term);
        assert!(snapshot.mode.contains(TermMode::ALT_SCREEN));
        assert!(snapshot.cursor.is_none());
    }

    #[test]
    fn an_osc_8_link_is_found_under_its_text() {
        let term = term_with(
            30,
            2,
            b"\x1b]8;;https://example.org/a\x1b\\here\x1b]8;;\x1b\\ x",
        );
        let snapshot = Snapshot::take(&term);
        assert_eq!(
            snapshot.link_at(0, 2).as_deref(),
            Some("https://example.org/a")
        );
        assert_eq!(snapshot.link_at(0, 5), None);
    }
}
