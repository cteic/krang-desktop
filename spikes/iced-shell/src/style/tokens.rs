//! The colour tokens for dark and light, and the choice between them.

use iced::theme::palette::{Extended, Pair};
use iced::theme::{self, Palette};
use iced::{Color, Theme};

const fn hex(value: u32) -> Color {
    Color::from_rgb8((value >> 16) as u8, (value >> 8) as u8, value as u8)
}

/// What a terminal draws with. The 16 colours are the ANSI set in order:
/// black, red, green, yellow, blue, magenta, cyan, white, then the bright
/// eight.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Terminal {
    pub foreground: Color,
    /// Behind the text of the focused terminal. Cells a program leaves at
    /// the default background are not painted, so the pane shows through.
    pub background: Color,
    /// Behind the text of a terminal that is not focused.
    pub background_idle: Color,
    pub cursor: Color,
    pub selection: Color,
    pub ansi: [Color; 16],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tokens {
    /// Behind everything: the window and the tab rail.
    pub bg: Color,
    /// A pane that is not focused, and wells inside the focused one.
    pub recess: Color,
    /// The focused pane and anything that floats above the window.
    pub paper: Color,
    /// Lines, and the quiet selection in a list. Muted text is never drawn
    /// on it: in light mode that pair is 4.26:1.
    pub line: Color,
    /// Text.
    pub ink: Color,
    /// Text that is not the point: metadata, placeholders.
    pub muted: Color,
    /// The focused pane's status line, the chosen row, links.
    pub accent: Color,
    /// Text on the accent colour.
    pub accent_ink: Color,
    /// A quiet accent: a notice that needs an answer.
    pub accent_soft: Color,
    pub ok: Color,
    pub ok_soft: Color,
    pub bad: Color,
    pub bad_soft: Color,
    /// Something is waiting on the person.
    pub wait: Color,
    /// Dims the window behind an overlay panel.
    pub scrim: Color,
    /// The soft shadow under the focused pane and overlay panels.
    pub shadow: Color,
    pub terminal: Terminal,
}

const DARK_RECESS: Color = hex(0x17151b);
const DARK_PAPER: Color = hex(0x201d26);
const DARK_INK: Color = hex(0xece8f1);
const DARK_MUTED: Color = hex(0xa39cae);
const DARK_ACCENT: Color = hex(0xf09bd0);
const DARK_OK: Color = hex(0x7fd6a0);
const DARK_BAD: Color = hex(0xff9a8d);
const DARK_WAIT: Color = hex(0xe6bf6a);

pub const DARK: Tokens = Tokens {
    bg: hex(0x0f0e12),
    recess: DARK_RECESS,
    paper: DARK_PAPER,
    line: hex(0x37323f),
    ink: DARK_INK,
    muted: DARK_MUTED,
    accent: DARK_ACCENT,
    accent_ink: hex(0x2a0a1d),
    accent_soft: hex(0x3a1f30),
    ok: DARK_OK,
    ok_soft: hex(0x173022),
    bad: DARK_BAD,
    bad_soft: hex(0x3a1b18),
    wait: DARK_WAIT,
    scrim: Color::from_rgba8(15, 14, 18, 0.45),
    shadow: Color::from_rgba8(0, 0, 0, 0.45),
    terminal: Terminal {
        foreground: DARK_INK,
        background: DARK_PAPER,
        background_idle: DARK_RECESS,
        cursor: DARK_INK,
        // The accent at 30% over paper.
        selection: hex(0x5e4359),
        ansi: [
            hex(0x4a4455),
            DARK_BAD,
            DARK_OK,
            DARK_WAIT,
            hex(0x9db4ff),
            DARK_ACCENT,
            hex(0x6fd0d6),
            DARK_INK,
            DARK_MUTED,
            hex(0xffb9af),
            hex(0xa5e6bd),
            hex(0xf2d590),
            hex(0xbccbff),
            hex(0xf7bfe1),
            hex(0x9be0e5),
            hex(0xffffff),
        ],
    },
};

const LIGHT_RECESS: Color = hex(0xeff0f2);
const LIGHT_PAPER: Color = hex(0xfcfcfb);
const LIGHT_INK: Color = hex(0x1c1a20);
const LIGHT_MUTED: Color = hex(0x625e6a);
const LIGHT_ACCENT: Color = hex(0x86205f);
const LIGHT_OK: Color = hex(0x24703f);
const LIGHT_BAD: Color = hex(0xad2318);
const LIGHT_WAIT: Color = hex(0x7a5600);

pub const LIGHT: Tokens = Tokens {
    bg: hex(0xe6e7ea),
    recess: LIGHT_RECESS,
    paper: LIGHT_PAPER,
    line: hex(0xd3d4d9),
    ink: LIGHT_INK,
    muted: LIGHT_MUTED,
    accent: LIGHT_ACCENT,
    accent_ink: hex(0xffffff),
    accent_soft: hex(0xf6e4ef),
    ok: LIGHT_OK,
    ok_soft: hex(0xe3f3e8),
    bad: LIGHT_BAD,
    bad_soft: hex(0xfbe9e6),
    wait: LIGHT_WAIT,
    scrim: Color::from_rgba8(15, 14, 18, 0.14),
    shadow: Color::from_rgba8(28, 26, 32, 0.14),
    terminal: Terminal {
        foreground: LIGHT_INK,
        background: LIGHT_PAPER,
        background_idle: LIGHT_RECESS,
        cursor: LIGHT_INK,
        // The accent at 30% over paper.
        selection: hex(0xd9bacc),
        // "White" is a grey here: programs print it as plain text, and it
        // has to read on a light background.
        ansi: [
            LIGHT_INK,
            LIGHT_BAD,
            LIGHT_OK,
            LIGHT_WAIT,
            hex(0x2a4fc0),
            LIGHT_ACCENT,
            hex(0x0b6a78),
            LIGHT_MUTED,
            hex(0x6c6875),
            hex(0xc22b1f),
            hex(0x1e7a43),
            hex(0x8a6200),
            hex(0x3a5fd6),
            hex(0xa02a74),
            hex(0x0c7482),
            hex(0x3d3a45),
        ],
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Dark,
    Light,
}

impl Mode {
    /// `light` or `dark`, as written in `KRANG_THEME`.
    pub fn from_setting(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "light" => Some(Mode::Light),
            "dark" => Some(Mode::Dark),
            _ => None,
        }
    }

    /// The mode `KRANG_THEME` fixes, if it names one.
    pub fn from_env() -> Option<Self> {
        Self::from_setting(&std::env::var("KRANG_THEME").ok()?)
    }

    /// A setting wins; without one the system's appearance decides, and
    /// dark is used when the system does not say.
    pub fn choose(setting: Option<Mode>, system: theme::Mode) -> Self {
        setting.unwrap_or(match system {
            theme::Mode::Light => Mode::Light,
            theme::Mode::Dark | theme::Mode::None => Mode::Dark,
        })
    }

    pub fn tokens(self) -> &'static Tokens {
        match self {
            Mode::Dark => &DARK,
            Mode::Light => &LIGHT,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Dark => "Krang Dark",
            Mode::Light => "Krang Light",
        }
    }

    /// The iced theme for the mode. Widgets with no style of their own,
    /// such as the tables, task boxes and quotes of rendered Markdown, draw
    /// from its palette, so the palette's steps are set from the tokens
    /// instead of left to iced, which tints them.
    pub fn theme(self) -> Theme {
        let tokens = *self.tokens();
        Theme::custom_with_fn(
            self.name(),
            Palette {
                background: tokens.paper,
                text: tokens.ink,
                primary: tokens.accent,
                success: tokens.ok,
                warning: tokens.wait,
                danger: tokens.bad,
            },
            move |palette| {
                let mut extended = Extended::generate(palette);
                let step = |color: Color| Pair {
                    color,
                    text: tokens.ink,
                };
                extended.background.weakest = step(mix(tokens.paper, tokens.recess, 0.5));
                extended.background.weaker = step(tokens.recess);
                extended.background.weak = step(mix(tokens.recess, tokens.line, 0.5));
                extended.background.neutral = step(tokens.line);
                extended.background.strong = step(tokens.line);
                extended.background.stronger = step(mix(tokens.line, tokens.muted, 0.2));
                extended.background.strongest = step(mix(tokens.line, tokens.muted, 0.35));
                let accent = Pair {
                    color: tokens.accent,
                    text: tokens.accent_ink,
                };
                extended.primary.base = accent;
                extended.primary.strong = accent;
                extended.primary.weak = step(tokens.accent_soft);
                extended.secondary.base = step(tokens.line);
                extended.secondary.weak = step(tokens.recess);
                extended.secondary.strong = step(mix(tokens.line, tokens.muted, 0.35));
                extended
            },
        )
    }
}

/// A colour between two others: `amount` of `b` over `a`.
pub fn mix(a: Color, b: Color, amount: f32) -> Color {
    Color {
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount,
        a: 1.0,
    }
}

/// A colour that reads as text on a background: the colour itself when it
/// already has `ratio` contrast, or else moved toward `ink` until it does.
/// Syntax colours come from fixed sets made for other backgrounds.
pub fn readable(color: Color, background: Color, ink: Color, ratio: f32) -> Color {
    let mut result = Color { a: 1.0, ..color };
    for _ in 0..12 {
        if contrast(result, background) >= ratio {
            break;
        }
        result = mix(result, ink, 0.2);
    }
    result
}

/// The tokens a theme was built from.
pub fn tokens(theme: &Theme) -> &'static Tokens {
    if theme.extended_palette().is_dark {
        &DARK
    } else {
        &LIGHT
    }
}

fn luminance(color: Color) -> f32 {
    let channel = |value: f32| {
        if value <= 0.03928 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/// The WCAG contrast ratio of two opaque colours, from 1 to 21.
pub fn contrast(a: Color, b: Color) -> f32 {
    let (a, b) = (luminance(a), luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The least contrast for normal text in WCAG 2 level AA.
    const TEXT: f32 = 4.5;

    #[test]
    fn contrast_matches_known_ratios() {
        assert!((contrast(Color::BLACK, Color::WHITE) - 21.0).abs() < 0.01);
        assert!((contrast(Color::WHITE, Color::WHITE) - 1.0).abs() < 0.01);
        assert_eq!(
            contrast(DARK.ink, DARK.bg),
            contrast(DARK.bg, DARK.ink),
            "the order of the two colours does not matter"
        );
        // #767676 on white is the textbook 4.54:1.
        assert!((contrast(hex(0x767676), Color::WHITE) - 4.54).abs() < 0.01);
    }

    #[test]
    fn a_setting_wins_and_dark_is_the_fallback() {
        assert_eq!(Mode::from_setting("light"), Some(Mode::Light));
        assert_eq!(Mode::from_setting(" DARK "), Some(Mode::Dark));
        assert_eq!(Mode::from_setting("system"), None);
        assert_eq!(Mode::from_setting(""), None);
        assert_eq!(Mode::choose(None, theme::Mode::Light), Mode::Light);
        assert_eq!(Mode::choose(None, theme::Mode::Dark), Mode::Dark);
        assert_eq!(Mode::choose(None, theme::Mode::None), Mode::Dark);
        assert_eq!(
            Mode::choose(Some(Mode::Dark), theme::Mode::Light),
            Mode::Dark
        );
        assert_eq!(
            Mode::choose(Some(Mode::Light), theme::Mode::Dark),
            Mode::Light
        );
    }

    #[test]
    fn a_colour_too_faint_to_read_is_moved_toward_the_ink() {
        for tokens in [&DARK, &LIGHT] {
            // Already readable: left alone.
            assert_eq!(
                readable(tokens.accent, tokens.paper, tokens.ink, TEXT),
                tokens.accent
            );
            // The line colour is far too faint for text.
            let fixed = readable(tokens.line, tokens.paper, tokens.ink, TEXT);
            assert_ne!(fixed, tokens.line);
            assert!(contrast(fixed, tokens.paper) >= TEXT);
        }
    }

    #[test]
    fn the_theme_palette_is_built_from_the_tokens() {
        for mode in [Mode::Dark, Mode::Light] {
            let (theme, tokens) = (mode.theme(), mode.tokens());
            let extended = theme.extended_palette();
            assert_eq!(extended.background.base.color, tokens.paper);
            assert_eq!(extended.background.strong.color, tokens.line);
            assert_eq!(extended.primary.base.color, tokens.accent);
            assert_eq!(extended.primary.base.text, tokens.accent_ink);
            assert_eq!(extended.is_dark, mode == Mode::Dark);
        }
    }

    #[test]
    fn a_theme_leads_back_to_its_tokens() {
        assert_eq!(tokens(&Mode::Dark.theme()), &DARK);
        assert_eq!(tokens(&Mode::Light.theme()), &LIGHT);
    }

    #[test]
    fn text_reads_on_every_background_it_is_drawn_on() {
        for tokens in [&DARK, &LIGHT] {
            let inks = [
                tokens.ink,
                tokens.muted,
                tokens.accent,
                tokens.ok,
                tokens.bad,
                tokens.wait,
            ];
            for background in [tokens.bg, tokens.recess, tokens.paper] {
                for ink in inks {
                    assert!(
                        contrast(ink, background) >= TEXT,
                        "{ink:?} on {background:?}"
                    );
                }
            }
            assert!(contrast(tokens.accent_ink, tokens.accent) >= TEXT);
            assert!(contrast(tokens.paper, tokens.ink) >= TEXT);
            assert!(contrast(tokens.ink, tokens.line) >= TEXT);
            assert!(contrast(tokens.ink, tokens.accent_soft) >= TEXT);
            assert!(contrast(tokens.ink, tokens.bad_soft) >= TEXT);
            assert!(contrast(tokens.bad, tokens.bad_soft) >= TEXT);
            assert!(contrast(tokens.ink, tokens.ok_soft) >= TEXT);
            assert!(contrast(tokens.ok, tokens.ok_soft) >= TEXT);
        }
    }

    #[test]
    fn terminal_colours_read_on_both_terminal_backgrounds() {
        for tokens in [&DARK, &LIGHT] {
            let terminal = &tokens.terminal;
            assert!(contrast(terminal.foreground, terminal.selection) >= TEXT);
            for background in [terminal.background, terminal.background_idle] {
                assert!(contrast(terminal.foreground, background) >= TEXT);
                assert!(contrast(terminal.cursor, background) >= TEXT);
                for (index, color) in terminal.ansi.iter().enumerate() {
                    // Black on a dark background is a background colour,
                    // not text: it stays dark, as in every dark scheme.
                    if index == 0 && tokens == &DARK {
                        continue;
                    }
                    assert!(contrast(*color, background) >= TEXT, "ansi {index}");
                }
            }
        }
    }
}
