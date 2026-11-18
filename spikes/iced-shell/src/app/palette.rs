//! The command palette: every window action, and a pane of each kind.

use crate::vault::fuzzy;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewPane {
    Terminal,
    Editor,
    Web,
    Chat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Add(NewPane, bool),
    NewTab(NewPane),
    ClosePane,
    CloseTab,
    Magnify,
}

pub const COMMANDS: [(Command, &str); 13] = [
    (Command::Add(NewPane::Terminal, false), "Add a terminal pane on the right"),
    (Command::Add(NewPane::Editor, false), "Add a Markdown editor pane on the right"),
    (Command::Add(NewPane::Web, false), "Add a web pane on the right"),
    (Command::Add(NewPane::Chat, false), "Add a chat pane on the right"),
    (Command::Add(NewPane::Terminal, true), "Add a terminal pane below"),
    (Command::Add(NewPane::Editor, true), "Add a Markdown editor pane below"),
    (Command::Add(NewPane::Web, true), "Add a web pane below"),
    (Command::Add(NewPane::Chat, true), "Add a chat pane below"),
    (Command::NewTab(NewPane::Terminal), "New tab with a terminal"),
    (Command::NewTab(NewPane::Editor), "New tab with a Markdown editor"),
    (Command::ClosePane, "Close the pane"),
    (Command::CloseTab, "Close the tab"),
    (Command::Magnify, "Magnify the pane, or restore it"),
];

pub struct Palette {
    pub query: String,
    pub matches: Vec<Command>,
    pub selected: usize,
}

impl Palette {
    pub fn new() -> Self {
        let mut palette = Self { query: String::new(), matches: Vec::new(), selected: 0 };
        palette.filter();
        palette
    }

    pub fn filter(&mut self) {
        let ranked = fuzzy::rank(&self.query, COMMANDS.iter().map(|(_, label)| *label), COMMANDS.len());
        self.matches = ranked
            .into_iter()
            .filter_map(|label| COMMANDS.iter().find(|(_, known)| *known == label).map(|(command, _)| *command))
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
    COMMANDS.iter().find(|(known, _)| *known == command).map_or("", |(_, label)| label)
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
}
