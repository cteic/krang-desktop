//! Turns key presses and mouse actions into the bytes a terminal program
//! expects, following xterm.

use alacritty_terminal::term::TermMode;
use iced::keyboard::key::Named;
use iced::keyboard::{Key, Modifiers};

/// What Shift+Enter sends: a new line in agent prompts without submitting.
/// The same bytes the current app sends.
pub const NEWLINE_WITHOUT_SUBMIT: &[u8] = b"\x1b\r";

/// xterm's modifier parameter: 1 plus shift 1, alt 2, ctrl 4.
fn modifier_code(modifiers: Modifiers) -> u8 {
    1 + u8::from(modifiers.shift())
        + 2 * u8::from(modifiers.alt())
        + 4 * u8::from(modifiers.control())
}

fn cursor_key(letter: char, modifiers: Modifiers, mode: TermMode) -> Vec<u8> {
    let code = modifier_code(modifiers);
    if code > 1 {
        format!("\x1b[1;{code}{letter}").into_bytes()
    } else if mode.contains(TermMode::APP_CURSOR) {
        format!("\x1bO{letter}").into_bytes()
    } else {
        format!("\x1b[{letter}").into_bytes()
    }
}

fn tilde_key(number: u8, modifiers: Modifiers) -> Vec<u8> {
    let code = modifier_code(modifiers);
    if code > 1 {
        format!("\x1b[{number};{code}~").into_bytes()
    } else {
        format!("\x1b[{number}~").into_bytes()
    }
}

fn function_key(number: u8, modifiers: Modifiers) -> Vec<u8> {
    match number {
        1..=4 => {
            let letter = char::from(b'P' + number - 1);
            let code = modifier_code(modifiers);
            if code > 1 {
                format!("\x1b[1;{code}{letter}").into_bytes()
            } else {
                format!("\x1bO{letter}").into_bytes()
            }
        }
        5 => tilde_key(15, modifiers),
        6..=10 => tilde_key(number + 11, modifiers),
        _ => tilde_key(number + 12, modifiers),
    }
}

fn named_key(named: Named, modifiers: Modifiers, mode: TermMode) -> Option<Vec<u8>> {
    let alt_prefix = |bytes: &[u8]| {
        let mut out = Vec::with_capacity(bytes.len() + 1);
        if modifiers.alt() {
            out.push(0x1b);
        }
        out.extend_from_slice(bytes);
        out
    };
    Some(match named {
        Named::Enter if modifiers.shift() => NEWLINE_WITHOUT_SUBMIT.to_vec(),
        Named::Enter => alt_prefix(b"\r"),
        Named::Backspace if modifiers.control() => alt_prefix(b"\x08"),
        Named::Backspace => alt_prefix(b"\x7f"),
        Named::Tab if modifiers.shift() => b"\x1b[Z".to_vec(),
        Named::Tab => alt_prefix(b"\t"),
        Named::Escape => b"\x1b".to_vec(),
        Named::Space if modifiers.control() => vec![0],
        Named::Space => alt_prefix(b" "),
        Named::ArrowUp => cursor_key('A', modifiers, mode),
        Named::ArrowDown => cursor_key('B', modifiers, mode),
        Named::ArrowRight => cursor_key('C', modifiers, mode),
        Named::ArrowLeft => cursor_key('D', modifiers, mode),
        Named::Home => cursor_key('H', modifiers, mode),
        Named::End => cursor_key('F', modifiers, mode),
        Named::Insert => tilde_key(2, modifiers),
        Named::Delete => tilde_key(3, modifiers),
        Named::PageUp => tilde_key(5, modifiers),
        Named::PageDown => tilde_key(6, modifiers),
        Named::F1 => function_key(1, modifiers),
        Named::F2 => function_key(2, modifiers),
        Named::F3 => function_key(3, modifiers),
        Named::F4 => function_key(4, modifiers),
        Named::F5 => function_key(5, modifiers),
        Named::F6 => function_key(6, modifiers),
        Named::F7 => function_key(7, modifiers),
        Named::F8 => function_key(8, modifiers),
        Named::F9 => function_key(9, modifiers),
        Named::F10 => function_key(10, modifiers),
        Named::F11 => function_key(11, modifiers),
        Named::F12 => function_key(12, modifiers),
        _ => return None,
    })
}

/// The control code for Ctrl plus a key, as a VT100 keyboard sends it.
fn control_code(c: char) -> Option<u8> {
    let c = c.to_ascii_lowercase();
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        '@' | '2' => Some(0),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' => Some(0x1f),
        '8' | '?' => Some(0x7f),
        _ => None,
    }
}

/// The bytes for a key press, or `None` when the key sends nothing.
///
/// `key` is the key without modifiers applied and `text` what the system
/// typed for it. On macOS Option composes characters, so its text is sent as
/// it is; elsewhere Alt is Meta and prefixes Escape.
pub fn encode_key(
    key: &Key,
    text: Option<&str>,
    modifiers: Modifiers,
    mode: TermMode,
) -> Option<Vec<u8>> {
    if let Key::Named(named) = key
        && let Some(bytes) = named_key(*named, modifiers, mode)
    {
        return Some(bytes);
    }
    if modifiers.control()
        && let Key::Character(chars) = key
        && let Some(code) = chars.chars().next().and_then(control_code)
    {
        let mut out = Vec::with_capacity(2);
        if modifiers.alt() {
            out.push(0x1b);
        }
        out.push(code);
        return Some(out);
    }
    let text = text.filter(|text| !text.is_empty() && !text.chars().any(char::is_control))?;
    let mut out = Vec::with_capacity(text.len() + 1);
    if modifiers.alt() && !cfg!(target_os = "macos") {
        out.push(0x1b);
    }
    out.extend_from_slice(text.as_bytes());
    Some(out)
}

/// Wraps pasted text for a program that asked for bracketed paste, so it
/// can tell a paste from typing. Escape bytes inside the paste are dropped so
/// a paste cannot end the bracket early.
pub fn encode_paste(text: &str, mode: TermMode) -> Vec<u8> {
    if mode.contains(TermMode::BRACKETED_PASTE) {
        let clean = text.replace('\x1b', "");
        format!("\x1b[200~{clean}\x1b[201~").into_bytes()
    } else {
        text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
    WheelUp,
    WheelDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseAction {
    Press,
    Release,
    /// Movement with a button held, or with none in any-motion mode.
    Motion(Option<MouseButton>),
}

/// Whether the program wants mouse events at all.
pub fn wants_mouse(mode: TermMode) -> bool {
    mode.intersects(TermMode::MOUSE_MODE)
}

/// Encodes a mouse event for a program that turned on mouse reporting, in
/// SGR form when it asked for that and in the old X10 form otherwise.
/// Returns `None` when the program's mode does not ask for this event.
pub fn encode_mouse(
    button: MouseButton,
    action: MouseAction,
    line: usize,
    column: usize,
    modifiers: Modifiers,
    mode: TermMode,
) -> Option<Vec<u8>> {
    if !wants_mouse(mode) {
        return None;
    }
    let base = |button: MouseButton| match button {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
        MouseButton::WheelUp => 64,
        MouseButton::WheelDown => 65,
    };
    let mut code = match action {
        MouseAction::Press | MouseAction::Release => base(button),
        MouseAction::Motion(Some(held)) => {
            if !mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) {
                return None;
            }
            base(held) + 32
        }
        MouseAction::Motion(None) => {
            if !mode.contains(TermMode::MOUSE_MOTION) {
                return None;
            }
            3 + 32
        }
    };
    code += 4 * u8::from(modifiers.shift())
        + 8 * u8::from(modifiers.alt())
        + 16 * u8::from(modifiers.control());
    let wheel = matches!(button, MouseButton::WheelUp | MouseButton::WheelDown);
    if mode.contains(TermMode::SGR_MOUSE) {
        let end = if action == MouseAction::Release {
            'm'
        } else {
            'M'
        };
        if action == MouseAction::Release && wheel {
            return None;
        }
        return Some(format!("\x1b[<{code};{};{}{end}", column + 1, line + 1).into_bytes());
    }
    if action == MouseAction::Release {
        if wheel {
            return None;
        }
        code = 3 + (code & !3);
    }
    // The old form has one byte per coordinate and cannot reach past 223.
    let column = u8::try_from(column + 33).ok()?;
    let line = u8::try_from(line + 33).ok()?;
    Some(vec![0x1b, b'[', b'M', 32 + code, column, line])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(c: &str) -> Key {
        Key::Character(c.into())
    }

    #[test]
    fn letters_and_control_codes() {
        let none = Modifiers::empty();
        assert_eq!(
            encode_key(&key("a"), Some("a"), none, TermMode::empty()),
            Some(b"a".to_vec())
        );
        assert_eq!(
            encode_key(&key("c"), Some("c"), Modifiers::CTRL, TermMode::empty()),
            Some(vec![3])
        );
        assert_eq!(
            encode_key(&key("["), None, Modifiers::CTRL, TermMode::empty()),
            Some(vec![0x1b])
        );
    }

    #[test]
    fn arrows_follow_the_cursor_key_mode() {
        let up = Key::Named(Named::ArrowUp);
        let none = Modifiers::empty();
        assert_eq!(
            encode_key(&up, None, none, TermMode::empty()),
            Some(b"\x1b[A".to_vec())
        );
        assert_eq!(
            encode_key(&up, None, none, TermMode::APP_CURSOR),
            Some(b"\x1bOA".to_vec())
        );
        assert_eq!(
            encode_key(&up, None, Modifiers::CTRL, TermMode::APP_CURSOR),
            Some(b"\x1b[1;5A".to_vec())
        );
    }

    #[test]
    fn shift_enter_is_a_new_line_without_submitting() {
        let enter = Key::Named(Named::Enter);
        assert_eq!(
            encode_key(&enter, None, Modifiers::SHIFT, TermMode::empty()),
            Some(b"\x1b\r".to_vec())
        );
        assert_eq!(
            encode_key(&enter, None, Modifiers::empty(), TermMode::empty()),
            Some(b"\r".to_vec())
        );
    }

    #[test]
    fn function_and_editing_keys() {
        let none = Modifiers::empty();
        let mode = TermMode::empty();
        assert_eq!(
            encode_key(&Key::Named(Named::F1), None, none, mode),
            Some(b"\x1bOP".to_vec())
        );
        assert_eq!(
            encode_key(&Key::Named(Named::F5), None, none, mode),
            Some(b"\x1b[15~".to_vec())
        );
        assert_eq!(
            encode_key(&Key::Named(Named::F12), None, none, mode),
            Some(b"\x1b[24~".to_vec())
        );
        assert_eq!(
            encode_key(&Key::Named(Named::Delete), None, none, mode),
            Some(b"\x1b[3~".to_vec())
        );
        assert_eq!(
            encode_key(&Key::Named(Named::Tab), None, Modifiers::SHIFT, mode),
            Some(b"\x1b[Z".to_vec())
        );
    }

    #[test]
    fn paste_is_bracketed_only_when_asked_and_cannot_escape_the_bracket() {
        assert_eq!(encode_paste("a\nb", TermMode::empty()), b"a\rb".to_vec());
        assert_eq!(
            encode_paste("x\x1b[201~rm", TermMode::BRACKETED_PASTE),
            b"\x1b[200~x[201~rm\x1b[201~".to_vec()
        );
    }

    #[test]
    fn mouse_reports_in_sgr_and_x10_forms() {
        let none = Modifiers::empty();
        let sgr = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        assert_eq!(
            encode_mouse(MouseButton::Left, MouseAction::Press, 4, 9, none, sgr),
            Some(b"\x1b[<0;10;5M".to_vec())
        );
        assert_eq!(
            encode_mouse(MouseButton::Left, MouseAction::Release, 4, 9, none, sgr),
            Some(b"\x1b[<0;10;5m".to_vec())
        );
        let x10 = TermMode::MOUSE_REPORT_CLICK;
        assert_eq!(
            encode_mouse(MouseButton::Left, MouseAction::Press, 0, 0, none, x10),
            Some(vec![0x1b, b'[', b'M', 32, 33, 33])
        );
        assert_eq!(
            encode_mouse(MouseButton::WheelUp, MouseAction::Press, 0, 0, none, sgr),
            Some(b"\x1b[<64;1;1M".to_vec())
        );
    }

    #[test]
    fn motion_is_reported_only_in_the_modes_that_ask() {
        let none = Modifiers::empty();
        let click = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let held = MouseAction::Motion(Some(MouseButton::Left));
        assert_eq!(
            encode_mouse(MouseButton::Left, held, 0, 0, none, click),
            None
        );
        let drag = TermMode::MOUSE_DRAG | TermMode::SGR_MOUSE;
        assert_eq!(
            encode_mouse(MouseButton::Left, held, 0, 0, none, drag),
            Some(b"\x1b[<32;1;1M".to_vec())
        );
        assert_eq!(
            encode_mouse(
                MouseButton::Left,
                MouseAction::Press,
                0,
                0,
                none,
                TermMode::empty()
            ),
            None
        );
    }
}
