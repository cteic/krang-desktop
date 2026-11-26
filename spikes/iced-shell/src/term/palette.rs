//! Turns the terminal's colour references into concrete colours.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

use crate::style::{Mode, Terminal};

/// The colours one terminal resolves against, taken from the design tokens
/// for dark or light.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scheme {
    pub foreground: Rgb,
    pub background: Rgb,
    pub cursor: Rgb,
    pub selection: Rgb,
    pub ansi: [Rgb; 16],
}

fn rgb(color: iced::Color) -> Rgb {
    let [r, g, b, _] = color.into_rgba8();
    Rgb { r, g, b }
}

impl Default for Scheme {
    fn default() -> Self {
        Self::of(Mode::default())
    }
}

impl Scheme {
    pub fn new(tokens: &Terminal) -> Self {
        Self {
            foreground: rgb(tokens.foreground),
            background: rgb(tokens.background),
            cursor: rgb(tokens.cursor),
            selection: rgb(tokens.selection),
            ansi: tokens.ansi.map(rgb),
        }
    }

    pub fn of(mode: Mode) -> Self {
        Self::new(&mode.tokens().terminal)
    }
}

/// The xterm 256-colour table: 16 named colours, a 6x6x6 cube, 24 greys.
pub fn indexed(index: u8, scheme: &Scheme) -> Rgb {
    match index {
        0..=15 => scheme.ansi[usize::from(index)],
        16..=231 => {
            let value = index - 16;
            let level = |step: u8| if step == 0 { 0 } else { step * 40 + 55 };
            Rgb {
                r: level(value / 36),
                g: level((value / 6) % 6),
                b: level(value % 6),
            }
        }
        _ => {
            let grey = (index - 232) * 10 + 8;
            Rgb {
                r: grey,
                g: grey,
                b: grey,
            }
        }
    }
}

fn named(color: NamedColor, scheme: &Scheme) -> Rgb {
    match color {
        NamedColor::Foreground | NamedColor::BrightForeground => scheme.foreground,
        NamedColor::Background => scheme.background,
        NamedColor::Cursor => scheme.cursor,
        NamedColor::DimForeground => dim(scheme.foreground, scheme),
        other => {
            let index = other as usize;
            if index < 16 {
                scheme.ansi[index]
            } else {
                // The dim variants follow the bright ones in the enum.
                dim(
                    scheme.ansi[(index - NamedColor::DimBlack as usize) % 8],
                    scheme,
                )
            }
        }
    }
}

/// A dimmed colour: two parts the colour to one part the background, so
/// dim text fades toward the page in light and in dark.
pub fn dim(color: Rgb, scheme: &Scheme) -> Rgb {
    let blend =
        |color: u8, background: u8| ((u16::from(color) * 2 + u16::from(background)) / 3) as u8;
    Rgb {
        r: blend(color.r, scheme.background.r),
        g: blend(color.g, scheme.background.g),
        b: blend(color.b, scheme.background.b),
    }
}

/// Resolves a colour, honouring palette changes a program made with OSC 4.
/// `bold` brightens the eight base colours, as xterm does.
pub fn resolve(color: Color, overrides: &Colors, bold: bool, scheme: &Scheme) -> Rgb {
    match color {
        Color::Spec(rgb) => rgb,
        Color::Indexed(index) => {
            let index = if bold && index < 8 { index + 8 } else { index };
            overrides[usize::from(index)].unwrap_or_else(|| indexed(index, scheme))
        }
        Color::Named(name) => {
            let name = if bold { name.to_bright() } else { name };
            overrides[name].unwrap_or_else(|| named(name, scheme))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cube_and_greys_match_xterm() {
        let scheme = Scheme::of(Mode::Dark);
        assert_eq!(indexed(16, &scheme), Rgb { r: 0, g: 0, b: 0 });
        assert_eq!(indexed(196, &scheme), Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(
            indexed(231, &scheme),
            Rgb {
                r: 255,
                g: 255,
                b: 255
            }
        );
        assert_eq!(indexed(232, &scheme), Rgb { r: 8, g: 8, b: 8 });
        assert_eq!(
            indexed(255, &scheme),
            Rgb {
                r: 238,
                g: 238,
                b: 238
            }
        );
    }

    #[test]
    fn bold_brightens_base_colours_only() {
        let scheme = Scheme::of(Mode::Dark);
        let colors = Colors::default();
        assert_eq!(
            resolve(Color::Indexed(1), &colors, true, &scheme),
            scheme.ansi[9]
        );
        assert_eq!(
            resolve(Color::Indexed(100), &colors, true, &scheme),
            indexed(100, &scheme)
        );
        let true_colour = Rgb { r: 1, g: 2, b: 3 };
        assert_eq!(
            resolve(Color::Spec(true_colour), &colors, true, &scheme),
            true_colour
        );
    }

    #[test]
    fn a_palette_override_wins() {
        let scheme = Scheme::of(Mode::Dark);
        let mut colors = Colors::default();
        let pink = Rgb {
            r: 255,
            g: 0,
            b: 128,
        };
        colors[4] = Some(pink);
        assert_eq!(resolve(Color::Indexed(4), &colors, false, &scheme), pink);
        assert_eq!(
            resolve(Color::Named(NamedColor::Blue), &colors, false, &scheme),
            pink
        );
    }

    #[test]
    fn the_named_colours_follow_the_mode() {
        let colors = Colors::default();
        for mode in [Mode::Dark, Mode::Light] {
            let scheme = Scheme::of(mode);
            assert_eq!(
                resolve(
                    Color::Named(NamedColor::Foreground),
                    &colors,
                    false,
                    &scheme
                ),
                scheme.foreground
            );
            assert_eq!(
                resolve(Color::Named(NamedColor::Red), &colors, false, &scheme),
                scheme.ansi[1]
            );
        }
        assert_ne!(Scheme::of(Mode::Dark), Scheme::of(Mode::Light));
    }

    #[test]
    fn dim_moves_a_colour_toward_the_background() {
        let scheme = Scheme::of(Mode::Light);
        let dimmed = dim(scheme.foreground, &scheme);
        assert!(dimmed.r > scheme.foreground.r && dimmed.r < scheme.background.r);
    }
}
