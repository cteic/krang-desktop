//! The widget that draws a terminal and turns input into [`Input`].
//!
//! It draws from a [`Snapshot`], so it never touches the terminal lock. Each
//! row is laid out as text once and kept until that row changes, so a frame
//! in which one line changed shapes one line of text.

use std::cell::RefCell;

use alacritty_terminal::selection::SelectionType;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::{CursorShape, Rgb};
use iced::advanced::layout::{self, Layout};
use iced::advanced::mouse::{self, ScrollDelta};
use iced::advanced::renderer::{self, Quad};
use iced::advanced::text::{self, Paragraph as _, Renderer as _, Span};
use iced::advanced::widget::{self, Tree, Widget, tree};
use iced::advanced::{Clipboard, Renderer as _, Shell};
use iced::alignment::Vertical;
use iced::keyboard::{self, Key};
use iced::{Border, Color, Element, Event, Font, Length, Pixels, Point, Rectangle, Size, Theme};

use crate::style;

use super::input::{self, MouseAction, MouseButton};
use super::session::GridSize;
use super::snapshot::{Cell, Snapshot, Style};

type Paragraph = <iced::Renderer as text::Renderer>::Paragraph;

const LINE_HEIGHT: f32 = style::leading::TERMINAL;

#[derive(Debug, Clone)]
pub enum Input {
    Bytes(Vec<u8>),
    Resize(GridSize),
    Scroll(i32),
    Select {
        kind: SelectionType,
        line: usize,
        column: usize,
        right_half: bool,
    },
    ExtendSelection {
        line: usize,
        column: usize,
        right_half: bool,
    },
    ClearSelection,
    Copy,
    Paste(String),
    OpenLink(String),
    Focus,
}

pub struct TerminalView<'a, Message> {
    snapshot: &'a Snapshot,
    size: GridSize,
    focused: bool,
    font_size: f32,
    /// Drawn behind the cells, so the terminal matches the pane it is in.
    background: Color,
    on_input: Box<dyn Fn(Input) -> Message + 'a>,
}

impl<'a, Message> TerminalView<'a, Message> {
    pub fn new(
        snapshot: &'a Snapshot,
        size: GridSize,
        focused: bool,
        font_size: f32,
        background: Color,
        on_input: impl Fn(Input) -> Message + 'a,
    ) -> Self {
        Self {
            snapshot,
            size,
            focused,
            font_size,
            background,
            on_input: Box::new(on_input),
        }
    }
}

/// The size of one cell for a font size.
pub fn cell_size(font_size: f32) -> Size {
    let probe = Paragraph::with_text(text::Text {
        content: "MMMMMMMMMM",
        bounds: Size::INFINITE,
        size: Pixels(font_size),
        line_height: text::LineHeight::Relative(LINE_HEIGHT),
        font: style::mono(),
        align_x: text::Alignment::Left,
        align_y: Vertical::Top,
        shaping: text::Shaping::Basic,
        wrapping: text::Wrapping::None,
    });
    let bounds = probe.min_bounds();
    Size::new(
        (bounds.width / 10.0).max(1.0),
        bounds.height.ceil().max(1.0),
    )
}

struct Run {
    column: usize,
    paragraph: Paragraph,
}

struct RowCache {
    hash: u64,
    runs: Vec<Run>,
}

#[derive(Default)]
struct State {
    cell: Option<(Size, f32)>,
    rows: RefCell<Vec<RowCache>>,
    click: Option<mouse::Click>,
    selecting: bool,
    moved: bool,
    held: Option<MouseButton>,
    pressed_at: (usize, usize),
    scroll_pixels: f32,
}

impl State {
    fn cell(&mut self, font_size: f32) -> Size {
        match self.cell {
            Some((size, cached)) if cached == font_size => size,
            _ => {
                let size = cell_size(font_size);
                self.cell = Some((size, font_size));
                self.rows.borrow_mut().clear();
                size
            }
        }
    }
}

fn color(rgb: Rgb) -> Color {
    Color::from_rgb8(rgb.r, rgb.g, rgb.b)
}

fn font(style: Style) -> Font {
    Font {
        weight: if style.bold {
            iced::font::Weight::Bold
        } else {
            iced::font::Weight::Normal
        },
        style: if style.italic {
            iced::font::Style::Italic
        } else {
            iced::font::Style::Normal
        },
        ..style::mono()
    }
}

fn same_ink(a: Style, b: Style) -> bool {
    a.fg == b.fg
        && a.bold == b.bold
        && a.italic == b.italic
        && a.underline == b.underline
        && a.strike == b.strike
}

/// Splits a row into runs of one style. A character outside ASCII gets a
/// run of its own, placed at its own column, so a glyph from a fallback font
/// with another width cannot push the rest of the row out of line.
fn layout_row(cells: &[Cell], font_size: f32) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut start = 0;
    while start < cells.len() {
        let style = cells[start].style;
        let single = !cells[start].c.is_ascii();
        let mut end = start + 1;
        if !single {
            while end < cells.len() && cells[end].c.is_ascii() && same_ink(cells[end].style, style)
            {
                end += 1;
            }
        }
        let text: String = cells[start..end].iter().map(|cell| cell.c).collect();
        let decorated = style.underline || style.strike;
        let visible = if decorated {
            text.as_str()
        } else {
            text.trim_end()
        };
        if !visible.trim().is_empty() || decorated {
            let span: Span<'_, (), Font> = Span::new(visible)
                .color(color(style.fg))
                .font(font(style))
                .underline(style.underline)
                .strikethrough(style.strike);
            let paragraph = Paragraph::with_spans(text::Text {
                content: &[span][..],
                bounds: Size::INFINITE,
                size: Pixels(font_size),
                line_height: text::LineHeight::Relative(LINE_HEIGHT),
                font: font(style),
                align_x: text::Alignment::Left,
                align_y: Vertical::Top,
                shaping: if single {
                    text::Shaping::Advanced
                } else {
                    text::Shaping::Basic
                },
                wrapping: text::Wrapping::None,
            });
            runs.push(Run {
                column: start,
                paragraph,
            });
        }
        start = end;
    }
    runs
}

impl<Message> TerminalView<'_, Message> {
    fn cell_at(&self, bounds: Rectangle, cell: Size, position: Point) -> (usize, usize, bool) {
        let x = (position.x - bounds.x).max(0.0);
        let y = (position.y - bounds.y).max(0.0);
        let column = ((x / cell.width) as usize).min(self.snapshot.columns.saturating_sub(1));
        let line = ((y / cell.height) as usize).min(self.snapshot.rows.len().saturating_sub(1));
        let right_half = x % cell.width > cell.width / 2.0;
        (line, column, right_half)
    }

    fn report_mouse(
        &self,
        shell: &mut Shell<'_, Message>,
        button: MouseButton,
        action: MouseAction,
        at: (usize, usize),
        modifiers: keyboard::Modifiers,
    ) {
        if let Some(bytes) =
            input::encode_mouse(button, action, at.0, at.1, modifiers, self.snapshot.mode)
        {
            shell.publish((self.on_input)(Input::Bytes(bytes)));
        }
    }

    fn handle_key(
        &self,
        key: &Key,
        text: Option<&str>,
        modifiers: keyboard::Modifiers,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
    ) {
        let copy_paste = if cfg!(target_os = "macos") {
            modifiers.logo()
        } else {
            modifiers.control() && modifiers.shift()
        };
        if copy_paste && let Key::Character(c) = key {
            match c.as_str() {
                "c" | "C" => {
                    shell.publish((self.on_input)(Input::Copy));
                    shell.capture_event();
                    return;
                }
                "v" | "V" => {
                    if let Some(text) = clipboard.read(iced::advanced::clipboard::Kind::Standard) {
                        shell.publish((self.on_input)(Input::Paste(text)));
                    }
                    shell.capture_event();
                    return;
                }
                _ => {}
            }
        }
        // The logo key (Cmd on macOS) belongs to the app's shortcuts.
        if modifiers.logo() {
            return;
        }
        if let Some(bytes) = input::encode_key(key, text, modifiers, self.snapshot.mode) {
            shell.publish((self.on_input)(Input::Bytes(bytes)));
            shell.capture_event();
        }
    }
}

impl<Message> Widget<Message, Theme, iced::Renderer> for TerminalView<'_, Message> {
    fn size(&self) -> Size<Length> {
        Size::new(Length::Fill, Length::Fill)
    }

    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<State>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(State::default())
    }

    fn layout(
        &mut self,
        _tree: &mut Tree,
        _renderer: &iced::Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        layout::Node::new(limits.max())
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _renderer: &iced::Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        _viewport: &Rectangle,
    ) {
        let state = tree.state.downcast_mut::<State>();
        let bounds = layout.bounds();
        let cell = state.cell(self.font_size);

        let wanted = GridSize {
            columns: ((bounds.width / cell.width).floor() as u16).max(2),
            lines: ((bounds.height / cell.height).floor() as u16).max(1),
            cell_width: cell.width.round() as u16,
            cell_height: cell.height.round() as u16,
        };
        if wanted != self.size && bounds.width > 0.0 && bounds.height > 0.0 {
            self.size = wanted;
            shell.publish((self.on_input)(Input::Resize(wanted)));
        }

        let mode = self.snapshot.mode;
        let modifiers = keyboard::Modifiers::default();
        match event {
            Event::Keyboard(keyboard::Event::KeyPressed {
                key,
                text,
                modifiers,
                ..
            }) if self.focused => {
                self.handle_key(key, text.as_deref(), *modifiers, clipboard, shell);
            }
            Event::Mouse(mouse::Event::ButtonPressed(button)) => {
                let Some(position) = cursor.position_over(bounds) else {
                    return;
                };
                if !self.focused {
                    shell.publish((self.on_input)(Input::Focus));
                }
                let at = self.cell_at(bounds, cell, position);
                let mapped = match button {
                    mouse::Button::Left => MouseButton::Left,
                    mouse::Button::Middle => MouseButton::Middle,
                    mouse::Button::Right => MouseButton::Right,
                    _ => return,
                };
                if input::wants_mouse(mode) {
                    state.held = Some(mapped);
                    self.report_mouse(shell, mapped, MouseAction::Press, (at.0, at.1), modifiers);
                } else if mapped == MouseButton::Left {
                    let click = mouse::Click::new(position, mouse::Button::Left, state.click);
                    state.click = Some(click);
                    let kind = match click.kind() {
                        mouse::click::Kind::Single => SelectionType::Simple,
                        mouse::click::Kind::Double => SelectionType::Semantic,
                        mouse::click::Kind::Triple => SelectionType::Lines,
                    };
                    state.selecting = true;
                    state.moved = kind != SelectionType::Simple;
                    state.pressed_at = (at.0, at.1);
                    shell.publish((self.on_input)(Input::Select {
                        kind,
                        line: at.0,
                        column: at.1,
                        right_half: at.2,
                    }));
                }
                shell.capture_event();
            }
            Event::Mouse(mouse::Event::CursorMoved { position }) => {
                let at = self.cell_at(bounds, cell, *position);
                if state.selecting {
                    if (at.0, at.1) != state.pressed_at {
                        state.moved = true;
                    }
                    if state.moved {
                        shell.publish((self.on_input)(Input::ExtendSelection {
                            line: at.0,
                            column: at.1,
                            right_half: at.2,
                        }));
                    }
                } else if input::wants_mouse(mode) && bounds.contains(*position) {
                    self.report_mouse(
                        shell,
                        MouseButton::Left,
                        MouseAction::Motion(state.held),
                        (at.0, at.1),
                        modifiers,
                    );
                }
            }
            Event::Mouse(mouse::Event::ButtonReleased(_)) => {
                if state.selecting {
                    state.selecting = false;
                    if !state.moved {
                        shell.publish((self.on_input)(Input::ClearSelection));
                        let (line, column) = state.pressed_at;
                        if let Some(url) = self.snapshot.link_at(line, column) {
                            shell.publish((self.on_input)(Input::OpenLink(url)));
                        }
                    }
                } else if let Some(held) = state.held.take()
                    && let Some(position) = cursor.position()
                {
                    let at = self.cell_at(bounds, cell, position);
                    self.report_mouse(shell, held, MouseAction::Release, (at.0, at.1), modifiers);
                }
            }
            Event::Mouse(mouse::Event::WheelScrolled { delta }) => {
                let Some(position) = cursor.position_over(bounds) else {
                    return;
                };
                let lines = match delta {
                    ScrollDelta::Lines { y, .. } => (y * 3.0).round() as i32,
                    ScrollDelta::Pixels { y, .. } => {
                        state.scroll_pixels += y;
                        let whole = (state.scroll_pixels / cell.height).trunc();
                        state.scroll_pixels -= whole * cell.height;
                        whole as i32
                    }
                };
                if lines == 0 {
                    return;
                }
                let at = self.cell_at(bounds, cell, position);
                if input::wants_mouse(mode) {
                    let button = if lines > 0 {
                        MouseButton::WheelUp
                    } else {
                        MouseButton::WheelDown
                    };
                    for _ in 0..lines.unsigned_abs() {
                        self.report_mouse(
                            shell,
                            button,
                            MouseAction::Press,
                            (at.0, at.1),
                            modifiers,
                        );
                    }
                } else if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
                    let key: &[u8] = if lines > 0 { b"\x1bOA" } else { b"\x1bOB" };
                    let bytes = key.repeat(lines.unsigned_abs() as usize);
                    shell.publish((self.on_input)(Input::Bytes(bytes)));
                } else {
                    shell.publish((self.on_input)(Input::Scroll(lines)));
                }
                shell.capture_event();
            }
            _ => {}
        }
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        _viewport: &Rectangle,
        _renderer: &iced::Renderer,
    ) -> mouse::Interaction {
        let state = tree.state.downcast_ref::<State>();
        let Some(position) = cursor.position_over(layout.bounds()) else {
            return mouse::Interaction::None;
        };
        let Some((cell, _)) = state.cell else {
            return mouse::Interaction::Text;
        };
        if input::wants_mouse(self.snapshot.mode) {
            return mouse::Interaction::Idle;
        }
        let (line, column, _) = self.cell_at(layout.bounds(), cell, position);
        if self.snapshot.link_at(line, column).is_some() {
            mouse::Interaction::Pointer
        } else {
            mouse::Interaction::Text
        }
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut iced::Renderer,
        _theme: &Theme,
        _style: &renderer::Style,
        layout: Layout<'_>,
        _cursor: mouse::Cursor,
        _viewport: &Rectangle,
    ) {
        let state = tree.state.downcast_ref::<State>();
        let bounds = layout.bounds();
        let cell = state
            .cell
            .map(|(size, _)| size)
            .unwrap_or_else(|| cell_size(self.font_size));
        let mut cache = state.rows.borrow_mut();
        cache.resize_with(self.snapshot.rows.len(), || RowCache {
            hash: 0,
            runs: Vec::new(),
        });
        let snapshot = self.snapshot;
        let scheme = snapshot.scheme;
        let background = self.background;

        renderer.with_layer(bounds, |renderer| {
            renderer.fill_quad(
                Quad {
                    bounds,
                    ..Quad::default()
                },
                background,
            );

            for (line, row) in snapshot.rows.iter().enumerate() {
                let y = bounds.y + line as f32 * cell.height;
                let mut column = 0;
                while column < row.cells.len() {
                    let bg = row.cells[column].style.bg;
                    let mut end = column + 1;
                    while end < row.cells.len() && row.cells[end].style.bg == bg {
                        end += 1;
                    }
                    if bg != scheme.background {
                        renderer.fill_quad(
                            Quad {
                                bounds: Rectangle {
                                    x: bounds.x + column as f32 * cell.width,
                                    y,
                                    width: (end - column) as f32 * cell.width,
                                    height: cell.height,
                                },
                                snap: true,
                                ..Quad::default()
                            },
                            color(bg),
                        );
                    }
                    column = end;
                }
            }

            if let Some(cursor) = snapshot.cursor {
                let x = bounds.x + cursor.column as f32 * cell.width;
                let y = bounds.y + cursor.line as f32 * cell.height;
                let (rect, hollow) = match cursor.shape {
                    CursorShape::Beam => (
                        Rectangle {
                            x,
                            y,
                            width: 2.0,
                            height: cell.height,
                        },
                        false,
                    ),
                    CursorShape::Underline => (
                        Rectangle {
                            x,
                            y: y + cell.height - 2.0,
                            width: cell.width,
                            height: 2.0,
                        },
                        false,
                    ),
                    _ => (
                        Rectangle {
                            x,
                            y,
                            width: cell.width,
                            height: cell.height,
                        },
                        !self.focused || cursor.shape == CursorShape::HollowBlock,
                    ),
                };
                let cursor_color = color(scheme.cursor);
                if hollow {
                    renderer.fill_quad(
                        Quad {
                            bounds: rect,
                            border: Border {
                                color: cursor_color,
                                width: 1.0,
                                radius: 0.0.into(),
                            },
                            ..Quad::default()
                        },
                        Color::TRANSPARENT,
                    );
                } else {
                    renderer.fill_quad(
                        Quad {
                            bounds: rect,
                            ..Quad::default()
                        },
                        cursor_color,
                    );
                }
            }

            for (line, row) in snapshot.rows.iter().enumerate() {
                let slot = &mut cache[line];
                if slot.hash != row.hash || (slot.runs.is_empty() && row.hash != 0) {
                    slot.runs = layout_row(&row.cells, self.font_size);
                    slot.hash = row.hash;
                }
                let y = bounds.y + line as f32 * cell.height;
                for run in &slot.runs {
                    let position = Point::new(bounds.x + run.column as f32 * cell.width, y);
                    renderer.fill_paragraph(
                        &run.paragraph,
                        position,
                        color(scheme.foreground),
                        bounds,
                    );
                }
            }

            // Text under a block cursor takes the background colour, so it stays readable.
            if let Some(cursor) = snapshot
                .cursor
                .filter(|cursor| self.focused && matches!(cursor.shape, CursorShape::Block))
                && let Some(cell_under) = snapshot
                    .rows
                    .get(cursor.line)
                    .and_then(|row| row.cells.get(cursor.column))
                && cell_under.c != ' '
            {
                let position = Point::new(
                    bounds.x + cursor.column as f32 * cell.width,
                    bounds.y + cursor.line as f32 * cell.height,
                );
                renderer.fill_text(
                    text::Text {
                        content: cell_under.c.to_string(),
                        bounds: Size::new(cell.width * 2.0, cell.height),
                        size: Pixels(self.font_size),
                        line_height: text::LineHeight::Relative(LINE_HEIGHT),
                        font: font(cell_under.style),
                        align_x: text::Alignment::Left,
                        align_y: Vertical::Top,
                        shaping: text::Shaping::Advanced,
                        wrapping: text::Wrapping::None,
                    },
                    position,
                    background,
                    bounds,
                );
            }
        });
    }

    fn operate(
        &mut self,
        _tree: &mut Tree,
        _layout: Layout<'_>,
        _renderer: &iced::Renderer,
        _operation: &mut dyn widget::Operation,
    ) {
    }
}

impl<'a, Message: 'a> From<TerminalView<'a, Message>>
    for Element<'a, Message, Theme, iced::Renderer>
{
    fn from(view: TerminalView<'a, Message>) -> Self {
        Element::new(view)
    }
}
