//! The look of the shell: every colour, size, space and font in one place.
//!
//! The view code names roles (a tab, a title bar, a list row) and never a
//! colour or a size, so a different visual direction is a change to this
//! module and nothing else. `tokens` holds the values and the theme choice,
//! `widget` holds one style per role and the few shared pieces of chrome.

pub mod tokens;
pub mod widget;

pub use tokens::{Mode, Terminal, Tokens, contrast, mix, readable, tokens};
pub use widget::*;

use std::sync::OnceLock;

use iced::font::{Family, Weight};
use iced::{Font, Pixels};

/// Text sizes in pixels.
pub mod size {
    /// Body text and controls.
    pub const BODY: f32 = 15.0;
    /// Secondary rows: the panes listed under a tab, results, properties.
    pub const LABEL: f32 = 14.0;
    /// Metadata: status lines, counts, shortcut hints.
    pub const META: f32 = 13.0;
    /// What an agent wrote, set a little larger to be read.
    pub const PROSE: f32 = 16.5;
    /// What the person asked.
    pub const ASK: f32 = 19.0;
    /// The query typed into an overlay panel.
    pub const QUERY: f32 = 18.0;
    /// Headings in rendered Markdown, largest first.
    pub const TITLE: f32 = 24.0;
    pub const SUBTITLE: f32 = 20.0;
    pub const HEADING: f32 = 17.0;
    /// Terminal cells and code.
    pub const MONO: f32 = 13.0;
    /// A glyph that stands in for an icon.
    pub const GLYPH: f32 = 14.0;
    /// The tag for a file's kind, small beside the name it marks.
    pub const TAG: f32 = 11.0;
}

/// Line heights, as a multiple of the text size.
pub mod leading {
    /// A glyph centred in a square control.
    pub const GLYPH: f32 = 1.0;
    /// A line that is set large, such as what the person asked.
    pub const DISPLAY: f32 = 1.35;
    /// Terminal rows, set open so long output is easy to follow by eye.
    pub const TERMINAL: f32 = 1.5;
}

/// The spacing scale in pixels. Padding and gaps come from these steps.
pub mod space {
    pub const NONE: f32 = 0.0;
    pub const XXS: f32 = 2.0;
    pub const XS: f32 = 4.0;
    pub const S: f32 = 6.0;
    pub const M: f32 = 8.0;
    pub const L: f32 = 10.0;
    pub const XL: f32 = 14.0;
    pub const XXL: f32 = 18.0;
    pub const HUGE: f32 = 22.0;
}

/// Corner radii in pixels.
pub mod radius {
    /// Inline code.
    pub const XS: f32 = 4.0;
    /// A row in a list.
    pub const S: f32 = 6.0;
    /// A tab, a well, a chosen row in an overlay panel.
    pub const M: f32 = 8.0;
    /// A pane, a button, an input.
    pub const L: f32 = 10.0;
    /// An overlay panel.
    pub const XL: f32 = 14.0;
    /// A pill.
    pub const FULL: f32 = 999.0;
}

/// Fixed measures of the chrome in pixels.
pub mod measure {
    /// A hairline between two parts of one surface.
    pub const LINE: f32 = 1.0;
    /// The outline of a control or an overlay panel.
    pub const OUTLINE: f32 = 1.5;
    /// The rail of tabs on the left.
    pub const RAIL: f32 = 224.0;
    /// Below this window width the rail becomes a bar across the top.
    pub const NARROW: f32 = 900.0;
    /// The line beside the panes listed under a tab, and beside steps.
    pub const GUIDE: f32 = 2.0;
    /// The bar that marks what the person asked, and the current pane.
    pub const MARK: f32 = 4.0;
    /// A square control in a status line.
    pub const CONTROL: f32 = 20.0;
    /// The box of a drawn icon.
    pub const ICON_WIDTH: f32 = 12.0;
    pub const ICON_HEIGHT: f32 = 10.0;
    /// The marker in front of a step an agent took.
    pub const DOT: f32 = 10.0;
    /// A row in the file tree, which is drawn a window at a time.
    pub const ROW: f32 = 30.0;
    pub const SCROLLBAR: f32 = 8.0;
    pub const SCROLLER: f32 = 4.0;
    /// The line drawn on a divider while the pointer is on it.
    pub const SPLIT_GRIP: f32 = 3.0;
    /// How far from a divider a drag may start.
    pub const SPLIT_LEEWAY: f32 = 10.0;
    /// The marker in front of a name in the files pane: an arrow for a
    /// folder, a short tag for a file's kind.
    pub const FILE_MARK: f32 = 26.0;
    /// The letter at the end of a row that says what git has seen change.
    pub const CHANGE_MARK: f32 = 12.0;
    /// One level of indent in the file tree.
    pub const INDENT: f32 = 18.0;
    pub const SIDEBAR: f32 = 184.0;
    pub const PROPERTY_KEY: f32 = 88.0;
    /// The widest a column of prose gets.
    pub const READING: f32 = 660.0;
    pub const PALETTE: f32 = 520.0;
    pub const SWITCHER: f32 = 520.0;
    pub const COMPLETION: f32 = 300.0;
    /// How far from the top of the window an overlay panel opens.
    pub const OVERLAY_TOP: f32 = 96.0;
    pub const COMPOSER_MAX: f32 = 160.0;
    /// The field a tab's name is typed in, in the bar of a narrow window.
    pub const TAB_NAME: f32 = 180.0;
    /// The soft shadow: how far it falls and how far it spreads.
    pub const SHADOW_DROP: f32 = 6.0;
    pub const SHADOW_BLUR: f32 = 24.0;
    /// The longest a tab title and a status line's context may be.
    pub const TAB_TITLE_CHARS: usize = 22;
    pub const CONTEXT_CHARS: usize = 80;
}

/// Font families, tried in order. The first one installed is used.
///
/// These are fonts macOS ships. To bundle a typeface instead, load its files
/// at start-up and put its family name first in each list.
pub const UI_FAMILIES: &[&str] = &["Helvetica Neue", "Helvetica"];
pub const MONO_FAMILIES: &[&str] = &["Menlo", "Monaco"];

#[derive(Debug, Clone, Copy)]
struct Families {
    ui: Family,
    mono: Family,
}

/// Picks the first installed family from each list and makes the pair the
/// system's answer to "sans-serif" and "monospace" too, so text a widget
/// styles on its own, such as bold in highlighted source, matches the rest.
/// Where none is installed, as on Linux, the generic families stand.
fn installed() -> Families {
    let generic = Families {
        ui: Family::SansSerif,
        mono: Family::Monospace,
    };
    if !cfg!(target_os = "macos") {
        return generic;
    }
    let Ok(mut system) = iced::advanced::graphics::text::font_system().write() else {
        return generic;
    };
    let database = system.raw().db_mut();
    let first = |wanted: &[&'static str]| {
        wanted.iter().copied().find(|name| {
            database
                .faces()
                .any(|face| face.families.iter().any(|(family, _)| family == name))
        })
    };
    let (ui, mono) = (first(UI_FAMILIES), first(MONO_FAMILIES));
    if let Some(name) = ui {
        database.set_sans_serif_family(name);
    }
    if let Some(name) = mono {
        database.set_monospace_family(name);
    }
    Families {
        ui: ui.map_or(generic.ui, Family::Name),
        mono: mono.map_or(generic.mono, Family::Name),
    }
}

fn families() -> Families {
    static FAMILIES: OnceLock<Families> = OnceLock::new();
    *FAMILIES.get_or_init(installed)
}

/// The font for text.
pub fn ui() -> Font {
    Font {
        family: families().ui,
        ..Font::DEFAULT
    }
}

/// The text font at the weight that marks a name or a heading.
pub fn ui_strong() -> Font {
    Font {
        weight: Weight::Semibold,
        ..ui()
    }
}

/// The font for data: paths, counts, tool calls, code, the terminal.
pub fn mono() -> Font {
    Font {
        family: families().mono,
        ..Font::DEFAULT
    }
}

pub fn mono_strong() -> Font {
    Font {
        weight: Weight::Semibold,
        ..mono()
    }
}

/// The size the app draws text at when a widget names none.
pub fn default_text_size() -> Pixels {
    Pixels(size::BODY)
}

/// Shortens a title to a number of characters, marking the cut.
pub fn clip_end(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// Shortens a path to a number of characters, keeping its end: the file or
/// the innermost folders say more than the root does.
pub fn clip_start(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().skip(count - limit.saturating_sub(1)).collect();
    format!("…{}", kept.trim_start())
}

/// A path with the home folder written as `~`.
pub fn tilde(path: &std::path::Path) -> String {
    let shown = path.to_string_lossy();
    match dirs::home_dir() {
        Some(home) => tilde_in(&shown, &home.to_string_lossy()),
        None => shown.into_owned(),
    }
}

fn tilde_in(path: &str, home: &str) -> String {
    match path.strip_prefix(home) {
        Some("") => String::from("~"),
        Some(rest) if rest.starts_with('/') && !home.is_empty() => format!("~{rest}"),
        _ => path.to_string(),
    }
}

/// The window's size when nothing asks for another.
pub const DEFAULT_WINDOW: (f32, f32) = (1280.0, 800.0);

/// The window size asked for in `KRANG_WINDOW_SIZE`, written `1280x800`.
pub fn window_size(setting: Option<&str>) -> Option<(f32, f32)> {
    let (width, height) = setting?.split_once('x')?;
    let width: f32 = width.trim().parse().ok()?;
    let height: f32 = height.trim().parse().ok()?;
    (width >= 200.0 && height >= 150.0).then_some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_cut_at_the_end_and_paths_at_the_start() {
        assert_eq!(clip_end("short", 10), "short");
        assert_eq!(clip_end("a long tab title", 7), "a long…");
        assert_eq!(clip_start("~/src/demo", 20), "~/src/demo");
        assert_eq!(clip_start("~/src/demo/notes/today.md", 9), "…today.md");
        assert_eq!(clip_end("naïve café", 6).chars().count(), 6);
    }

    #[test]
    fn the_home_folder_is_written_as_a_tilde() {
        assert_eq!(tilde_in("/home/me", "/home/me"), "~");
        assert_eq!(tilde_in("/home/me/src", "/home/me"), "~/src");
        assert_eq!(tilde_in("/home/meadow", "/home/me"), "/home/meadow");
        assert_eq!(tilde_in("/tmp/demo", "/home/me"), "/tmp/demo");
    }

    #[test]
    fn a_window_size_is_two_numbers_and_a_cross() {
        assert_eq!(window_size(Some("1280x800")), Some((1280.0, 800.0)));
        assert_eq!(window_size(Some("900 x 600")), Some((900.0, 600.0)));
        assert_eq!(window_size(Some("wide")), None);
        assert_eq!(window_size(Some("10x10")), None);
        assert_eq!(window_size(None), None);
    }
}
