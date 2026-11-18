//! The files pane: a folder as a tree, read one directory at a time.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use iced::widget::scrollable::AbsoluteOffset;
use iced::widget::{Space, button, center, column, container, row, scrollable, stack, text};
use iced::{Element, Length, Padding, Rectangle, Task};

use crate::files::git::{self, Change, Status};
use crate::files::kind::Kind;
use crate::files::tree::{self, Entry, State, Tree};
use crate::style::{self, Marker, Tone, measure, size, space};

use super::Message;
use super::editor::tree::window;
use super::probe::probe;

const ROW_HEIGHT: f32 = measure::ROW;

type Listing = Arc<Result<Arc<Vec<Entry>>, String>>;

#[derive(Debug, Clone)]
pub enum FilesMessage {
    /// A folder's listing arrived, and how long reading it took.
    Listed(String, Listing, Duration),
    /// What git says, for the refresh with this number.
    Git(u64, Option<Arc<Status>>),
    Press(usize),
    Scrolled(f32),
    Bounds(Rectangle),
    ToggleHidden,
    Refresh,
}

/// A move of the selection from the keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    Up,
    Down,
    /// Close the folder, or go to the folder the row is in.
    Left,
    /// Open the folder, or go to its first row.
    Right,
    /// Open the file, or open and close the folder.
    Open,
    First,
    Last,
    PageUp,
    PageDown,
}

/// What the window does after the pane has taken a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Open this file in the pane for its type.
    Open(PathBuf),
    /// What is saved about the pane changed.
    Changed,
}

/// How long the last pieces of work took, for the self-test.
#[derive(Debug, Clone, Copy, Default)]
pub struct Timings {
    pub list: Duration,
    pub rows: Duration,
}

pub struct FilesPane {
    pub tree: Tree,
    selected: Option<String>,
    selected_row: Option<usize>,
    offset: f32,
    height: f32,
    git: Option<Arc<Status>>,
    refreshes: u64,
    /// Folders asked for and not yet answered.
    asked: HashSet<String>,
    pub timings: Timings,
}

fn read(id: u64, tree: &Tree, path: String) -> Task<Message> {
    let directory = tree.absolute(&path);
    Task::perform(
        async move {
            let started = Instant::now();
            let listing = tokio::task::spawn_blocking(move || tree::list(&directory))
                .await
                .unwrap_or_else(|error| Err(error.to_string()));
            (Arc::new(listing.map(Arc::new)), started.elapsed())
        },
        move |(listing, took)| {
            Message::Files(id, FilesMessage::Listed(path.clone(), listing, took))
        },
    )
}

impl FilesPane {
    pub fn new(
        id: u64,
        root: PathBuf,
        show_hidden: bool,
        expanded: Vec<String>,
    ) -> (Self, Task<Message>) {
        let mut pane = Self {
            tree: Tree::new(root, show_hidden, expanded),
            selected: None,
            selected_row: None,
            offset: 0.0,
            height: 600.0,
            git: None,
            refreshes: 0,
            asked: HashSet::new(),
            timings: Timings::default(),
        };
        let task = Task::batch([pane.load(id), pane.read_git(id)]);
        (pane, task)
    }

    fn tree_id(id: u64) -> iced::widget::Id {
        iced::widget::Id::from(format!("files-tree-{id}"))
    }

    pub fn title(&self) -> String {
        self.tree.root().file_name().map_or_else(
            || String::from("files"),
            |name| name.to_string_lossy().into_owned(),
        )
    }

    /// The note at the right of the status line.
    pub fn status_note(&self) -> String {
        if !self.tree.is_ready() {
            return String::from("Reading");
        }
        let changed = self.git.as_ref().map_or(0, |status| status.len());
        let rows = match self.tree.len() {
            1 => String::from("1 row"),
            count => format!("{count} rows"),
        };
        if changed > 0 {
            format!("{rows}, {changed} changed")
        } else {
            rows
        }
    }

    pub fn selected(&self) -> Option<&str> {
        self.selected.as_deref()
    }

    /// Asks for every folder that is on show and not read yet.
    fn load(&mut self, id: u64) -> Task<Message> {
        let wanted: Vec<String> = self
            .tree
            .wanted()
            .into_iter()
            .filter(|path| self.asked.insert(path.clone()))
            .collect();
        Task::batch(wanted.into_iter().map(|path| read(id, &self.tree, path)))
    }

    fn read_git(&mut self, id: u64) -> Task<Message> {
        self.refreshes += 1;
        let number = self.refreshes;
        let root = self.tree.root().to_path_buf();
        Task::perform(
            async move {
                tokio::task::spawn_blocking(move || git::read(&root))
                    .await
                    .ok()
                    .flatten()
                    .map(Arc::new)
            },
            move |status| Message::Files(id, FilesMessage::Git(number, status.clone())),
        )
    }

    /// Reads again every folder on show, and git. What is on screen stays
    /// until the new listings arrive.
    pub fn refresh(&mut self, id: u64) -> Task<Message> {
        self.tree.forget_hidden();
        let again: Vec<String> = self
            .tree
            .listed()
            .into_iter()
            .filter(|path| self.asked.insert(path.clone()))
            .collect();
        let mut tasks: Vec<Task<Message>> = again
            .into_iter()
            .map(|path| read(id, &self.tree, path))
            .collect();
        tasks.push(self.load(id));
        tasks.push(self.read_git(id));
        Task::batch(tasks)
    }

    fn select(&mut self, id: u64, index: usize) -> Task<Message> {
        let Some(row) = self.tree.rows().get(index) else {
            return Task::none();
        };
        self.selected = self.tree.path(row);
        self.selected_row = Some(index);
        self.reveal(id, index)
    }

    /// Scrolls so a row is in view, when it is not.
    fn reveal(&mut self, id: u64, index: usize) -> Task<Message> {
        let top = index as f32 * ROW_HEIGHT;
        let target = if top < self.offset {
            top
        } else if top + ROW_HEIGHT > self.offset + self.height {
            top + ROW_HEIGHT - self.height
        } else {
            return Task::none();
        };
        self.offset = target.max(0.0);
        iced::widget::operation::scroll_to(
            Self::tree_id(id),
            AbsoluteOffset {
                x: None,
                y: Some(self.offset),
            },
        )
    }

    /// Finds the selected path again after the rows changed.
    fn reselect(&mut self) {
        self.selected_row = self
            .selected
            .as_deref()
            .and_then(|path| self.tree.position(path));
    }

    /// Opens a file, or opens and closes a folder.
    fn activate(&mut self, id: u64, index: usize) -> (Task<Message>, Option<Effect>) {
        let Some(row) = self.tree.rows().get(index).copied() else {
            return (Task::none(), None);
        };
        let Some(path) = self.tree.path(&row) else {
            return (Task::none(), None);
        };
        match self.tree.state(&row) {
            State::File => (Task::none(), Some(Effect::Open(self.tree.absolute(&path)))),
            State::Closed => self.set_open(id, &path, true),
            State::Open | State::Loading | State::Unreadable => self.set_open(id, &path, false),
        }
    }

    fn set_open(&mut self, id: u64, path: &str, open: bool) -> (Task<Message>, Option<Effect>) {
        self.tree.set_expanded(path, open);
        self.reselect();
        (self.load(id), Some(Effect::Changed))
    }

    pub fn nav(&mut self, id: u64, nav: Nav) -> (Task<Message>, Option<Effect>) {
        let count = self.tree.len();
        if count == 0 {
            return (Task::none(), None);
        }
        let page = ((self.height / ROW_HEIGHT).floor() as usize).max(2) - 1;
        let Some(current) = self.selected_row else {
            // Nothing is selected yet: any key starts at the top.
            let start = if nav == Nav::Last { count - 1 } else { 0 };
            return (self.select(id, start), None);
        };
        let target = match nav {
            Nav::Up => current.saturating_sub(1),
            Nav::Down => (current + 1).min(count - 1),
            Nav::First => 0,
            Nav::Last => count - 1,
            Nav::PageUp => current.saturating_sub(page),
            Nav::PageDown => (current + page).min(count - 1),
            Nav::Open => return self.activate(id, current),
            Nav::Left | Nav::Right => {
                let Some(row) = self.tree.rows().get(current).copied() else {
                    return (self.select(id, 0), None);
                };
                let state = self.tree.state(&row);
                let path = self.tree.path(&row).unwrap_or_default();
                match (nav, state) {
                    (Nav::Right, State::Closed) => return self.set_open(id, &path, true),
                    (Nav::Right, State::Open) => (current + 1).min(count - 1),
                    (Nav::Left, State::Open | State::Loading | State::Unreadable) => {
                        return self.set_open(id, &path, false);
                    }
                    (Nav::Left, _) => self.tree.parent(current).unwrap_or(current),
                    _ => current,
                }
            }
        };
        (self.select(id, target), None)
    }

    pub fn update(&mut self, id: u64, message: FilesMessage) -> (Task<Message>, Option<Effect>) {
        match message {
            FilesMessage::Listed(path, listing, took) => {
                self.asked.remove(&path);
                let started = Instant::now();
                self.tree.set_listing(&path, (*listing).clone());
                self.reselect();
                self.timings = Timings {
                    list: took,
                    rows: started.elapsed(),
                };
                (self.load(id), None)
            }
            FilesMessage::Git(number, status) => {
                if number == self.refreshes {
                    self.git = status;
                }
                (Task::none(), None)
            }
            FilesMessage::Press(index) => {
                let select = self.select(id, index);
                let (task, effect) = self.activate(id, index);
                (Task::batch([select, task]), effect)
            }
            FilesMessage::Scrolled(offset) => {
                self.offset = offset;
                (Task::none(), None)
            }
            FilesMessage::Bounds(bounds) => {
                self.height = bounds.height;
                (Task::none(), None)
            }
            FilesMessage::ToggleHidden => {
                self.tree.set_show_hidden(!self.tree.show_hidden());
                self.reselect();
                (Task::none(), Some(Effect::Changed))
            }
            FilesMessage::Refresh => (self.refresh(id), None),
        }
    }

    fn change_mark(&self, path: &str, is_dir: bool, selected: bool) -> Element<'_, Message> {
        let Some(status) = &self.git else {
            return Space::new().into();
        };
        match status.change(path) {
            Some(change) => {
                let tone = match change {
                    Change::Modified => Tone::Wait,
                    Change::Added | Change::Untracked => Tone::Ok,
                    Change::Deleted | Change::Conflict => Tone::Bad,
                    Change::Renamed => Tone::Accent,
                };
                style::change_mark(change.letter(), tone, selected)
            }
            None if is_dir && status.holds(path) => style::change_mark("•", Tone::Wait, selected),
            None => Space::new().into(),
        }
    }

    fn rows_view(&self, id: u64) -> Element<'_, Message> {
        let rows = self.tree.rows();
        let visible = window(rows.len(), ROW_HEIGHT, self.offset, self.height);
        let mut list = column![Space::new().height(visible.start as f32 * ROW_HEIGHT)];
        for (index, row) in rows
            .iter()
            .enumerate()
            .take(visible.end)
            .skip(visible.start)
        {
            let Some(entry) = self.tree.entry(row) else {
                continue;
            };
            let path = self.tree.path(row).unwrap_or_default();
            let selected = self.selected_row == Some(index);
            let marker = match self.tree.state(row) {
                State::File => Marker::Tag(Kind::of(&entry.name).tag()),
                State::Closed => Marker::Closed,
                State::Open => Marker::Open,
                State::Loading => Marker::Loading,
                State::Unreadable => Marker::Unreadable,
            };
            let name = text(entry.name.as_str())
                .size(size::LABEL)
                .font(if entry.is_dir {
                    style::ui_strong()
                } else {
                    style::ui()
                })
                .style(if entry.is_hidden() && !selected {
                    style::muted
                } else {
                    style::inherit
                })
                .wrapping(text::Wrapping::None);
            let line = row![
                style::file_marker(marker, selected),
                container(name).width(Length::Fill).clip(true),
                self.change_mark(&path, entry.is_dir, selected),
            ]
            .spacing(space::M)
            .align_y(iced::Alignment::Center);
            list = list.push(
                button(container(line).center_y(Length::Fill))
                    .padding(
                        Padding::from([space::NONE, space::L])
                            .left(space::L + row.depth as f32 * measure::INDENT),
                    )
                    .height(ROW_HEIGHT)
                    .width(Length::Fill)
                    .style(style::list_row(selected))
                    .on_press(Message::Files(id, FilesMessage::Press(index))),
            );
        }
        list = list
            .push(Space::new().height(rows.len().saturating_sub(visible.end) as f32 * ROW_HEIGHT));
        scrollable(list)
            .id(Self::tree_id(id))
            .on_scroll(move |viewport| {
                Message::Files(id, FilesMessage::Scrolled(viewport.absolute_offset().y))
            })
            .direction(style::scroll_direction())
            .style(style::scrollbar)
            .height(Length::Fill)
            .width(Length::Fill)
            .into()
    }

    pub fn view(&self, id: u64) -> Element<'_, Message> {
        let message = move |message: FilesMessage| Message::Files(id, message);
        let tool = |label: &'static str, selected: bool, on: FilesMessage| {
            button(text(label).size(size::META).style(style::inherit))
                .padding(Padding::from([space::XXS, space::M]))
                .style(style::toggle(selected))
                .on_press(message(on))
        };
        let toolbar = row![
            text(self.title())
                .size(size::META)
                .font(style::ui_strong())
                .style(style::muted)
                .wrapping(text::Wrapping::None)
                .width(Length::Fill),
            tool(
                "Hidden files",
                self.tree.show_hidden(),
                FilesMessage::ToggleHidden
            ),
            tool("Refresh", false, FilesMessage::Refresh),
        ]
        .spacing(space::XS)
        .align_y(iced::Alignment::Center);

        let says = |words: String| -> Element<'_, Message> {
            center(text(words).size(size::BODY).style(style::muted))
                .padding(space::XL)
                .into()
        };
        let body: Element<'_, Message> = if let Some(error) = self.tree.root_error() {
            says(format!(
                "Could not read {}: {error}",
                style::tilde(self.tree.root())
            ))
        } else if !self.tree.is_ready() {
            says(String::from("Reading the folder…"))
        } else if self.tree.is_empty() {
            says(String::from(if self.tree.show_hidden() {
                "This folder is empty."
            } else {
                "Nothing to show. Hidden files are off."
            }))
        } else {
            self.rows_view(id)
        };
        column![
            container(toolbar).padding(Padding::from([space::M, space::L]).bottom(space::S)),
            // The probe reports the height of the list, which decides how
            // many rows are built and when a selected row is out of view.
            stack![
                probe(move |bounds| message(FilesMessage::Bounds(bounds))),
                container(body).padding(Padding::from([space::NONE, space::S]).bottom(space::S)),
            ],
        ]
        .into()
    }
}
