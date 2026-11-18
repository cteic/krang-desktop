//! The Markdown editor pane over a vault.

pub mod history;
pub mod tree;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use iced::widget::text_editor::{self, Action, Binding, Cursor, Edit, Position};
use iced::widget::{
    Space, button, column, container, image, markdown, row, scrollable, stack, text, text_input,
};
use iced::{Element, Length, Padding, Task};

use crate::shell::layout::EditorMode;
use crate::style::{self, Mode, measure, size, space};
use crate::vault::frontmatter::{self, Frontmatter, Value};
use crate::vault::index::{Index, SearchHit};
use crate::vault::markdown::{VAULT_SCHEME, WIKI_SCHEME, decode, preview_source};
use crate::vault::{fuzzy, links};

use super::Message;
use history::History;
use tree::{Row, RowKind};

const ROW_HEIGHT: f32 = measure::ROW;
const AUTOSAVE_AFTER: Duration = Duration::from_millis(700);
/// Above this size the preview follows the text only when typing pauses.
const LIVE_PREVIEW_BYTES: usize = 64 * 1024;
/// Blocks the preview draws. iced lays out every block of a column each
/// frame, so a very long note shows its start and says so.
const PREVIEW_BLOCKS: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sidebar {
    Files,
    Search,
    Tags,
}

#[derive(Debug, Clone)]
pub enum EditorMessage {
    Action(Action),
    Open(String),
    Follow(String),
    PreviewLink(String),
    Mode(EditorMode),
    ToggleFolder(String),
    TreeScrolled(f32, f32),
    Sidebar(Sidebar),
    FindQuery(String),
    FindNext,
    Complete(Option<usize>),
    CompletionMove(i32),
    SwitcherQuery(String),
    SwitcherMove(i32),
    SwitcherOpen(Option<usize>),
    SearchQuery(String),
    SearchOpen(String, usize),
    PropertyDraft(String, String),
    PropertySubmit(String),
    Autosave(u64),
}

struct Find {
    query: String,
    matches: Vec<(usize, usize, usize)>,
    current: usize,
}

struct Completion {
    typed: String,
    items: Vec<String>,
    selected: usize,
}

struct Switcher {
    query: String,
    items: Vec<String>,
    selected: usize,
}

pub struct EditorPane {
    pub root: PathBuf,
    pub path: Option<String>,
    pub mode: EditorMode,
    pub content: text_editor::Content,
    pub error: Option<String>,
    pub dirty: bool,
    preview: markdown::Content,
    preview_stale: bool,
    front: Frontmatter,
    drafts: HashMap<String, String>,
    generation: u64,
    history: History,
    group_before: Option<String>,
    find: Option<Find>,
    completion: Option<Completion>,
    switcher: Option<Switcher>,
    sidebar: Sidebar,
    search_query: String,
    hits: Vec<SearchHit>,
    pub search_time: Option<Duration>,
    expanded: HashSet<String>,
    rows: Vec<Row>,
    tree_offset: f32,
    tree_height: f32,
    /// Bytes of the open note, kept so a large note is not measured each frame.
    size: usize,
}

fn note_text(content: &text_editor::Content) -> String {
    content.text()
}

impl EditorPane {
    pub fn new(root: PathBuf, mode: EditorMode) -> Self {
        Self {
            root,
            path: None,
            mode,
            content: text_editor::Content::new(),
            error: None,
            dirty: false,
            preview: markdown::Content::new(),
            preview_stale: false,
            front: Frontmatter::default(),
            drafts: HashMap::new(),
            generation: 0,
            history: History::default(),
            group_before: None,
            find: None,
            completion: None,
            switcher: None,
            sidebar: Sidebar::Files,
            search_query: String::new(),
            hits: Vec::new(),
            search_time: None,
            expanded: HashSet::new(),
            rows: Vec::new(),
            tree_offset: 0.0,
            tree_height: 600.0,
            size: 0,
        }
    }

    pub fn editor_id(id: u64) -> iced::widget::Id {
        iced::widget::Id::from(format!("editor-{id}"))
    }

    fn input_id(id: u64) -> iced::widget::Id {
        iced::widget::Id::from(format!("editor-input-{id}"))
    }

    pub fn title(&self) -> String {
        match &self.path {
            Some(path) => format!(
                "{}{}",
                path.rsplit('/').next().unwrap_or(path),
                if self.dirty { " •" } else { "" }
            ),
            None => self.root.file_name().map_or_else(
                || String::from("vault"),
                |name| name.to_string_lossy().into_owned(),
            ),
        }
    }

    pub fn absolute(&self, path: &str) -> PathBuf {
        self.root.join(path)
    }

    /// Rebuilds the tree rows after the vault or the open folders changed.
    pub fn sync_tree(&mut self, index: &Index) {
        if let Some(path) = &self.path {
            let mut prefix = String::new();
            for part in path
                .split('/')
                .collect::<Vec<_>>()
                .iter()
                .rev()
                .skip(1)
                .rev()
            {
                prefix = if prefix.is_empty() {
                    (*part).to_string()
                } else {
                    format!("{prefix}/{part}")
                };
                self.expanded.insert(prefix.clone());
            }
        }
        self.rows = tree::rows(index, &self.expanded);
    }

    /// Opens a note by its path in the vault.
    pub fn open(&mut self, path: &str) -> Task<Message> {
        if self.dirty {
            self.save_now();
        }
        match std::fs::read_to_string(self.absolute(path)) {
            Ok(text) => {
                self.size = text.len();
                self.front = frontmatter::parse(&text);
                self.drafts.clear();
                self.content = text_editor::Content::with_text(&text);
                self.path = Some(path.to_string());
                self.error = None;
                self.dirty = false;
                self.history = History::default();
                self.group_before = None;
                self.find = None;
                self.completion = None;
                self.preview_stale = true;
                self.refresh_preview(&text);
            }
            Err(error) => self.error = Some(format!("Could not open {path}: {error}")),
        }
        Task::none()
    }

    fn refresh_preview(&mut self, text: &str) {
        if self.mode != EditorMode::Edit && self.preview_stale {
            self.preview = markdown::Content::parse(&preview_source(text));
            self.preview_stale = false;
        }
    }

    /// Writes the note. Returns the saved text so the vault index can take it.
    pub fn save_now(&mut self) -> Option<(String, String)> {
        self.close_group();
        let path = self.path.clone()?;
        let text = note_text(&self.content);
        match std::fs::write(self.absolute(&path), &text) {
            Ok(()) => {
                self.dirty = false;
                self.size = text.len();
                self.front = frontmatter::parse(&text);
                self.refresh_preview(&text);
                Some((path, text))
            }
            Err(error) => {
                self.error = Some(format!("Could not save {path}: {error}"));
                None
            }
        }
    }

    fn close_group(&mut self) {
        if let Some(before) = self.group_before.take()
            && let Some(change) = history::diff(&before, &note_text(&self.content))
        {
            self.history.record(change);
        }
    }

    fn replace(&mut self, replace: history::Replace) {
        let position = |(line, column): history::Position| Position { line, column };
        self.content.move_to(Cursor {
            position: position(replace.end),
            selection: Some(position(replace.start)),
        });
        self.content
            .perform(Action::Edit(Edit::Paste(Arc::new(replace.text))));
    }

    fn after_edit(&mut self, id: u64) -> Task<Message> {
        self.dirty = true;
        self.preview_stale = true;
        if self.size < LIVE_PREVIEW_BYTES {
            let text = note_text(&self.content);
            self.size = text.len();
            self.refresh_preview(&text);
        }
        self.generation += 1;
        let generation = self.generation;
        Task::perform(tokio::time::sleep(AUTOSAVE_AFTER), move |()| {
            Message::Editor(id, EditorMessage::Autosave(generation))
        })
    }

    pub fn undo(&mut self, id: u64, redo: bool) -> Task<Message> {
        self.close_group();
        let step = if redo {
            self.history.redo()
        } else {
            self.history.undo()
        };
        match step {
            Some(replace) => {
                self.replace(replace);
                self.after_edit(id)
            }
            None => Task::none(),
        }
    }

    fn update_completion(&mut self, index: Option<&Index>) {
        let cursor = self.content.cursor().position;
        let typed = self
            .content
            .line(cursor.line)
            .and_then(|line| links::open_link_at(&line.text, cursor.column).map(String::from));
        self.completion = match (typed, index) {
            (Some(typed), Some(index)) => {
                let items: Vec<String> =
                    fuzzy::rank(&typed, index.notes().map(|note| note.name.as_str()), 8)
                        .into_iter()
                        .map(String::from)
                        .collect();
                Some(Completion {
                    typed,
                    items,
                    selected: 0,
                })
            }
            _ => None,
        };
    }

    fn accept_completion(&mut self, choice: Option<usize>, id: u64) -> Task<Message> {
        let Some(completion) = self.completion.take() else {
            return Task::none();
        };
        let name = choice
            .or(Some(completion.selected))
            .and_then(|index| completion.items.get(index).cloned())
            .unwrap_or(completion.typed.clone());
        let cursor = self.content.cursor().position;
        self.close_group();
        self.group_before = Some(note_text(&self.content));
        let start = Position {
            line: cursor.line,
            column: cursor.column - completion.typed.len(),
        };
        self.content.move_to(Cursor {
            position: cursor,
            selection: Some(start),
        });
        self.content
            .perform(Action::Edit(Edit::Paste(Arc::new(format!("{name}]]")))));
        self.close_group();
        self.after_edit(id)
    }

    /// The wikilink under the cursor, if any.
    pub fn link_at_cursor(&self) -> Option<String> {
        let cursor = self.content.cursor().position;
        let line = self.content.line(cursor.line)?;
        links::wikilinks(&line.text)
            .into_iter()
            .find(|link| link.range.contains(&cursor.column) || link.range.end == cursor.column)
            .map(|link| link.target)
    }

    pub fn toggle_preview(&mut self) {
        self.set_mode(match self.mode {
            EditorMode::Edit => EditorMode::Split,
            EditorMode::Split => EditorMode::Preview,
            EditorMode::Preview => EditorMode::Edit,
        });
    }

    fn set_mode(&mut self, mode: EditorMode) {
        self.mode = mode;
        self.preview_stale = true;
        let text = note_text(&self.content);
        self.refresh_preview(&text);
    }

    pub fn open_find(&mut self, id: u64) -> Task<Message> {
        if self.find.is_none() {
            self.find = Some(Find {
                query: String::new(),
                matches: Vec::new(),
                current: 0,
            });
        }
        iced::widget::operation::focus(Self::input_id(id))
    }

    pub fn open_switcher(&mut self, id: u64, index: Option<&Index>) -> Task<Message> {
        self.switcher = Some(Switcher {
            query: String::new(),
            items: Vec::new(),
            selected: 0,
        });
        self.update_switcher(index);
        iced::widget::operation::focus(Self::input_id(id))
    }

    pub fn open_search(&mut self, id: u64) -> Task<Message> {
        self.sidebar = Sidebar::Search;
        iced::widget::operation::focus(iced::widget::Id::from(format!("editor-search-{id}")))
    }

    fn update_switcher(&mut self, index: Option<&Index>) {
        if let (Some(switcher), Some(index)) = (self.switcher.as_mut(), index) {
            switcher.items = fuzzy::rank(
                &switcher.query,
                index.notes().map(|note| note.path.as_str()),
                14,
            )
            .into_iter()
            .map(String::from)
            .collect();
            switcher.selected = 0;
        }
    }

    pub fn search(&mut self, index: &Index) {
        let started = std::time::Instant::now();
        self.hits = index.search(&self.search_query, 300);
        self.search_time = Some(started.elapsed());
    }

    /// Escape closes whatever is open on top of the editor.
    pub fn escape(&mut self) -> bool {
        self.completion.take().is_some()
            || self.switcher.take().is_some()
            || self.find.take().is_some()
    }

    fn find_next(&mut self) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.matches.is_empty() {
            return;
        }
        let (line, start, end) = find.matches[find.current % find.matches.len()];
        find.current = (find.current + 1) % find.matches.len();
        self.content.move_to(Cursor {
            position: Position { line, column: end },
            selection: Some(Position {
                line,
                column: start,
            }),
        });
    }

    fn update_find(&mut self) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        find.matches.clear();
        find.current = 0;
        let needle = find.query.to_lowercase();
        if needle.is_empty() {
            return;
        }
        for (number, line) in self.content.lines().enumerate() {
            let lower = line.text.to_lowercase();
            if lower.len() != line.text.len() {
                continue;
            }
            for (start, _) in lower.match_indices(&needle) {
                find.matches.push((number, start, start + needle.len()));
            }
        }
    }

    /// Handles a message. `index` is the vault's index when it has loaded.
    /// Returns a task and, after a save, the saved note for the index.
    pub fn update(
        &mut self,
        id: u64,
        message: EditorMessage,
        index: Option<&Index>,
    ) -> (Task<Message>, Option<(String, String)>) {
        let mut saved = None;
        let task = match message {
            EditorMessage::Action(action) => {
                let is_edit = action.is_edit();
                if is_edit && self.path.is_none() {
                    return (Task::none(), None);
                }
                if is_edit {
                    if self.group_before.is_none() {
                        self.group_before = Some(note_text(&self.content));
                    }
                } else if !matches!(action, Action::Scroll { .. }) {
                    self.close_group();
                }
                self.content.perform(action);
                if is_edit {
                    self.update_completion(index);
                    self.after_edit(id)
                } else {
                    self.completion = None;
                    Task::none()
                }
            }
            EditorMessage::Open(path) => {
                saved = self.dirty.then(|| self.save_now()).flatten();
                let task = self.open(&path);
                if let Some(index) = index {
                    self.sync_tree(index);
                }
                self.switcher = None;
                task
            }
            EditorMessage::Follow(_) | EditorMessage::PreviewLink(_) => Task::none(),
            EditorMessage::Mode(mode) => {
                self.set_mode(mode);
                Task::none()
            }
            EditorMessage::ToggleFolder(path) => {
                if !self.expanded.remove(&path) {
                    self.expanded.insert(path);
                }
                if let Some(index) = index {
                    self.rows = tree::rows(index, &self.expanded);
                }
                Task::none()
            }
            EditorMessage::TreeScrolled(offset, height) => {
                self.tree_offset = offset;
                self.tree_height = height;
                Task::none()
            }
            EditorMessage::Sidebar(sidebar) => {
                self.sidebar = sidebar;
                Task::none()
            }
            EditorMessage::FindQuery(query) => {
                if let Some(find) = self.find.as_mut() {
                    find.query = query;
                }
                self.update_find();
                self.find_next();
                Task::none()
            }
            EditorMessage::FindNext => {
                self.find_next();
                Task::none()
            }
            EditorMessage::Complete(choice) => self.accept_completion(choice, id),
            EditorMessage::CompletionMove(step) => {
                if let Some(completion) = self.completion.as_mut()
                    && !completion.items.is_empty()
                {
                    let count = completion.items.len() as i32;
                    completion.selected =
                        ((completion.selected as i32 + step).rem_euclid(count)) as usize;
                }
                Task::none()
            }
            EditorMessage::SwitcherQuery(query) => {
                if let Some(switcher) = self.switcher.as_mut() {
                    switcher.query = query;
                }
                self.update_switcher(index);
                Task::none()
            }
            EditorMessage::SwitcherMove(step) => {
                if let Some(switcher) = self.switcher.as_mut()
                    && !switcher.items.is_empty()
                {
                    let count = switcher.items.len() as i32;
                    switcher.selected =
                        ((switcher.selected as i32 + step).rem_euclid(count)) as usize;
                }
                Task::none()
            }
            EditorMessage::SwitcherOpen(choice) => {
                let path = self.switcher.as_ref().and_then(|switcher| {
                    switcher
                        .items
                        .get(choice.unwrap_or(switcher.selected))
                        .cloned()
                });
                self.switcher = None;
                match path {
                    Some(path) => return self.update(id, EditorMessage::Open(path), index),
                    None => Task::none(),
                }
            }
            EditorMessage::SearchQuery(query) => {
                self.search_query = query;
                if let Some(index) = index {
                    self.search(index);
                }
                Task::none()
            }
            EditorMessage::SearchOpen(path, line) => {
                let (task, saved) = self.update(id, EditorMessage::Open(path), index);
                self.content.move_to(Cursor {
                    position: Position { line, column: 0 },
                    selection: None,
                });
                return (task, saved);
            }
            EditorMessage::PropertyDraft(key, value) => {
                self.drafts.insert(key, value);
                Task::none()
            }
            EditorMessage::PropertySubmit(key) => {
                if let Some(value) = self.drafts.remove(&key)
                    && let Some(updated) =
                        frontmatter::set_text(&note_text(&self.content), &key, &value)
                {
                    self.close_group();
                    self.group_before = Some(note_text(&self.content));
                    self.content = text_editor::Content::with_text(&updated);
                    self.close_group();
                    self.dirty = true;
                    saved = self.save_now();
                }
                Task::none()
            }
            EditorMessage::Autosave(generation) => {
                if generation == self.generation && self.dirty {
                    saved = self.save_now();
                }
                Task::none()
            }
        };
        (task, saved)
    }

    /// The vault's folder name, for the pane's status line.
    pub fn title_of_vault(&self) -> String {
        self.root.file_name().map_or_else(
            || String::from("vault"),
            |name| name.to_string_lossy().into_owned(),
        )
    }

    fn sidebar_view(&self, id: u64, index: Option<&Index>) -> Element<'_, Message> {
        let message = move |message: EditorMessage| Message::Editor(id, message);
        let tab = |label: &'static str, which: Sidebar| {
            button(text(label).size(size::LABEL).style(style::inherit))
                .padding(Padding::from([space::XS, space::M]))
                .style(style::toggle(self.sidebar == which))
                .on_press(message(EditorMessage::Sidebar(which)))
        };
        let tabs = row![
            tab("Files", Sidebar::Files),
            tab("Search", Sidebar::Search),
            tab("Tags", Sidebar::Tags)
        ]
        .spacing(space::XXS);
        let Some(index) = index else {
            return column![
                tabs,
                text("Opening the vault…")
                    .size(size::META)
                    .style(style::muted)
            ]
            .spacing(space::M)
            .padding(Padding::from([space::L, space::L]))
            .width(measure::SIDEBAR)
            .into();
        };
        let body: Element<'_, Message> = match self.sidebar {
            Sidebar::Files => {
                let visible = tree::window(
                    self.rows.len(),
                    ROW_HEIGHT,
                    self.tree_offset,
                    self.tree_height,
                );
                let mut list = column![Space::new().height(visible.start as f32 * ROW_HEIGHT)];
                for row in &self.rows[visible.clone()] {
                    let (label, folder, on) = match &row.kind {
                        RowKind::Folder { path, expanded } => (
                            format!("{} {}", if *expanded { "▾" } else { "▸" }, row.label),
                            true,
                            EditorMessage::ToggleFolder(path.clone()),
                        ),
                        RowKind::Note { path } => {
                            (row.label.clone(), false, EditorMessage::Open(path.clone()))
                        }
                    };
                    let current = matches!(&row.kind, RowKind::Note { path } if Some(path) == self.path.as_ref());
                    list = list.push(
                        button(
                            container(
                                text(label)
                                    .size(size::LABEL)
                                    .font(if folder {
                                        style::ui_strong()
                                    } else {
                                        style::ui()
                                    })
                                    .style(style::inherit)
                                    .wrapping(text::Wrapping::None),
                            )
                            .center_y(Length::Fill),
                        )
                        .padding(
                            Padding::from([space::NONE, space::L])
                                .left(space::L + row.depth as f32 * measure::INDENT),
                        )
                        .height(ROW_HEIGHT)
                        .width(Length::Fill)
                        .style(style::list_row(current))
                        .on_press(message(on)),
                    );
                }
                list = list.push(
                    Space::new()
                        .height(self.rows.len().saturating_sub(visible.end) as f32 * ROW_HEIGHT),
                );
                scrollable(list)
                    .on_scroll(move |viewport| {
                        message(EditorMessage::TreeScrolled(
                            viewport.absolute_offset().y,
                            viewport.bounds().height,
                        ))
                    })
                    .direction(style::scroll_direction())
                    .style(style::scrollbar)
                    .height(Length::Fill)
                    .into()
            }
            Sidebar::Search => {
                let mut hits = column![].spacing(space::XXS);
                for hit in &self.hits {
                    hits = hits.push(
                        button(
                            column![
                                text(hit.path.clone())
                                    .size(size::META)
                                    .font(style::mono())
                                    .style(style::muted),
                                text(hit.text.clone())
                                    .size(size::LABEL)
                                    .style(style::inherit)
                            ]
                            .spacing(space::XXS),
                        )
                        .padding(Padding::from([space::XS, space::M]))
                        .style(style::list_row(false))
                        .width(Length::Fill)
                        .on_press(message(EditorMessage::SearchOpen(
                            hit.path.clone(),
                            hit.line,
                        ))),
                    );
                }
                let timing = self
                    .search_time
                    .map(|time| {
                        format!(
                            "{} results in {:.1} ms",
                            self.hits.len(),
                            time.as_secs_f64() * 1e3
                        )
                    })
                    .unwrap_or_default();
                column![
                    text_input("Search the vault, or #tag", &self.search_query)
                        .id(iced::widget::Id::from(format!("editor-search-{id}")))
                        .size(size::LABEL)
                        .padding(Padding::from([space::S, space::L]))
                        .style(style::input)
                        .on_input(move |query| message(EditorMessage::SearchQuery(query))),
                    text(timing).size(size::META).style(style::muted),
                    scrollable(hits)
                        .direction(style::scroll_direction())
                        .style(style::scrollbar)
                        .height(Length::Fill),
                ]
                .spacing(space::S)
                .into()
            }
            Sidebar::Tags => {
                let mut tags = column![].spacing(space::XXS);
                for (tag, count) in index.tags() {
                    tags = tags.push(
                        button(
                            row![
                                text(format!("#{tag}"))
                                    .size(size::LABEL)
                                    .style(style::inherit)
                                    .width(Length::Fill),
                                text(count.to_string())
                                    .size(size::META)
                                    .font(style::mono())
                                    .style(style::muted),
                            ]
                            .spacing(space::M)
                            .align_y(iced::Alignment::Center),
                        )
                        .padding(Padding::from([space::XS, space::M]))
                        .width(Length::Fill)
                        .style(style::list_row(false))
                        .on_press(message(EditorMessage::SearchQuery(format!("#{tag}")))),
                    );
                }
                scrollable(tags)
                    .direction(style::scroll_direction())
                    .style(style::scrollbar)
                    .height(Length::Fill)
                    .into()
            }
        };
        column![
            tabs,
            container(
                text(format!("{} notes", index.len()))
                    .size(size::META)
                    .style(style::muted)
            )
            .padding(Padding::from([space::NONE, space::M])),
            body
        ]
        .spacing(space::S)
        .padding(Padding::from([space::XS, space::L]).bottom(space::L))
        .width(measure::SIDEBAR)
        .into()
    }

    fn properties_view(&self, id: u64, focused: bool) -> Option<Element<'_, Message>> {
        if self.front.properties.is_empty() {
            return None;
        }
        let message = move |message: EditorMessage| Message::Editor(id, message);
        let mut list = column![].spacing(space::XS);
        for property in &self.front.properties {
            let value: Element<'_, Message> = match &property.value {
                Value::Text(current) => {
                    let key = property.key.clone();
                    let submit_key = key.clone();
                    text_input("", self.drafts.get(&property.key).unwrap_or(current))
                        .size(size::LABEL)
                        .padding(Padding::from([space::XXS, space::S]))
                        .style(style::bare_input)
                        .on_input(move |value| {
                            message(EditorMessage::PropertyDraft(key.clone(), value))
                        })
                        .on_submit(message(EditorMessage::PropertySubmit(submit_key)))
                        .into()
                }
                Value::List(items) => container(text(items.join(", ")).size(size::LABEL))
                    .padding(Padding::from([space::XXS, space::S]))
                    .into(),
                Value::Other(raw) => container(
                    text(raw.clone())
                        .size(size::MONO)
                        .font(style::mono())
                        .style(style::muted),
                )
                .padding(Padding::from([space::XXS, space::S]))
                .into(),
            };
            list = list.push(
                row![
                    text(property.key.clone())
                        .size(size::LABEL)
                        .width(measure::PROPERTY_KEY)
                        .style(style::muted),
                    value
                ]
                .spacing(space::M)
                .align_y(iced::Alignment::Center),
            );
        }
        Some(
            container(
                container(list)
                    .padding(Padding::from([space::L, space::XL]))
                    .style(style::well(focused))
                    .width(Length::Fill),
            )
            .padding(Padding::from([space::NONE, space::XL]).bottom(space::XS))
            .into(),
        )
    }

    fn backlinks_view(&self, id: u64, index: Option<&Index>) -> Element<'_, Message> {
        let mut list = row![text("Backlinks").size(size::META).style(style::muted)]
            .spacing(space::S)
            .align_y(iced::Alignment::Center);
        if let (Some(index), Some(path)) = (index, &self.path) {
            let backlinks = index.backlinks(path);
            if backlinks.is_empty() {
                list = list.push(text("none").size(size::META).style(style::muted));
            }
            for note in backlinks.into_iter().take(100) {
                list = list.push(
                    button(
                        text(note.name.clone())
                            .size(size::META)
                            .style(style::inherit),
                    )
                    .padding(Padding::from([space::XXS, space::S]))
                    .style(style::link)
                    .on_press(Message::Editor(id, EditorMessage::Open(note.path.clone()))),
                );
            }
        }
        column![
            style::hline(),
            scrollable(list.padding(Padding::from([space::S, space::XL])))
                .direction(style::scroll_direction_across())
                .style(style::scrollbar)
                .width(Length::Fill)
        ]
        .into()
    }

    pub fn view(
        &self,
        id: u64,
        index: Option<&Index>,
        mode: Mode,
        focused: bool,
    ) -> Element<'_, Message> {
        let message = move |message: EditorMessage| Message::Editor(id, message);
        let completion_open = self
            .completion
            .as_ref()
            .is_some_and(|completion| !completion.items.is_empty());
        let editor = iced::widget::text_editor(&self.content)
            .id(Self::editor_id(id))
            .placeholder(if self.path.is_some() {
                ""
            } else {
                "Open a note from the tree, or press Cmd+O."
            })
            .height(Length::Fill)
            .size(size::BODY)
            .padding(Padding::from([space::L, space::XL]))
            .wrapping(text::Wrapping::WordOrGlyph)
            .style(style::page)
            .highlight_with::<iced::highlighter::Highlighter>(
                style::source_settings(mode),
                style::source,
            )
            .on_action(move |action| message(EditorMessage::Action(action)))
            .key_binding(move |press| {
                use iced::keyboard::Key;
                use iced::keyboard::key::Named;
                if completion_open {
                    match press.key {
                        Key::Named(Named::Enter | Named::Tab) => {
                            return Some(Binding::Custom(message(EditorMessage::Complete(None))));
                        }
                        Key::Named(Named::ArrowDown) => {
                            return Some(Binding::Custom(message(EditorMessage::CompletionMove(
                                1,
                            ))));
                        }
                        Key::Named(Named::ArrowUp) => {
                            return Some(Binding::Custom(message(EditorMessage::CompletionMove(
                                -1,
                            ))));
                        }
                        _ => {}
                    }
                }
                // The logo key belongs to the window's shortcuts, apart from the editing ones.
                if press.modifiers.logo() {
                    if let Key::Character(c) = &press.key
                        && matches!(c.as_str(), "c" | "x" | "v" | "a")
                    {
                        return Binding::from_key_press(press);
                    }
                    return None;
                }
                Binding::from_key_press(press)
            });

        let mut editor_column = column![];
        if let Some(find) = &self.find {
            editor_column = editor_column.push(
                row![
                    text_input("Find in note", &find.query)
                        .id(Self::input_id(id))
                        .size(size::LABEL)
                        .padding(Padding::from([space::S, space::L]))
                        .style(style::input)
                        .on_input(move |query| message(EditorMessage::FindQuery(query)))
                        .on_submit(message(EditorMessage::FindNext)),
                    text(if find.query.is_empty() {
                        String::new()
                    } else {
                        format!("{} found", find.matches.len())
                    })
                    .size(size::META)
                    .style(style::muted),
                ]
                .spacing(space::M)
                .padding(Padding::from([space::NONE, space::XL]).bottom(space::M))
                .align_y(iced::Alignment::Center),
            );
        }
        let mut editor_stack = stack![editor];
        if let Some(completion) = self
            .completion
            .as_ref()
            .filter(|completion| !completion.items.is_empty())
        {
            let mut items = column![].spacing(space::XXS);
            for (index, name) in completion.items.iter().enumerate() {
                items = items.push(style::choice_row(
                    name.clone(),
                    None,
                    index == completion.selected,
                    message(EditorMessage::Complete(Some(index))),
                ));
            }
            editor_stack = editor_stack.push(
                container(
                    container(items)
                        .width(measure::COMPLETION)
                        .padding(space::S)
                        .style(style::overlay_panel),
                )
                .align_bottom(Length::Fill)
                .padding(space::L),
            );
        }
        editor_column = editor_column.push(editor_stack);

        let viewer = VaultViewer {
            root: &self.root,
            focused,
        };
        let blocks = self.preview.items();
        let mut preview_column = column![
            markdown::view_with(
                &blocks[..blocks.len().min(PREVIEW_BLOCKS)],
                style::prose(mode, focused, size::BODY),
                &viewer
            )
            .map(move |url| message(EditorMessage::PreviewLink(url)))
        ]
        .spacing(space::L)
        .padding(Padding::from([space::L, space::XL]).bottom(space::XXL))
        .max_width(measure::READING + space::XL * 2.0);
        if blocks.len() > PREVIEW_BLOCKS {
            preview_column = preview_column.push(
                text(format!(
                    "The preview shows the first {PREVIEW_BLOCKS} of {} blocks.",
                    blocks.len()
                ))
                .size(size::META)
                .style(style::muted),
            );
        }
        let preview = scrollable(preview_column)
            .direction(style::scroll_direction())
            .style(style::scrollbar)
            .width(Length::Fill)
            .height(Length::Fill);

        let modes = row![
            mode_button("Edit", EditorMode::Edit, self.mode, id),
            mode_button("Split", EditorMode::Split, self.mode, id),
            mode_button("Preview", EditorMode::Preview, self.mode, id),
            Space::new().width(Length::Fill),
            text(self.error.clone().unwrap_or_default())
                .size(size::META)
                .style(style::bad),
        ]
        .spacing(space::XXS)
        .padding(Padding::from([space::XS, space::XL]).bottom(space::M))
        .align_y(iced::Alignment::Center);

        let main: Element<'_, Message> = match self.mode {
            EditorMode::Edit => editor_column.into(),
            EditorMode::Preview => preview.into(),
            EditorMode::Split => row![
                editor_column.width(Length::FillPortion(1)),
                style::vline(),
                preview.width(Length::FillPortion(1))
            ]
            .into(),
        };
        // A note's properties sit above both halves of a split, so they
        // keep the pane's full width.
        let mut content = column![modes];
        if self.mode != EditorMode::Preview
            && let Some(properties) = self.properties_view(id, focused)
        {
            content = content.push(properties);
        }
        content = content.push(main).push(self.backlinks_view(id, index));
        let body = row![
            self.sidebar_view(id, index),
            style::vline(),
            content.width(Length::Fill)
        ];

        let mut layers = stack![body];
        if let Some(switcher) = &self.switcher {
            let query = text_input("Open a note by name", &switcher.query)
                .id(Self::input_id(id))
                .size(size::QUERY)
                .padding(space::NONE)
                .style(style::bare_input)
                .on_input(move |query| message(EditorMessage::SwitcherQuery(query)))
                .on_submit(message(EditorMessage::SwitcherOpen(None)));
            let choices = switcher
                .items
                .iter()
                .enumerate()
                .map(|(index, path)| {
                    let selected = index == switcher.selected;
                    let (folder, name) = match path.rsplit_once('/') {
                        Some((folder, name)) => (Some(folder), name),
                        None => (None, path.as_str()),
                    };
                    style::choice_row(
                        name.trim_end_matches(".md").to_string(),
                        folder.map(|folder| {
                            style::choice_note(
                                style::clip_start(folder, measure::TAB_TITLE_CHARS),
                                selected,
                            )
                        }),
                        selected,
                        message(EditorMessage::SwitcherOpen(Some(index))),
                    )
                })
                .collect();
            layers = layers.push(style::overlay(
                style::panel(
                    query,
                    choices,
                    &[("Enter", "open"), ("Up, Down", "choose"), ("Esc", "close")],
                    measure::SWITCHER,
                ),
                space::HUGE,
            ));
        }
        layers.into()
    }
}

fn mode_button(
    label: &'static str,
    mode: EditorMode,
    current: EditorMode,
    id: u64,
) -> Element<'static, Message> {
    button(text(label).size(size::LABEL).style(style::inherit))
        .padding(Padding::from([space::XS, space::M]))
        .style(style::toggle(mode == current))
        .on_press(Message::Editor(id, EditorMessage::Mode(mode)))
        .into()
}

/// What a link in the preview points at.
pub enum PreviewTarget {
    Note(String),
    External(String),
}

pub fn preview_target(url: &str) -> PreviewTarget {
    match url.strip_prefix(WIKI_SCHEME) {
        Some(target) => PreviewTarget::Note(decode(target)),
        None => PreviewTarget::External(url.to_string()),
    }
}

/// Draws the preview's images from the vault's own files.
struct VaultViewer<'a> {
    root: &'a Path,
    /// Whether the pane is focused, which decides what a well stands on.
    focused: bool,
}

impl<'a> markdown::Viewer<'a, String> for VaultViewer<'a> {
    fn on_link_click(url: markdown::Uri) -> String {
        url
    }

    fn code_block(
        &self,
        _settings: markdown::Settings,
        _language: Option<&'a str>,
        code: &'a str,
        _lines: &'a [markdown::Text],
    ) -> Element<'a, String> {
        style::code_block(code, self.focused)
    }

    fn image(
        &self,
        settings: markdown::Settings,
        url: &'a markdown::Uri,
        _title: &'a str,
        alt: &markdown::Text,
    ) -> Element<'a, String> {
        let path = url.strip_prefix(VAULT_SCHEME).map(|name| {
            let name = decode(name);
            let direct = self.root.join(&name);
            if direct.exists() {
                direct
            } else {
                find_attachment(self.root, &name).unwrap_or(direct)
            }
        });
        match path {
            Some(path) if path.exists() => image(image::Handle::from_path(path))
                .width(Length::Shrink)
                .into(),
            _ => text(format!(
                "[{}]",
                alt.spans(settings.style)
                    .iter()
                    .map(|span| span.text.as_ref())
                    .collect::<String>()
            ))
            .size(size::META)
            .style(style::muted)
            .into(),
        }
    }
}

/// An embed names a file by name alone; Obsidian finds it anywhere in the vault.
fn find_attachment(root: &Path, name: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                pending.push(path);
            } else if entry.file_name().to_string_lossy() == name {
                return Some(path);
            }
        }
    }
    None
}
