//! The window's keyboard shortcuts. The modifier is Cmd on macOS and Super
//! on Linux: iced reports both as the logo key, and a terminal program never
//! sees it, so no shortcut takes a key a shell needs.

use iced::keyboard::key::Named;
use iced::keyboard::{Key, Modifiers};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    NewTab,
    SplitRight,
    SplitDown,
    Magnify,
    NextPane,
    PreviousPane,
    NextTab,
    PreviousTab,
    ClosePane,
    CloseTab,
    Palette,
    QuickSwitcher,
    VaultSearch,
    Find,
    Save,
    TogglePreview,
    FollowLink,
    Undo,
    Redo,
    FocusAddress,
    Reload,
    GoToTab(usize),
    Escape,
}

pub fn action(key: &Key, modifiers: Modifiers) -> Option<Action> {
    if let Key::Named(Named::Escape) = key {
        return Some(Action::Escape);
    }
    if !modifiers.logo() {
        return None;
    }
    let shift = modifiers.shift();
    Some(match key {
        Key::Named(Named::Enter) if shift => Action::Magnify,
        Key::Named(Named::Enter) => Action::FollowLink,
        Key::Character(c) => match (c.to_lowercase().as_str(), shift) {
            ("t", false) => Action::NewTab,
            ("d", false) => Action::SplitRight,
            ("d", true) => Action::SplitDown,
            ("]" | "}", false) => Action::NextPane,
            ("[" | "{", false) => Action::PreviousPane,
            ("]" | "}", true) => Action::NextTab,
            ("[" | "{", true) => Action::PreviousTab,
            ("w", false) => Action::ClosePane,
            ("w", true) => Action::CloseTab,
            ("k", _) | ("p", true) => Action::Palette,
            ("o", false) => Action::QuickSwitcher,
            ("f", true) => Action::VaultSearch,
            ("f", false) => Action::Find,
            ("s", false) => Action::Save,
            ("e", false) => Action::TogglePreview,
            ("z", false) => Action::Undo,
            ("z", true) => Action::Redo,
            ("l", false) => Action::FocusAddress,
            ("r", false) => Action::Reload,
            (digit, false) if digit.len() == 1 && ("1"..="9").contains(&digit) => {
                Action::GoToTab(usize::from(digit.as_bytes()[0] - b'1'))
            }
            _ => return None,
        },
        _ => return None,
    })
}

/// The same mapping for a shortcut pressed inside a web page, which reports
/// the key's name as the page saw it.
pub fn web_action(key: &str, shift: bool) -> Option<Action> {
    let key = match key {
        "Enter" => Key::Named(Named::Enter),
        other => Key::Character(other.into()),
    };
    let modifiers = if shift {
        Modifiers::LOGO | Modifiers::SHIFT
    } else {
        Modifiers::LOGO
    };
    action(&key, modifiers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(c: &str, modifiers: Modifiers) -> Option<Action> {
        action(&Key::Character(c.into()), modifiers)
    }

    #[test]
    fn the_current_apps_shortcuts() {
        let cmd = Modifiers::LOGO;
        let cmd_shift = Modifiers::LOGO | Modifiers::SHIFT;
        assert_eq!(press("t", cmd), Some(Action::NewTab));
        assert_eq!(press("d", cmd), Some(Action::SplitRight));
        assert_eq!(press("D", cmd_shift), Some(Action::SplitDown));
        assert_eq!(press("]", cmd), Some(Action::NextPane));
        assert_eq!(press("}", cmd_shift), Some(Action::NextTab));
        assert_eq!(press("w", cmd_shift), Some(Action::CloseTab));
        assert_eq!(
            action(&Key::Named(Named::Enter), cmd_shift),
            Some(Action::Magnify)
        );
        assert_eq!(press("3", cmd), Some(Action::GoToTab(2)));
    }

    #[test]
    fn keys_without_the_modifier_belong_to_the_pane() {
        assert_eq!(press("d", Modifiers::CTRL), None);
        assert_eq!(press("t", Modifiers::empty()), None);
    }

    #[test]
    fn a_shortcut_from_a_web_page() {
        assert_eq!(web_action("D", true), Some(Action::SplitDown));
        assert_eq!(web_action("Enter", true), Some(Action::Magnify));
    }
}
