//! One style per role, and the few pieces of chrome every pane shares.
//!
//! A style is a function of the theme, so it follows light and dark with no
//! help from the view. The builders at the end draw what iced has no widget
//! for: hairlines, the drawn icons of a status line, step markers.

use iced::border::{self, Radius};
use iced::widget::{
    Space, button, column, container, markdown, pane_grid, row, scrollable, text, text_editor,
    text_input,
};
use iced::{Background, Border, Color, Element, Length, Padding, Shadow, Theme, Vector};

use super::tokens::{Mode, Tokens, mix, readable, tokens};
use super::{measure, mono, radius, size, space, ui};

fn outline(color: Color, radius: f32) -> Border {
    Border {
        color,
        width: measure::OUTLINE,
        radius: radius.into(),
    }
}

fn soft_shadow(tokens: &Tokens) -> Shadow {
    Shadow {
        color: tokens.shadow,
        offset: Vector::new(0.0, measure::SHADOW_DROP),
        blur_radius: measure::SHADOW_BLUR,
    }
}

// Text.

pub fn ink(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(tokens(theme).ink),
    }
}

pub fn muted(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(tokens(theme).muted),
    }
}

pub fn accent(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(tokens(theme).accent),
    }
}

pub fn ok(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(tokens(theme).ok),
    }
}

pub fn bad(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(tokens(theme).bad),
    }
}

pub fn wait(theme: &Theme) -> text::Style {
    text::Style {
        color: Some(tokens(theme).wait),
    }
}

/// A meaning a colour carries, for text that is told what it reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Bad,
    Wait,
    Accent,
    Muted,
}

pub fn toned(tone: Tone) -> fn(&Theme) -> text::Style {
    match tone {
        Tone::Ok => ok,
        Tone::Bad => bad,
        Tone::Wait => wait,
        Tone::Accent => accent,
        Tone::Muted => muted,
    }
}

/// Takes the colour of the surface it is on: the status line sets it.
pub fn inherit(_theme: &Theme) -> text::Style {
    text::Style { color: None }
}

// Surfaces.

/// The window behind the rail and the panes.
pub fn window(theme: &Theme) -> container::Style {
    let tokens = tokens(theme);
    container::Style::default()
        .background(tokens.bg)
        .color(tokens.ink)
}

/// A pane: paper with a soft shadow when focused, recessed when not.
pub fn pane(focused: bool) -> impl Fn(&Theme) -> container::Style {
    move |theme| {
        let tokens = tokens(theme);
        container::Style {
            text_color: Some(tokens.ink),
            background: Some(Background::Color(if focused {
                tokens.paper
            } else {
                tokens.recess
            })),
            border: border::rounded(radius::L),
            shadow: if focused {
                soft_shadow(tokens)
            } else {
                Shadow::default()
            },
            ..container::Style::default()
        }
    }
}

/// A pane's status line: filled with the accent when the pane is focused.
pub fn status_line(focused: bool) -> impl Fn(&Theme) -> container::Style {
    move |theme| {
        let tokens = tokens(theme);
        let top = Radius::default().top(radius::L);
        if focused {
            container::Style {
                text_color: Some(tokens.accent_ink),
                background: Some(Background::Color(tokens.accent)),
                border: Border {
                    radius: top,
                    ..Border::default()
                },
                ..container::Style::default()
            }
        } else {
            container::Style {
                text_color: Some(tokens.muted),
                border: Border {
                    radius: top,
                    ..Border::default()
                },
                ..container::Style::default()
            }
        }
    }
}

/// The right end of a status line. It is opaque, so a long context never
/// shows through the controls drawn over it.
pub fn status_end(focused: bool) -> impl Fn(&Theme) -> container::Style {
    move |theme| {
        let tokens = tokens(theme);
        let (background, ink) = if focused {
            (tokens.accent, tokens.accent_ink)
        } else {
            (tokens.recess, tokens.muted)
        };
        container::Style {
            text_color: Some(ink),
            background: Some(Background::Color(background)),
            border: Border {
                radius: Radius::default().top_right(radius::L),
                ..Border::default()
            },
            ..container::Style::default()
        }
    }
}

/// A well inside a pane: code, a note's properties. `focused` is the
/// pane's, because a well has to stand out from the surface around it.
pub fn well(focused: bool) -> impl Fn(&Theme) -> container::Style {
    move |theme| {
        let tokens = tokens(theme);
        container::Style::default()
            .background(if focused { tokens.recess } else { tokens.bg })
            .color(tokens.ink)
            .border(border::rounded(radius::M))
    }
}

/// A well that reports a failure.
pub fn well_bad(theme: &Theme) -> container::Style {
    let tokens = tokens(theme);
    container::Style::default()
        .background(tokens.bad_soft)
        .color(tokens.ink)
        .border(border::rounded(radius::M))
}

/// A notice that asks the person for an answer.
pub fn notice(theme: &Theme) -> container::Style {
    let tokens = tokens(theme);
    container::Style::default()
        .background(tokens.accent_soft)
        .color(tokens.ink)
        .border(border::rounded(radius::M))
}

/// A panel that floats above the window: the palette, the quick switcher,
/// a completion list.
pub fn overlay_panel(theme: &Theme) -> container::Style {
    let tokens = tokens(theme);
    container::Style {
        text_color: Some(tokens.ink),
        background: Some(Background::Color(tokens.paper)),
        border: outline(tokens.ink, radius::XL),
        shadow: soft_shadow(tokens),
        ..container::Style::default()
    }
}

/// Dims the window behind an overlay panel.
pub fn scrim(theme: &Theme) -> container::Style {
    container::Style::default().background(tokens(theme).scrim)
}

/// A count that wants attention.
pub fn badge(theme: &Theme) -> container::Style {
    let tokens = tokens(theme);
    container::Style::default()
        .background(tokens.accent)
        .color(tokens.accent_ink)
        .border(border::rounded(radius::FULL))
}

fn fill(color: impl Fn(&Tokens) -> Color) -> impl Fn(&Theme) -> container::Style {
    move |theme| container::Style::default().background(color(tokens(theme)))
}

// Buttons.

fn flat(ink: Color, background: Option<Color>, radius: f32) -> button::Style {
    button::Style {
        background: background.map(Background::Color),
        text_color: ink,
        border: border::rounded(radius),
        ..button::Style::default()
    }
}

/// A tab in the rail.
pub fn tab(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let tokens = tokens(theme);
        let ink = if selected { tokens.ink } else { tokens.muted };
        match status {
            button::Status::Hovered => flat(tokens.ink, Some(tokens.recess), radius::M),
            button::Status::Pressed => flat(tokens.ink, Some(tokens.line), radius::M),
            _ => flat(ink, None, radius::M),
        }
    }
}

/// What the pointer is doing to a surface that is not a button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    Idle,
    Hovered,
    /// Held down and being moved.
    Dragged,
}

/// A tab that can be dragged among the others. It looks like [`tab`], and
/// stays lit while it is held.
pub fn tab_surface(selected: bool, held: Held) -> impl Fn(&Theme) -> container::Style {
    move |theme| {
        let tokens = tokens(theme);
        let (ink, background) = match held {
            Held::Dragged => (tokens.ink, Some(tokens.line)),
            Held::Hovered => (tokens.ink, Some(tokens.recess)),
            Held::Idle if selected => (tokens.ink, None),
            Held::Idle => (tokens.muted, None),
        };
        container::Style {
            text_color: Some(ink),
            background: background.map(Background::Color),
            border: border::rounded(radius::M),
            ..container::Style::default()
        }
    }
}

/// A pane listed under its tab. The current one sits on paper.
pub fn outline_item(current: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let tokens = tokens(theme);
        match (current, status) {
            (true, _) => flat(tokens.ink, Some(tokens.paper), radius::S),
            (false, button::Status::Hovered | button::Status::Pressed) => {
                flat(tokens.ink, Some(tokens.recess), radius::S)
            }
            (false, _) => flat(tokens.muted, None, radius::S),
        }
    }
}

/// A control that stays out of the way: a close mark, a toolbar button.
pub fn quiet(theme: &Theme, status: button::Status) -> button::Style {
    let tokens = tokens(theme);
    match status {
        button::Status::Hovered => flat(tokens.ink, Some(tokens.line), radius::S),
        button::Status::Pressed => flat(
            tokens.ink,
            Some(mix(tokens.line, tokens.ink, 0.15)),
            radius::S,
        ),
        button::Status::Disabled => flat(mix(tokens.muted, tokens.bg, 0.5), None, radius::S),
        button::Status::Active => flat(tokens.muted, None, radius::S),
    }
}

/// A control in a status line. It takes the line's own text colour.
pub fn status_control(focused: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let tokens = tokens(theme);
        let (ink, base) = if focused {
            (tokens.accent_ink, tokens.accent)
        } else {
            (tokens.muted, tokens.recess)
        };
        let background = match status {
            button::Status::Hovered => Some(mix(base, ink, 0.18)),
            button::Status::Pressed => Some(mix(base, ink, 0.3)),
            _ => None,
        };
        flat(ink, background, radius::S)
    }
}

/// One choice of several: an editor mode, a sidebar view.
pub fn toggle(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let tokens = tokens(theme);
        match (selected, status) {
            (true, _) => flat(tokens.ink, Some(tokens.line), radius::S),
            (false, button::Status::Hovered | button::Status::Pressed) => flat(
                tokens.ink,
                Some(mix(tokens.paper, tokens.line, 0.5)),
                radius::S,
            ),
            (false, _) => flat(tokens.muted, None, radius::S),
        }
    }
}

/// A row in a list inside a pane: a file, a search result, a tag.
pub fn list_row(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let tokens = tokens(theme);
        match (selected, status) {
            (true, _) => flat(tokens.ink, Some(tokens.line), radius::S),
            (false, button::Status::Hovered | button::Status::Pressed) => flat(
                tokens.ink,
                Some(mix(tokens.paper, tokens.line, 0.5)),
                radius::S,
            ),
            (false, _) => flat(tokens.ink, None, radius::S),
        }
    }
}

/// A row in an overlay panel. The chosen one is filled with the accent.
pub fn choice(selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |theme, status| {
        let tokens = tokens(theme);
        match (selected, status) {
            (true, _) => flat(tokens.accent_ink, Some(tokens.accent), radius::M),
            (false, button::Status::Hovered | button::Status::Pressed) => {
                flat(tokens.ink, Some(tokens.recess), radius::M)
            }
            (false, _) => flat(tokens.ink, None, radius::M),
        }
    }
}

/// The one action a surface is for: Send.
pub fn primary(theme: &Theme, status: button::Status) -> button::Style {
    let tokens = tokens(theme);
    let background = match status {
        button::Status::Hovered => mix(tokens.ink, tokens.paper, 0.15),
        button::Status::Pressed => mix(tokens.ink, tokens.paper, 0.3),
        button::Status::Disabled => tokens.line,
        button::Status::Active => tokens.ink,
    };
    button::Style {
        background: Some(Background::Color(background)),
        text_color: if status == button::Status::Disabled {
            tokens.muted
        } else {
            tokens.paper
        },
        border: outline(background, radius::L),
        ..button::Style::default()
    }
}

/// An action beside the main one: outlined in ink, filled on press.
pub fn secondary(theme: &Theme, status: button::Status) -> button::Style {
    let tokens = tokens(theme);
    match status {
        button::Status::Pressed => button::Style {
            background: Some(Background::Color(tokens.ink)),
            text_color: tokens.paper,
            border: outline(tokens.ink, radius::M),
            ..button::Style::default()
        },
        button::Status::Hovered => button::Style {
            background: Some(Background::Color(tokens.line)),
            text_color: tokens.ink,
            border: outline(tokens.ink, radius::M),
            ..button::Style::default()
        },
        button::Status::Disabled => button::Style {
            background: None,
            text_color: tokens.muted,
            border: outline(tokens.line, radius::M),
            ..button::Style::default()
        },
        button::Status::Active => button::Style {
            background: None,
            text_color: tokens.ink,
            border: outline(tokens.ink, radius::M),
            ..button::Style::default()
        },
    }
}

/// An action that ends something: Stop.
pub fn danger(theme: &Theme, status: button::Status) -> button::Style {
    let tokens = tokens(theme);
    let background = match status {
        button::Status::Hovered | button::Status::Pressed => Some(tokens.bad_soft),
        _ => None,
    };
    button::Style {
        background: background.map(Background::Color),
        text_color: tokens.bad,
        border: outline(tokens.bad, radius::L),
        ..button::Style::default()
    }
}

/// Text that acts as a link: a backlink, a note to open.
pub fn link(theme: &Theme, status: button::Status) -> button::Style {
    let tokens = tokens(theme);
    match status {
        button::Status::Hovered | button::Status::Pressed => {
            flat(tokens.accent, Some(tokens.accent_soft), radius::S)
        }
        _ => flat(tokens.accent, None, radius::S),
    }
}

// Inputs.

/// A field with an outline: the composer's neighbours, a property value.
pub fn input(theme: &Theme, status: text_input::Status) -> text_input::Style {
    let tokens = tokens(theme);
    let edge = match status {
        text_input::Status::Focused { .. } => tokens.accent,
        text_input::Status::Hovered => tokens.muted,
        _ => tokens.line,
    };
    text_input::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: outline(edge, radius::M),
        icon: tokens.muted,
        placeholder: tokens.muted,
        value: tokens.ink,
        selection: tokens.terminal.selection,
    }
}

/// A field with no outline, for a surface that is itself the field: the
/// query of an overlay panel.
pub fn bare_input(theme: &Theme, _status: text_input::Status) -> text_input::Style {
    let tokens = tokens(theme);
    text_input::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border::default(),
        icon: tokens.muted,
        placeholder: tokens.muted,
        value: tokens.ink,
        selection: tokens.terminal.selection,
    }
}

/// The note being written: the pane itself is the page.
pub fn page(theme: &Theme, _status: text_editor::Status) -> text_editor::Style {
    let tokens = tokens(theme);
    text_editor::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: Border::default(),
        placeholder: tokens.muted,
        value: tokens.ink,
        selection: tokens.terminal.selection,
    }
}

/// The box a message to an agent is written in.
pub fn composer(theme: &Theme, status: text_editor::Status) -> text_editor::Style {
    let tokens = tokens(theme);
    let edge = match status {
        text_editor::Status::Focused { .. } => tokens.accent,
        text_editor::Status::Hovered => tokens.muted,
        _ => tokens.line,
    };
    text_editor::Style {
        background: Background::Color(Color::TRANSPARENT),
        border: outline(edge, radius::L),
        placeholder: tokens.muted,
        value: tokens.ink,
        selection: tokens.terminal.selection,
    }
}

// Scrolling and splitting.

/// A thin scrollbar that shows only as much as it must.
pub fn scrollbar(theme: &Theme, status: scrollable::Status) -> scrollable::Style {
    let tokens = tokens(theme);
    let (hovered, dragged) = match status {
        scrollable::Status::Active { .. } => (false, false),
        scrollable::Status::Hovered {
            is_horizontal_scrollbar_hovered,
            is_vertical_scrollbar_hovered,
            ..
        } => (
            is_horizontal_scrollbar_hovered || is_vertical_scrollbar_hovered,
            false,
        ),
        scrollable::Status::Dragged { .. } => (true, true),
    };
    let scroller = if dragged {
        tokens.ink
    } else if hovered {
        tokens.muted
    } else {
        tokens.line
    };
    let rail = scrollable::Rail {
        background: None,
        border: Border::default(),
        scroller: scrollable::Scroller {
            background: Background::Color(scroller),
            border: border::rounded(radius::FULL),
        },
    };
    scrollable::Style {
        container: container::Style::default(),
        vertical_rail: rail,
        horizontal_rail: rail,
        gap: None,
        auto_scroll: scrollable::AutoScroll {
            background: Background::Color(tokens.paper),
            border: outline(tokens.line, radius::FULL),
            shadow: Shadow::default(),
            icon: tokens.muted,
        },
    }
}

/// The scrollbar every scrolling surface uses.
pub fn scroll_direction() -> scrollable::Direction {
    scrollable::Direction::Vertical(thin_bar())
}

pub fn scroll_direction_across() -> scrollable::Direction {
    scrollable::Direction::Horizontal(thin_bar())
}

fn thin_bar() -> scrollable::Scrollbar {
    scrollable::Scrollbar::new()
        .width(measure::SCROLLBAR)
        .scroller_width(measure::SCROLLER)
        .margin(space::XXS)
}

/// The divider between panes shows as an accent line while the pointer is
/// on it, and where a dragged pane would land.
pub fn splits(theme: &Theme) -> pane_grid::Style {
    let tokens = tokens(theme);
    let grip = pane_grid::Line {
        color: tokens.accent,
        width: measure::SPLIT_GRIP,
    };
    pane_grid::Style {
        hovered_region: pane_grid::Highlight {
            background: Background::Color(tokens.accent.scale_alpha(0.18)),
            border: outline(tokens.accent, radius::L),
        },
        picked_split: grip,
        hovered_split: pane_grid::Line {
            color: tokens.muted,
            width: measure::SPLIT_GRIP,
        },
    }
}

// Rendered Markdown.

/// How rendered Markdown is set: prose at `text_size`, links in the accent,
/// inline code on a quiet patch. `focused` is the pane's.
pub fn prose(mode: Mode, focused: bool, text_size: f32) -> markdown::Settings {
    let tokens = mode.tokens();
    let style = markdown::Style {
        font: ui(),
        inline_code_highlight: markdown::Highlight {
            background: Background::Color(if focused { tokens.recess } else { tokens.line }),
            border: border::rounded(radius::XS),
        },
        inline_code_padding: Padding::from([space::NONE, space::XS]),
        inline_code_color: tokens.ink,
        inline_code_font: mono(),
        code_block_font: mono(),
        link_color: tokens.accent,
    };
    markdown::Settings {
        text_size: text_size.into(),
        h1_size: size::TITLE.into(),
        h2_size: size::SUBTITLE.into(),
        h3_size: size::HEADING.into(),
        h4_size: text_size.into(),
        h5_size: text_size.into(),
        h6_size: text_size.into(),
        code_size: size::MONO.into(),
        spacing: space::XL.into(),
        style,
    }
}

/// The syntax colours the editor draws Markdown source with.
pub fn highlight(mode: Mode) -> iced::highlighter::Theme {
    match mode {
        Mode::Dark => iced::highlighter::Theme::Base16Ocean,
        Mode::Light => iced::highlighter::Theme::InspiredGitHub,
    }
}

/// How highlighted Markdown source is drawn in the editor: the syntax
/// colours, in the text font, so a bold heading matches the prose around it.
pub fn source(
    highlight: &iced::highlighter::Highlight,
    theme: &Theme,
) -> iced::advanced::text::highlighter::Format<iced::Font> {
    let tokens = tokens(theme);
    // The harder of the two backgrounds a pane can have.
    let background = if theme.extended_palette().is_dark {
        tokens.paper
    } else {
        tokens.recess
    };
    iced::advanced::text::highlighter::Format {
        color: highlight
            .color()
            .map(|color| readable(color, background, tokens.ink, TEXT_CONTRAST)),
        font: highlight.font().map(|font| iced::Font {
            family: ui().family,
            ..font
        }),
    }
}

/// The least contrast for text, from WCAG 2 level AA.
const TEXT_CONTRAST: f32 = 4.5;

/// The settings for highlighting source in a mode. `syntax` names the
/// language by its file extension: `md` for a note.
pub fn source_settings(mode: Mode, syntax: &str) -> iced::highlighter::Settings {
    iced::highlighter::Settings {
        theme: highlight(mode),
        token: syntax.to_string(),
    }
}

/// A block of code or output: plain monospace in a well that scrolls
/// sideways, so a long line never widens the pane.
pub fn code_block<'a, Message: 'a>(code: &'a str, focused: bool) -> Element<'a, Message> {
    container(
        scrollable(
            container(
                text(code.trim_end())
                    .font(mono())
                    .size(size::MONO)
                    .wrapping(text::Wrapping::None),
            )
            .padding(Padding::from([space::L, space::XL])),
        )
        .direction(scroll_direction_across())
        .style(scrollbar),
    )
    .width(Length::Fill)
    .style(well(focused))
    .into()
}

// Shared chrome.

/// A horizontal hairline.
pub fn hline<'a, Message: 'a>() -> Element<'a, Message> {
    container(Space::new())
        .width(Length::Fill)
        .height(measure::LINE)
        .style(fill(|tokens| tokens.line))
        .into()
}

/// A vertical hairline.
pub fn vline<'a, Message: 'a>() -> Element<'a, Message> {
    container(Space::new())
        .width(measure::LINE)
        .height(Length::Fill)
        .style(fill(|tokens| tokens.line))
        .into()
}

/// A vertical guide: beside the panes of a tab, beside an agent's steps.
pub fn guide<'a, Message: 'a>() -> Element<'a, Message> {
    container(Space::new())
        .width(measure::GUIDE)
        .height(Length::Fill)
        .style(fill(|tokens| tokens.line))
        .into()
}

/// The accent bar beside what the person asked and beside the current pane.
pub fn mark<'a, Message: 'a>() -> Element<'a, Message> {
    container(Space::new())
        .width(measure::MARK)
        .height(Length::Fill)
        .style(|theme: &Theme| {
            container::Style::default()
                .background(tokens(theme).accent)
                .border(border::rounded(radius::XS))
        })
        .into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Done,
    Failed,
    Running,
    Quiet,
}

/// The marker in front of a step: a dot, or a square for a failure, so the
/// two differ by more than colour.
pub fn dot<'a, Message: 'a>(step: Step) -> Element<'a, Message> {
    container(Space::new())
        .width(measure::DOT)
        .height(measure::DOT)
        .style(move |theme: &Theme| {
            let tokens = tokens(theme);
            let (color, radius) = match step {
                Step::Done => (tokens.ok, radius::FULL),
                Step::Failed => (tokens.bad, radius::XS / 2.0),
                Step::Running => (tokens.accent, radius::FULL),
                Step::Quiet => (tokens.muted, radius::FULL),
            };
            container::Style::default()
                .background(color)
                .border(border::rounded(radius))
        })
        .into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    SplitRight,
    SplitDown,
    Magnify,
    Restore,
}

/// A status line icon, drawn from boxes so it is sharp at any scale and
/// needs no icon font. `focused` is the pane's.
pub fn icon<'a, Message: 'a>(icon: Icon, focused: bool) -> Element<'a, Message> {
    let ink = move |theme: &Theme| {
        let tokens = tokens(theme);
        if focused {
            tokens.accent_ink
        } else {
            tokens.muted
        }
    };
    let frame = move |theme: &Theme| {
        container::Style::default().border(Border {
            color: ink(theme),
            width: measure::LINE,
            radius: (radius::XS / 2.0).into(),
        })
    };
    let solid = move |theme: &Theme| container::Style::default().background(ink(theme));
    let inner: Element<'a, Message> = match icon {
        Icon::SplitRight => container(
            container(Space::new())
                .width(measure::LINE)
                .height(Length::Fill)
                .style(solid),
        )
        .center_x(Length::Fill)
        .into(),
        Icon::SplitDown => container(
            container(Space::new())
                .width(Length::Fill)
                .height(measure::LINE)
                .style(solid),
        )
        .center_y(Length::Fill)
        .into(),
        Icon::Magnify => column![
            container(Space::new())
                .width(Length::Fill)
                .height(measure::LINE * 2.0)
                .style(solid)
        ]
        .into(),
        Icon::Restore => container(
            container(Space::new())
                .width(measure::ICON_WIDTH / 2.0)
                .height(measure::ICON_HEIGHT / 2.0)
                .style(solid),
        )
        .align_right(Length::Fill)
        .align_bottom(Length::Fill)
        .into(),
    };
    container(inner)
        .width(measure::ICON_WIDTH)
        .height(measure::ICON_HEIGHT)
        .style(frame)
        .into()
}

/// What stands in front of a name in the files pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    /// A folder that is closed, and one that is open.
    Closed,
    Open,
    /// An open folder whose contents are still being read.
    Loading,
    /// An open folder that could not be read.
    Unreadable,
    /// A file, with a short tag for its kind, or none.
    Tag(&'static str),
}

/// The marker of a row in the files pane, in a column of fixed width so
/// the names line up. `selected` is the row's.
pub fn file_marker<'a, Message: 'a>(marker: Marker, selected: bool) -> Element<'a, Message> {
    let (label, tone) = match marker {
        Marker::Closed => ("▸", None),
        Marker::Open => ("▾", None),
        Marker::Loading => ("…", Some(Tone::Muted)),
        Marker::Unreadable => ("!", Some(Tone::Bad)),
        Marker::Tag(tag) => (tag, Some(Tone::Muted)),
    };
    let glyph = matches!(marker, Marker::Closed | Marker::Open);
    let label = text(label)
        .size(if glyph { size::LABEL } else { size::TAG })
        .font(if glyph { ui() } else { mono() })
        .wrapping(text::Wrapping::None);
    container(match tone {
        Some(tone) if !selected => label.style(toned(tone)),
        _ => label.style(inherit),
    })
    .width(measure::FILE_MARK)
    .into()
}

/// The letter that says what git has seen change in a row of the files
/// pane. On a selected row it takes the row's own ink.
pub fn change_mark<'a, Message: 'a>(
    letter: &'static str,
    tone: Tone,
    selected: bool,
) -> Element<'a, Message> {
    let letter = text(letter)
        .font(super::mono_strong())
        .size(size::META)
        .wrapping(text::Wrapping::None);
    container(if selected {
        letter.style(inherit)
    } else {
        letter.style(toned(tone))
    })
    .width(measure::CHANGE_MARK)
    .into()
}

/// A square button for a status line, holding an icon or a close mark.
pub fn control<'a, Message: Clone + 'a>(
    content: impl Into<Element<'a, Message>>,
    focused: bool,
    on_press: Message,
) -> Element<'a, Message> {
    button(
        container(content)
            .center_x(Length::Fill)
            .center_y(Length::Fill),
    )
    .width(measure::CONTROL)
    .height(measure::CONTROL)
    .padding(space::NONE)
    .style(status_control(focused))
    .on_press(on_press)
    .into()
}

/// The close mark.
pub fn close_mark<'a>() -> iced::widget::Text<'a> {
    text("×")
        .size(size::GLYPH)
        .line_height(super::leading::GLYPH)
}

/// A key or a shortcut, set in monospace.
pub fn keys<'a, Message: 'a>(label: &'a str) -> Element<'a, Message> {
    text(label)
        .font(mono())
        .size(size::META)
        .style(inherit)
        .into()
}

/// A name and what belongs to it on one line, as in a status line: the
/// name is strong, the rest is plain.
pub fn named<'a, Message: 'a>(name: &'a str, rest: String) -> Element<'a, Message> {
    row![
        text(name)
            .font(super::ui_strong())
            .size(size::META)
            .style(inherit)
            .wrapping(text::Wrapping::None),
        text(rest)
            .size(size::META)
            .style(inherit)
            .wrapping(text::Wrapping::None),
    ]
    .spacing(space::L)
    .into()
}

/// One row of an overlay panel: a name, and a quiet note at the right such
/// as a shortcut or the folder a note is in.
pub fn choice_row<'a, Message: Clone + 'a>(
    name: impl text::IntoFragment<'a>,
    note: Option<Element<'a, Message>>,
    selected: bool,
    on_press: Message,
) -> Element<'a, Message> {
    let mut content = row![
        text(name)
            .size(size::BODY)
            .style(inherit)
            .wrapping(text::Wrapping::None)
            .width(Length::Fill)
    ]
    .spacing(space::L)
    .align_y(iced::Alignment::Center);
    if let Some(note) = note {
        content = content.push(note);
    }
    button(content)
        .width(Length::Fill)
        .padding(Padding::from([space::M, space::L]))
        .style(choice(selected))
        .on_press(on_press)
        .into()
}

/// The quiet note at the right of a row in an overlay panel.
pub fn choice_note<'a, Message: 'a>(note: String, selected: bool) -> Element<'a, Message> {
    text(note)
        .font(mono())
        .size(size::META)
        .wrapping(text::Wrapping::None)
        .style(if selected { inherit } else { muted })
        .into()
}

/// An overlay panel: the query on top, the choices, and the keys that act
/// on them along the bottom.
pub fn panel<'a, Message: 'a>(
    query: impl Into<Element<'a, Message>>,
    choices: Vec<Element<'a, Message>>,
    hints: &[(&'static str, &'static str)],
    width: f32,
) -> Element<'a, Message> {
    let mut footer = row![].spacing(space::XL);
    let hint_count = hints.len();
    for (key, action) in hints {
        footer = footer.push(
            row![
                text(*key).font(mono()).size(size::META).style(muted),
                text(*action).size(size::META).style(muted)
            ]
            .spacing(space::S)
            .align_y(iced::Alignment::Center),
        );
    }
    let mut body = column![container(query.into()).padding(Padding::from([space::L, space::XL]))];
    if !choices.is_empty() {
        body = body.push(hline()).push(
            scrollable(column(choices).spacing(space::XXS).padding(space::S))
                .direction(scroll_direction())
                .style(scrollbar),
        );
    }
    body = body.push(hline()).push(
        container(if hint_count > 0 {
            Element::from(footer.wrap())
        } else {
            Space::new().into()
        })
        .padding(Padding::from([space::M, space::XXL])),
    );
    container(body)
        .width(width)
        .padding(measure::OUTLINE)
        .style(overlay_panel)
        .into()
}

/// Puts an overlay panel over a dimmed surface, a set distance from its top.
pub fn overlay<'a, Message: 'a>(panel: Element<'a, Message>, top: f32) -> Element<'a, Message> {
    container(panel)
        .center_x(Length::Fill)
        .height(Length::Fill)
        .padding(
            Padding::default()
                .top(top)
                .bottom(space::HUGE)
                .left(space::L)
                .right(space::L),
        )
        .style(scrim)
        .into()
}
