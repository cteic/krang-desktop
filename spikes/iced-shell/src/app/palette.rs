//! The command palette: every window action, and a pane of each kind.

use crate::chat::Agent;
use crate::vault::fuzzy;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewPane {
    Terminal,
    Editor,
    Web,
    Chat(Agent),
    Files,
    Usage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Add(NewPane, bool),
    NewTab(NewPane),
    ClosePane,
    CloseTab,
    Magnify,
    RefreshFiles,
    ToggleHidden,
    RenameTab,
    MoveTabLeft,
    MoveTabRight,
    SaveLayout,
}

pub const COMMANDS: [(Command, &str); 31] = [
    (
        Command::Add(NewPane::Terminal, false),
        "Add a terminal pane on the right",
    ),
    (
        Command::Add(NewPane::Editor, false),
        "Add a Markdown editor pane on the right",
    ),
    (
        Command::Add(NewPane::Web, false),
        "Add a web pane on the right",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Claude), false),
        "Add a Claude Code chat pane on the right",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Codex), false),
        "Add a Codex chat pane on the right",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Gemini), false),
        "Add a Gemini chat pane on the right",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Qwen), false),
        "Add a Qwen Code chat pane on the right (local model)",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Local), false),
        "Add a Local model chat pane on the right (text only)",
    ),
    (
        Command::Add(NewPane::Files, false),
        "Add a files pane on the right",
    ),
    (
        Command::Add(NewPane::Terminal, true),
        "Add a terminal pane below",
    ),
    (
        Command::Add(NewPane::Editor, true),
        "Add a Markdown editor pane below",
    ),
    (Command::Add(NewPane::Web, true), "Add a web pane below"),
    (
        Command::Add(NewPane::Chat(Agent::Claude), true),
        "Add a Claude Code chat pane below",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Codex), true),
        "Add a Codex chat pane below",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Gemini), true),
        "Add a Gemini chat pane below",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Qwen), true),
        "Add a Qwen Code chat pane below (local model)",
    ),
    (
        Command::Add(NewPane::Chat(Agent::Local), true),
        "Add a Local model chat pane below (text only)",
    ),
    (Command::Add(NewPane::Files, true), "Add a files pane below"),
    (
        Command::Add(NewPane::Usage, false),
        "Add a usage pane on the right: tokens and cost by agent",
    ),
    (
        Command::NewTab(NewPane::Terminal),
        "New tab with a terminal",
    ),
    (
        Command::NewTab(NewPane::Editor),
        "New tab with a Markdown editor",
    ),
    (Command::NewTab(NewPane::Files), "New tab with files"),
    (Command::ClosePane, "Close the pane"),
    (Command::CloseTab, "Close the tab"),
    (Command::Magnify, "Magnify the pane, or restore it"),
    (Command::RefreshFiles, "Files: read the folder again"),
    (Command::ToggleHidden, "Files: show or hide hidden files"),
    (Command::RenameTab, "Rename the tab"),
    (Command::MoveTabLeft, "Move the tab left"),
    (Command::MoveTabRight, "Move the tab right"),
    (Command::SaveLayout, "Save the tab as a layout"),
];

pub struct Palette {
    pub query: String,
    pub matches: Vec<Command>,
    pub selected: usize,
}

impl Palette {
    pub fn new() -> Self {
        let mut palette = Self {
            query: String::new(),
            matches: Vec::new(),
            selected: 0,
        };
        palette.filter();
        palette
    }

    pub fn filter(&mut self) {
        let ranked = fuzzy::rank(
            &self.query,
            COMMANDS.iter().map(|(_, label)| *label),
            COMMANDS.len(),
        );
        self.matches = ranked
            .into_iter()
            .filter_map(|label| {
                COMMANDS
                    .iter()
                    .find(|(_, known)| *known == label)
                    .map(|(command, _)| *command)
            })
            .collect();
        self.selected = 0;
    }

    pub fn step(&mut self, by: i32) {
        if !self.matches.is_empty() {
            let count = self.matches.len() as i32;
            self.selected = (self.selected as i32 + by).rem_euclid(count) as usize;
        }
    }

    pub fn chosen(&self) -> Option<Command> {
        self.matches.get(self.selected).copied()
    }
}

pub fn label(command: Command) -> &'static str {
    COMMANDS
        .iter()
        .find(|(known, _)| *known == command)
        .map_or("", |(_, label)| label)
}

/// The shortcut that runs a command without the palette, where it has one.
pub fn keys(command: Command) -> Option<&'static str> {
    match command {
        Command::Add(NewPane::Terminal, false) => Some("Cmd+D"),
        Command::Add(NewPane::Terminal, true) => Some("Cmd+Shift+D"),
        Command::NewTab(NewPane::Terminal) => Some("Cmd+T"),
        Command::ClosePane => Some("Cmd+W"),
        Command::CloseTab => Some("Cmd+Shift+W"),
        Command::Magnify => Some("Cmd+Shift+Enter"),
        Command::RefreshFiles => Some("Cmd+R"),
        Command::ToggleHidden => Some("Cmd+Shift+."),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_by_fuzzy_name() {
        let mut palette = Palette::new();
        assert_eq!(palette.matches.len(), COMMANDS.len());
        palette.query = "web below".into();
        palette.filter();
        assert_eq!(palette.chosen(), Some(Command::Add(NewPane::Web, true)));
        palette.step(-1);
        assert!(palette.chosen().is_some());
    }

    #[test]
    fn every_agent_has_a_chat_pane_command() {
        for agent in Agent::ALL {
            for down in [false, true] {
                assert!(!label(Command::Add(NewPane::Chat(agent), down)).is_empty());
            }
        }
        let mut palette = Palette::new();
        palette.query = "gemini chat right".into();
        palette.filter();
        assert_eq!(
            palette.chosen(),
            Some(Command::Add(NewPane::Chat(Agent::Gemini), false))
        );
        palette.query = "local chat below".into();
        palette.filter();
        assert_eq!(
            palette.chosen(),
            Some(Command::Add(NewPane::Chat(Agent::Local), true))
        );
    }

    #[test]
    fn the_keys_shown_are_the_ones_the_window_listens_for() {
        use crate::app::shortcuts::{self, Action};
        use iced::keyboard::{Key, Modifiers};

        let pressed = |key: &str, shift: bool| {
            let modifiers = if shift {
                Modifiers::LOGO | Modifiers::SHIFT
            } else {
                Modifiers::LOGO
            };
            shortcuts::action(&Key::Character(key.into()), modifiers)
        };
        assert_eq!(keys(Command::Add(NewPane::Terminal, false)), Some("Cmd+D"));
        assert_eq!(pressed("d", false), Some(Action::SplitRight));
        assert_eq!(pressed("d", true), Some(Action::SplitDown));
        assert_eq!(pressed("t", false), Some(Action::NewTab));
        assert_eq!(pressed("w", false), Some(Action::ClosePane));
        assert_eq!(pressed("w", true), Some(Action::CloseTab));
        assert_eq!(keys(Command::Add(NewPane::Web, false)), None);
    }
}
