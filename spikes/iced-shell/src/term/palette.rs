//! Turns the terminal's colour references into concrete colours.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};

pub const FOREGROUND: Rgb = Rgb {
    r: 0xd8,
    g: 0xdc,
    b: 0xe3,
};
pub const BACKGROUND: Rgb = Rgb {
    r: 0x16,
    g: 0x18,
    b: 0x1d,
};
pub const CURSOR: Rgb = Rgb {
    r: 0xe8,
    g: 0xc0,
    b: 0x6a,
};
pub const SELECTION: Rgb = Rgb {
    r: 0x3a,
    g: 0x4a,
    b: 0x66,
};

const ANSI: [Rgb; 16] = [
    Rgb {
        r: 0x1d,
        g: 0x1f,
        b: 0x24,
    },
    Rgb {
        r: 0xe0,
        g: 0x6c,
        b: 0x75,
    },
    Rgb {
        r: 0x98,
        g: 0xc3,
        b: 0x79,
    },
    Rgb {
        r: 0xe5,
        g: 0xc0,
        b: 0x7b,
    },
    Rgb {
        r: 0x61,
        g: 0xaf,
        b: 0xef,
    },
    Rgb {
        r: 0xc6,
        g: 0x78,
        b: 0xdd,
    },
    Rgb {
        r: 0x56,
        g: 0xb6,
        b: 0xc2,
    },
    Rgb {
        r: 0xc8,
        g: 0xcc,
        b: 0xd4,
    },
    Rgb {
        r: 0x5c,
        g: 0x63,
        b: 0x70,
    },
    Rgb {
        r: 0xff,
        g: 0x7a,
        b: 0x85,
    },
    Rgb {
        r: 0xb5,
        g: 0xe8,
        b: 0x90,
    },
    Rgb {
        r: 0xff,
        g: 0xd8,
        b: 0x8a,
    },
    Rgb {
        r: 0x7d,
        g: 0xc4,
        b: 0xff,
    },
    Rgb {
        r: 0xde,
        g: 0x92,
        b: 0xf5,
    },
    Rgb {
        r: 0x6c,
        g: 0xd4,
        b: 0xe0,
    },
    Rgb {
        r: 0xff,
        g: 0xff,
        b: 0xff,
    },
];

/// The xterm 256-colour table: 16 named colours, a 6x6x6 cube, 24 greys.
pub fn indexed(index: u8) -> Rgb {
    match index {
        0..=15 => ANSI[usize::from(index)],
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

fn named(color: NamedColor) -> Rgb {
    match color {
        NamedColor::Foreground | NamedColor::BrightForeground => FOREGROUND,
        NamedColor::Background => BACKGROUND,
        NamedColor::Cursor => CURSOR,
        NamedColor::DimForeground => dim(FOREGROUND),
        other => {
            let index = other as usize;
            if index < 16 {
                ANSI[index]
            } else {
                // The dim variants follow the bright ones in the enum.
                dim(ANSI[(index - NamedColor::DimBlack as usize) % 8])
            }
        }
    }
}

pub fn dim(color: Rgb) -> Rgb {
    Rgb {
        r: (u16::from(color.r) * 2 / 3) as u8,
        g: (u16::from(color.g) * 2 / 3) as u8,
        b: (u16::from(color.b) * 2 / 3) as u8,
    }
}

/// Resolves a colour, honouring palette changes a program made with OSC 4.
/// `bold` brightens the eight base colours, as xterm does.
pub fn resolve(color: Color, overrides: &Colors, bold: bool) -> Rgb {
    match color {
        Color::Spec(rgb) => rgb,
        Color::Indexed(index) => {
            let index = if bold && index < 8 { index + 8 } else { index };
            overrides[usize::from(index)].unwrap_or_else(|| indexed(index))
        }
        Color::Named(name) => {
            let name = if bold { name.to_bright() } else { name };
            overrides[name].unwrap_or_else(|| named(name))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cube_and_greys_match_xterm() {
        assert_eq!(indexed(16), Rgb { r: 0, g: 0, b: 0 });
        assert_eq!(indexed(196), Rgb { r: 255, g: 0, b: 0 });
        assert_eq!(
            indexed(231),
            Rgb {
                r: 255,
                g: 255,
                b: 255
            }
        );
        assert_eq!(indexed(232), Rgb { r: 8, g: 8, b: 8 });
        assert_eq!(
            indexed(255),
            Rgb {
                r: 238,
                g: 238,
                b: 238
            }
        );
    }

    #[test]
    fn bold_brightens_base_colours_only() {
        let colors = Colors::default();
        assert_eq!(resolve(Color::Indexed(1), &colors, true), ANSI[9]);
        assert_eq!(resolve(Color::Indexed(100), &colors, true), indexed(100));
        let true_colour = Rgb { r: 1, g: 2, b: 3 };
        assert_eq!(
            resolve(Color::Spec(true_colour), &colors, true),
            true_colour
        );
    }

    #[test]
    fn a_palette_override_wins() {
        let mut colors = Colors::default();
        let pink = Rgb {
            r: 255,
            g: 0,
            b: 128,
        };
        colors[4] = Some(pink);
        assert_eq!(resolve(Color::Indexed(4), &colors, false), pink);
        assert_eq!(
            resolve(Color::Named(NamedColor::Blue), &colors, false),
            pink
        );
    }
}
