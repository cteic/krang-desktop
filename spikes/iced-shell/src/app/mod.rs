//! The window: tabs of tiling panes, the command palette, and the routing
//! of every message to the pane it is for.

mod chat;
mod editor;
mod feed;
mod palette;
mod probe;
pub mod selftest;
mod shortcuts;
mod terminal;
mod web;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use alacritty_terminal::event::Event as TermSignal;
use iced::widget::pane_grid::{self, PaneGrid};
use iced::widget::{button, column, container, mouse_area, row, stack, text, text_input};
use iced::{Element, Length, Subscription, Task, Theme, keyboard, window};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::chat::runner::RunEvent;
use crate::shell::layout::{
    self, Axis, EditorMode, PaneKind, PaneSpec, TabSpec, Tree, WORKSPACE_VERSION, Workspace,
};
use crate::shell::store;
use crate::term::events::{self, TermEvent};
use crate::term::session::GridSize;
use crate::term::view::{Input, cell_size};
use crate::vault::index::Index;
use crate::web::host::{self, ParentWindow, WebEvent, WebHost};

use chat::{ChatMessage, ChatPane};
use editor::{EditorMessage, EditorPane, PreviewTarget};
use feed::Feed;
use palette::{Command, NewPane, Palette};
use shortcuts::Action;
use terminal::TerminalPane;
use web::{WebMessage, WebPane};

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub layouts: Vec<PathBuf>,
    /// Start empty instead of restoring the saved workspace.
    pub fresh: bool,
    pub selftest: Option<selftest::Plan>,
}

#[derive(Debug, Clone)]
pub enum Message {
    WindowReady(window::Id, Option<ParentWindow>),
    CloseRequested(window::Id),
    Shortcut(Action),
    Term(TermEvent),
    Terminal(u64, Input),
    RestartTerminal(u64),
    Run(RunEvent),
    Chat(u64, ChatMessage),
    WebEvent(WebEvent),
    Web(u64, WebMessage),
    WebPump,
    Editor(u64, EditorMessage),
    VaultOpened(PathBuf, std::sync::Arc<std::sync::Mutex<Option<Index>>>),
    PaneClicked(pane_grid::Pane),
    PaneResized(pane_grid::ResizeEvent),
    PaneDragged(pane_grid::DragEvent),
    ClosePane(u64),
    SelectTab(usize),
    CloseTab(usize),
    PaletteQuery(String),
    PaletteRun(Option<Command>),
    /// Up or down in whichever list is open: the palette or the quick switcher.
    Step(i32),
    Frame(Instant),
    SelfTest(selftest::Step),
}

enum Body {
    Terminal(TerminalPane),
    Editor(Box<EditorPane>),
    Web(WebPane),
    Chat(ChatPane),
}

struct Pane {
    title: Option<String>,
    body: Body,
}

struct Tab {
    title: String,
    grid: pane_grid::State<u64>,
    focus: Option<pane_grid::Pane>,
}

pub struct App {
    window: Option<window::Id>,
    tabs: Vec<Tab>,
    active: usize,
    panes: HashMap<u64, Pane>,
    next_id: u64,
    term_sender: events::Sender,
    run_sender: UnboundedSender<RunEvent>,
    term_feed: Feed<TermEvent>,
    run_feed: Feed<RunEvent>,
    web_feed: Feed<WebEvent>,
    web: WebHost,
    vaults: HashMap<PathBuf, Option<Index>>,
    palette: Option<Palette>,
    persist: bool,
    state_dir: Option<PathBuf>,
    default_vault: PathBuf,
    selftest: Option<selftest::SelfTest>,
}

const PALETTE_INPUT: &str = "palette-input";
const NOWHERE: &str = "no-widget";

pub fn run(options: Options) -> iced::Result {
    iced::application(move || App::boot(options.clone()), App::update, App::view)
        .title(App::title)
        .subscription(App::subscription)
        .theme(|_: &App| Theme::TokyoNight)
        .exit_on_close_request(false)
        .window_size((1280.0, 800.0))
        .run()
}

fn default_size() -> GridSize {
    let cell = cell_size(terminal::FONT_SIZE);
    GridSize {
        columns: 80,
        lines: 24,
        cell_width: cell.width.round() as u16,
        cell_height: cell.height.round() as u16,
    }
}

fn axis(axis: Axis) -> pane_grid::Axis {
    match axis {
        Axis::Vertical => pane_grid::Axis::Vertical,
        Axis::Horizontal => pane_grid::Axis::Horizontal,
    }
}

impl App {
    fn boot(options: Options) -> (Self, Task<Message>) {
        let (term_sender, term_receiver) = events::queue();
        let (run_sender, run_receiver) = unbounded_channel();
        let (web_sender, web_receiver) = unbounded_channel();
        let state_dir = store::state_dir();
        let persist = options.layouts.is_empty();
        let default_vault = std::env::var_os("KRANG_VAULT")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let mut app = Self {
            window: None,
            tabs: Vec::new(),
            active: 0,
            panes: HashMap::new(),
            next_id: 1,
            term_sender,
            run_sender,
            term_feed: Feed::new("terminals", term_receiver),
            run_feed: Feed::new("runs", run_receiver),
            web_feed: Feed::new("web", web_receiver),
            web: WebHost::new(web_sender),
            vaults: HashMap::new(),
            palette: None,
            persist,
            state_dir,
            default_vault,
            selftest: options.selftest.map(selftest::SelfTest::new),
        };

        let mut tasks = vec![window::oldest().and_then(|id| {
            window::run(id, move |window| {
                Message::WindowReady(id, ParentWindow::from_window(window))
            })
        })];
        let mut specs: Vec<TabSpec> = Vec::new();
        let mut active = 0;
        for path in &options.layouts {
            match std::fs::read_to_string(path)
                .map_err(|error| error.to_string())
                .and_then(|source| layout::parse_layout(&source))
            {
                Ok(tab) => specs.push(tab),
                Err(error) => eprintln!("krang-shell: {}: {error}", path.display()),
            }
        }
        if specs.is_empty()
            && persist
            && !options.fresh
            && let Some(saved) = app.state_dir.as_deref().and_then(store::load)
        {
            active = saved.active;
            specs = saved.tabs;
        }
        if specs.is_empty() {
            specs.push(app.new_tab_spec(NewPane::Terminal));
        }
        for spec in specs {
            let (tab, task) = app.build_tab(spec);
            app.tabs.push(tab);
            tasks.push(task);
        }
        app.active = active.min(app.tabs.len() - 1);
        tasks.push(app.show_tab());
        if let Some(selftest) = app.selftest.as_mut() {
            tasks.push(selftest.start());
        }
        (app, Task::batch(tasks))
    }

    fn title(&self) -> String {
        let pane = self.focused_id().and_then(|id| self.pane_title(id));
        match pane {
            Some(title) => format!("{title} · Krang Shell"),
            None => String::from("Krang Shell"),
        }
    }

    fn new_tab_spec(&self, kind: NewPane) -> TabSpec {
        TabSpec {
            title: String::from("shell"),
            tree: Tree::Pane(self.new_pane_spec(kind)),
            focus: Some(0),
            maximized: false,
        }
    }

    /// A new pane of a kind, starting where the focused pane is working.
    fn new_pane_spec(&self, kind: NewPane) -> PaneSpec {
        let directory = self.focused_id().and_then(|id| self.pane_directory(id));
        let kind = match kind {
            NewPane::Terminal => PaneKind::Terminal {
                directory: directory.map(|dir| dir.to_string_lossy().into_owned()),
                commands: Vec::new(),
            },
            NewPane::Editor => PaneKind::Editor {
                vault: Some(self.default_vault.to_string_lossy().into_owned()),
                path: None,
                mode: EditorMode::Edit,
            },
            NewPane::Web => PaneKind::Web { url: String::new() },
            NewPane::Chat => PaneKind::Chat {
                agent: crate::chat::Agent::Claude,
                directory: directory.map(|dir| dir.to_string_lossy().into_owned()),
                mode: crate::chat::Mode::ReadOnly,
                trusted: false,
                transcript: Default::default(),
            },
        };
        PaneSpec { title: None, kind }
    }

    fn pane_directory(&self, id: u64) -> Option<PathBuf> {
        match &self.panes.get(&id)?.body {
            Body::Terminal(pane) => pane.working_directory(),
            Body::Editor(pane) => Some(pane.root.clone()),
            Body::Chat(pane) => pane.directory.as_deref().map(layout::expand_home),
            Body::Web(_) => None,
        }
    }

    fn create_pane(&mut self, spec: PaneSpec) -> (u64, Task<Message>) {
        let id = self.next_id;
        self.next_id += 1;
        let mut task = Task::none();
        let body = match spec.kind {
            PaneKind::Terminal {
                directory,
                commands,
            } => {
                let directory = directory.as_deref().map(layout::expand_home);
                Body::Terminal(TerminalPane::start(
                    id,
                    directory,
                    default_size(),
                    &self.term_sender,
                    &commands,
                ))
            }
            PaneKind::Editor { vault, path, mode } => {
                let path = path.map(|path| layout::expand_home(&path));
                let root = vault
                    .map(|vault| layout::expand_home(&vault))
                    .or_else(|| path.as_deref().and_then(vault_root_for))
                    .unwrap_or_else(|| self.default_vault.clone());
                let root = std::fs::canonicalize(&root).unwrap_or(root);
                let mut pane = EditorPane::new(root.clone(), mode);
                if let Some(relative) = path
                    .and_then(|path| std::fs::canonicalize(&path).ok())
                    .and_then(|path| crate::vault::index::relative(&root, &path))
                {
                    task = pane.open(&relative);
                }
                if let Some(Some(index)) = self.vaults.get(&root) {
                    pane.sync_tree(index);
                } else if !self.vaults.contains_key(&root) {
                    self.vaults.insert(root.clone(), None);
                    task = Task::batch([task, open_vault(root)]);
                }
                Body::Editor(Box::new(pane))
            }
            PaneKind::Web { url } => Body::Web(WebPane::new(&url)),
            PaneKind::Chat {
                agent,
                directory,
                mode,
                trusted,
                transcript,
            } => Body::Chat(ChatPane::new(agent, directory, mode, trusted, transcript)),
        };
        self.panes.insert(
            id,
            Pane {
                title: spec.title,
                body,
            },
        );
        (id, task)
    }

    fn build_tab(&mut self, spec: TabSpec) -> (Tab, Task<Message>) {
        let mut tasks = Vec::new();
        let mut leaves = Vec::new();
        let configuration = self.configuration(spec.tree, &mut tasks, &mut leaves);
        let grid = pane_grid::State::with_configuration(configuration);
        let focus_id = spec
            .focus
            .and_then(|index| leaves.get(index).copied())
            .or(leaves.first().copied());
        let focus = grid
            .iter()
            .find(|(_, id)| Some(**id) == focus_id)
            .map(|(pane, _)| *pane);
        let mut tab = Tab {
            title: spec.title,
            grid,
            focus,
        };
        if spec.maximized
            && let Some(focus) = focus
        {
            tab.grid.maximize(focus);
        }
        (tab, Task::batch(tasks))
    }

    fn configuration(
        &mut self,
        tree: Tree,
        tasks: &mut Vec<Task<Message>>,
        leaves: &mut Vec<u64>,
    ) -> pane_grid::Configuration<u64> {
        match tree {
            Tree::Pane(spec) => {
                let (id, task) = self.create_pane(spec);
                tasks.push(task);
                leaves.push(id);
                pane_grid::Configuration::Pane(id)
            }
            Tree::Split {
                axis: split,
                ratio,
                a,
                b,
            } => pane_grid::Configuration::Split {
                axis: axis(split),
                ratio,
                a: Box::new(self.configuration(*a, tasks, leaves)),
                b: Box::new(self.configuration(*b, tasks, leaves)),
            },
        }
    }

    fn pane_spec(&self, id: u64) -> Option<PaneSpec> {
        let pane = self.panes.get(&id)?;
        let kind = match &pane.body {
            Body::Terminal(terminal) => PaneKind::Terminal {
                directory: terminal
                    .working_directory()
                    .map(|dir| dir.to_string_lossy().into_owned()),
                commands: Vec::new(),
            },
            Body::Editor(editor) => PaneKind::Editor {
                vault: Some(editor.root.to_string_lossy().into_owned()),
                path: editor
                    .path
                    .as_ref()
                    .map(|path| editor.absolute(path).to_string_lossy().into_owned()),
                mode: editor.mode,
            },
            Body::Web(web) => PaneKind::Web {
                url: web.url.clone(),
            },
            Body::Chat(chat) => PaneKind::Chat {
                agent: chat.agent,
                directory: chat.directory.clone(),
                mode: chat.mode,
                trusted: chat.trusted,
                transcript: chat.transcript.clone(),
            },
        };
        Some(PaneSpec {
            title: pane.title.clone(),
            kind,
        })
    }

    fn tree_of(&self, grid: &pane_grid::State<u64>, node: &pane_grid::Node) -> Option<Tree> {
        Some(match node {
            pane_grid::Node::Pane(pane) => Tree::Pane(self.pane_spec(*grid.get(*pane)?)?),
            pane_grid::Node::Split {
                axis: split,
                ratio,
                a,
                b,
                ..
            } => Tree::Split {
                axis: if *split == pane_grid::Axis::Vertical {
                    Axis::Vertical
                } else {
                    Axis::Horizontal
                },
                ratio: *ratio,
                a: Box::new(self.tree_of(grid, a)?),
                b: Box::new(self.tree_of(grid, b)?),
            },
        })
    }

    fn workspace(&self) -> Workspace {
        let tabs = self
            .tabs
            .iter()
            .filter_map(|tab| {
                let tree = self.tree_of(&tab.grid, tab.grid.layout())?;
                let leaves = leaf_ids(&tab.grid, tab.grid.layout());
                let focus = tab
                    .focus
                    .and_then(|pane| tab.grid.get(pane))
                    .and_then(|id| leaves.iter().position(|leaf| leaf == id));
                Some(TabSpec {
                    title: tab.title.clone(),
                    tree,
                    focus,
                    maximized: tab.grid.maximized().is_some(),
                })
            })
            .collect();
        Workspace {
            version: WORKSPACE_VERSION,
            tabs,
            active: self.active,
        }
    }

    fn save(&self) {
        if !self.persist {
            return;
        }
        if let Some(dir) = &self.state_dir
            && let Err(error) = store::save(dir, &self.workspace())
        {
            eprintln!("krang-shell: could not save the workspace: {error}");
        }
    }

    fn tab(&self) -> &Tab {
        &self.tabs[self.active]
    }

    fn tab_mut(&mut self) -> &mut Tab {
        &mut self.tabs[self.active]
    }

    fn focused_id(&self) -> Option<u64> {
        let tab = self.tabs.get(self.active)?;
        tab.focus.and_then(|pane| tab.grid.get(pane)).copied()
    }

    fn pane_title(&self, id: u64) -> Option<String> {
        let pane = self.panes.get(&id)?;
        if let Some(title) = &pane.title {
            return Some(title.clone());
        }
        Some(match &pane.body {
            Body::Terminal(terminal) => terminal
                .title
                .clone()
                .unwrap_or_else(|| String::from("terminal")),
            Body::Editor(editor) => editor.title(),
            Body::Web(web) => web
                .title
                .clone()
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| String::from("web")),
            Body::Chat(chat) => format!("chat · {}", chat.agent.label()),
        })
    }

    /// Whether a pane is on screen now: in the shown tab, and not hidden
    /// behind a magnified pane.
    fn is_visible(&self, id: u64) -> bool {
        let tab = self.tab();
        match tab.grid.maximized() {
            Some(pane) => tab.grid.get(pane) == Some(&id),
            None => tab.grid.iter().any(|(_, known)| *known == id),
        }
    }

    fn sync_web(&mut self) {
        let shown: Vec<u64> = if self.palette.is_some() {
            Vec::new()
        } else {
            self.panes
                .iter()
                .filter(|(id, pane)| matches!(pane.body, Body::Web(_)) && self.is_visible(**id))
                .map(|(id, _)| *id)
                .collect()
        };
        self.web.show_only(&|id| shown.contains(&id));
    }

    /// Brings the shown tab's terminals up to date and gives the focused
    /// pane the keyboard.
    fn show_tab(&mut self) -> Task<Message> {
        let ids: Vec<u64> = self.tab().grid.iter().map(|(_, id)| *id).collect();
        for id in ids {
            if let Some(Pane {
                body:
                    Body::Terminal(TerminalPane {
                        session: Some(session),
                        ..
                    }),
                ..
            }) = self.panes.get_mut(&id)
            {
                session.show();
            }
        }
        self.focus_task()
    }

    fn focus_task(&self) -> Task<Message> {
        let Some(id) = self.focused_id() else {
            return Task::none();
        };
        for (other, pane) in &self.panes {
            if *other != id && matches!(pane.body, Body::Web(_)) {
                self.web.blur(*other);
            }
        }
        match self.panes.get(&id).map(|pane| &pane.body) {
            Some(Body::Editor(_)) => iced::widget::operation::focus(EditorPane::editor_id(id)),
            Some(Body::Chat(_)) => iced::widget::operation::focus(ChatPane::input_id(id)),
            Some(Body::Web(_)) => {
                self.web.focus(id);
                iced::widget::operation::focus(NOWHERE)
            }
            _ => iced::widget::operation::focus(NOWHERE),
        }
    }

    fn focus(&mut self, pane: pane_grid::Pane) -> Task<Message> {
        self.tab_mut().focus = Some(pane);
        self.focus_task()
    }

    fn split(&mut self, kind: NewPane, down: bool) -> Task<Message> {
        let Some(target) = self
            .tab()
            .focus
            .or_else(|| self.tab().grid.iter().next().map(|(pane, _)| *pane))
        else {
            return Task::none();
        };
        let spec = self.new_pane_spec(kind);
        let (id, task) = self.create_pane(spec);
        let split_axis = if down {
            pane_grid::Axis::Horizontal
        } else {
            pane_grid::Axis::Vertical
        };
        if self.tab().grid.maximized().is_some() {
            self.tab_mut().grid.restore();
        }
        let Some((pane, _)) = self.tab_mut().grid.split(split_axis, target, id) else {
            self.panes.remove(&id);
            return task;
        };
        let focus = self.focus(pane);
        self.save();
        Task::batch([task, focus])
    }

    fn close_pane(&mut self, id: u64) -> Task<Message> {
        let Some(tab_index) = self
            .tabs
            .iter()
            .position(|tab| tab.grid.iter().any(|(_, known)| *known == id))
        else {
            return Task::none();
        };
        let tab = &mut self.tabs[tab_index];
        let Some(pane) = tab
            .grid
            .iter()
            .find(|(_, known)| **known == id)
            .map(|(pane, _)| *pane)
        else {
            return Task::none();
        };
        if tab.grid.len() == 1 {
            return self.close_tab(tab_index);
        }
        if let Some((_, sibling)) = tab.grid.close(pane) {
            tab.focus = Some(sibling);
        }
        self.drop_pane(id);
        self.save();
        self.focus_task()
    }

    /// Ends what a pane runs: a terminal's shell, a chat's agent, a web view.
    fn drop_pane(&mut self, id: u64) {
        if let Some(mut pane) = self.panes.remove(&id) {
            match &mut pane.body {
                Body::Chat(chat) => chat.stop(),
                Body::Web(_) => self.web.close(id),
                Body::Editor(editor) => {
                    if editor.dirty {
                        self.store_saved(&editor.root.clone(), editor.save_now());
                    }
                }
                Body::Terminal(_) => {}
            }
        }
    }

    fn close_tab(&mut self, index: usize) -> Task<Message> {
        if index >= self.tabs.len() {
            return Task::none();
        }
        let tab = self.tabs.remove(index);
        for (_, id) in tab.grid.iter() {
            self.drop_pane(*id);
        }
        if self.tabs.is_empty() {
            let (tab, task) = {
                let spec = self.new_tab_spec(NewPane::Terminal);
                self.build_tab(spec)
            };
            self.tabs.push(tab);
            self.active = 0;
            self.save();
            return Task::batch([task, self.show_tab()]);
        }
        self.active = self.active.min(self.tabs.len() - 1);
        self.save();
        self.show_tab()
    }

    fn new_tab(&mut self, kind: NewPane) -> Task<Message> {
        let spec = self.new_tab_spec(kind);
        let (tab, task) = self.build_tab(spec);
        self.tabs.push(tab);
        self.active = self.tabs.len() - 1;
        self.save();
        Task::batch([task, self.show_tab()])
    }

    fn cycle_pane(&mut self, by: i32) -> Task<Message> {
        let tab = self.tab();
        let order = leaf_panes(tab.grid.layout());
        if order.is_empty() {
            return Task::none();
        }
        let current = tab
            .focus
            .and_then(|focus| order.iter().position(|pane| *pane == focus))
            .unwrap_or(0);
        let next = order[(current as i32 + by).rem_euclid(order.len() as i32) as usize];
        if self.tab().grid.maximized().is_some() {
            self.tab_mut().grid.maximize(next);
        }
        self.focus(next)
    }

    fn store_saved(&mut self, root: &PathBuf, saved: Option<(String, String)>) {
        if let (Some((path, text)), Some(Some(index))) = (saved, self.vaults.get_mut(root)) {
            index.update(&path, text);
        }
    }

    fn with_editor(
        &mut self,
        f: impl FnOnce(&mut EditorPane, u64, Option<&Index>) -> Task<Message>,
    ) -> Task<Message> {
        let Some(id) = self.focused_id() else {
            return Task::none();
        };
        let Some(Pane {
            body: Body::Editor(editor),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return Task::none();
        };
        let index = self.vaults.get(&editor.root).and_then(Option::as_ref);
        f(editor, id, index)
    }

    fn shortcut(&mut self, action: Action) -> Task<Message> {
        match action {
            Action::Escape => {
                if self.palette.take().is_some() {
                    self.sync_web();
                    return self.focus_task();
                }
                return self.with_editor(|editor, _, _| {
                    editor.escape();
                    Task::none()
                });
            }
            Action::Palette => {
                if self.palette.take().is_some() {
                    self.sync_web();
                    return self.focus_task();
                }
                self.palette = Some(Palette::new());
                self.sync_web();
                return iced::widget::operation::focus(PALETTE_INPUT);
            }
            Action::NewTab => return self.new_tab(NewPane::Terminal),
            Action::SplitRight => return self.split(NewPane::Terminal, false),
            Action::SplitDown => return self.split(NewPane::Terminal, true),
            Action::Magnify => {
                let tab = self.tab_mut();
                if tab.grid.maximized().is_some() {
                    tab.grid.restore();
                } else if let Some(focus) = tab.focus {
                    tab.grid.maximize(focus);
                }
                self.save();
                return self.show_tab();
            }
            Action::NextPane => return self.cycle_pane(1),
            Action::PreviousPane => return self.cycle_pane(-1),
            Action::NextTab | Action::PreviousTab => {
                let by = if action == Action::NextTab { 1 } else { -1 };
                self.active = (self.active as i32 + by).rem_euclid(self.tabs.len() as i32) as usize;
                return self.show_tab();
            }
            Action::GoToTab(index) => {
                if index < self.tabs.len() {
                    self.active = index;
                    return self.show_tab();
                }
            }
            Action::ClosePane => {
                if let Some(id) = self.focused_id() {
                    return self.close_pane(id);
                }
            }
            Action::CloseTab => return self.close_tab(self.active),
            Action::FocusAddress => {
                if let Some(id) = self.focused_id().filter(|id| {
                    matches!(
                        self.panes.get(id).map(|pane| &pane.body),
                        Some(Body::Web(_))
                    )
                }) {
                    self.web.blur(id);
                    return iced::widget::operation::focus(WebPane::address_id(id));
                }
            }
            Action::Reload => {
                if let Some(id) = self.focused_id() {
                    self.web.reload(id);
                }
            }
            Action::Undo | Action::Redo => {
                return self.with_editor(|editor, id, _| editor.undo(id, action == Action::Redo));
            }
            Action::Find => return self.with_editor(|editor, id, _| editor.open_find(id)),
            Action::QuickSwitcher => {
                return self.with_editor(|editor, id, index| editor.open_switcher(id, index));
            }
            Action::VaultSearch => return self.with_editor(|editor, id, _| editor.open_search(id)),
            Action::TogglePreview => {
                return self.with_editor(|editor, _, _| {
                    editor.toggle_preview();
                    Task::none()
                });
            }
            Action::Save => {
                let Some(id) = self.focused_id() else {
                    return Task::none();
                };
                if let Some(Pane {
                    body: Body::Editor(editor),
                    ..
                }) = self.panes.get_mut(&id)
                {
                    let root = editor.root.clone();
                    let saved = editor.save_now();
                    self.store_saved(&root, saved);
                }
            }
            Action::FollowLink => {
                let Some(id) = self.focused_id() else {
                    return Task::none();
                };
                if let Some(Pane {
                    body: Body::Editor(editor),
                    ..
                }) = self.panes.get(&id)
                    && let Some(target) = editor.link_at_cursor()
                {
                    return self.follow(id, &target);
                }
            }
        }
        Task::none()
    }

    /// Opens the note a wikilink names, creating it when it does not exist.
    fn follow(&mut self, id: u64, target: &str) -> Task<Message> {
        let Some(Pane {
            body: Body::Editor(editor),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return Task::none();
        };
        let root = editor.root.clone();
        let Some(Some(index)) = self.vaults.get_mut(&root) else {
            return Task::none();
        };
        let path = match index.resolve(target) {
            Some(note) => note.path.clone(),
            None => {
                let name = target
                    .trim()
                    .trim_end_matches(".md")
                    .replace(['\\', ':'], "-");
                if name.is_empty() || name.split('/').any(|part| part == ".." || part.is_empty()) {
                    return Task::none();
                }
                let path = format!("{name}.md");
                let file = root.join(&path);
                if let Some(parent) = file.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let text = format!("# {}\n", name.rsplit('/').next().unwrap_or(&name));
                if std::fs::write(&file, &text).is_err() {
                    return Task::none();
                }
                index.update(&path, text);
                path
            }
        };
        let index = self.vaults.get(&root).and_then(Option::as_ref);
        let (task, saved) = editor.update(id, EditorMessage::Open(path), index);
        self.store_saved(&root, saved);
        self.refresh_trees(&root);
        Task::batch([
            task,
            iced::widget::operation::focus(EditorPane::editor_id(id)),
        ])
    }

    fn refresh_trees(&mut self, root: &PathBuf) {
        let Some(Some(index)) = self.vaults.get(root) else {
            return;
        };
        for pane in self.panes.values_mut() {
            if let Body::Editor(editor) = &mut pane.body
                && &editor.root == root
            {
                editor.sync_tree(index);
            }
        }
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        let task = self.handle(message);
        self.sync_web();
        task
    }

    fn handle(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::WindowReady(id, parent) => {
                self.window = Some(id);
                if let Some(parent) = parent {
                    self.web.set_parent(parent);
                    for id in self.panes.keys().copied().collect::<Vec<_>>() {
                        self.place_web(id);
                    }
                }
            }
            Message::CloseRequested(id) => {
                self.save();
                for id in self.panes.keys().copied().collect::<Vec<_>>() {
                    self.drop_pane(id);
                }
                return window::close(id);
            }
            Message::Shortcut(action) => return self.shortcut(action),
            Message::Term(TermEvent { id, event }) => {
                let visible = self.is_visible(id);
                let Some(Pane {
                    body: Body::Terminal(terminal),
                    ..
                }) = self.panes.get_mut(&id)
                else {
                    return Task::none();
                };
                match event {
                    TermSignal::Wakeup => {
                        if let Some(session) = terminal.session.as_mut() {
                            session.wakeup(visible);
                        }
                        if let Some(selftest) = self.selftest.as_mut() {
                            return selftest.terminal_output(id, terminal);
                        }
                    }
                    TermSignal::Title(title) => terminal.title = Some(title),
                    TermSignal::ResetTitle => terminal.title = None,
                    TermSignal::PtyWrite(text) => {
                        if let Some(session) = &terminal.session {
                            session.write(text.into_bytes());
                        }
                    }
                    TermSignal::ClipboardStore(_, text) => return iced::clipboard::write(text),
                    TermSignal::Exit | TermSignal::ChildExit(_) => {
                        terminal.session = None;
                        return self.close_pane(id);
                    }
                    _ => {}
                }
            }
            Message::Terminal(id, input) => return self.terminal_input(id, input),
            Message::RestartTerminal(id) => {
                let size = default_size();
                if let Some(Pane {
                    body: Body::Terminal(terminal),
                    ..
                }) = self.panes.get_mut(&id)
                {
                    *terminal = TerminalPane::start(
                        id,
                        terminal.start_directory.clone(),
                        size,
                        &self.term_sender,
                        &[],
                    );
                }
            }
            Message::Run(event) => {
                let pane = event.pane;
                if let Some(Pane {
                    body: Body::Chat(chat),
                    ..
                }) = self.panes.get_mut(&pane)
                {
                    if chat.receive(event) {
                        self.save();
                    }
                    return iced::widget::operation::snap_to_end(ChatPane::transcript_id(pane));
                }
            }
            Message::Chat(id, message) => return self.chat(id, message),
            Message::WebEvent(event) => return self.web_event(event),
            Message::Web(id, message) => return self.web_message(id, message),
            Message::WebPump => host::pump(),
            Message::Editor(id, message) => return self.editor(id, message),
            Message::VaultOpened(root, slot) => {
                let index = slot.lock().ok().and_then(|mut slot| slot.take());
                if let Some(index) = index {
                    self.vaults.insert(root.clone(), Some(index));
                    self.refresh_trees(&root);
                    if let Some(selftest) = self.selftest.as_mut() {
                        return selftest.vault_opened();
                    }
                }
            }
            Message::PaneClicked(pane) => {
                if self.tab().focus != Some(pane) {
                    return self.focus(pane);
                }
            }
            Message::PaneResized(pane_grid::ResizeEvent { split, ratio }) => {
                self.tab_mut().grid.resize(split, ratio);
                self.save();
            }
            Message::PaneDragged(pane_grid::DragEvent::Dropped { pane, target }) => {
                self.tab_mut().grid.drop(pane, target);
                self.save();
            }
            Message::PaneDragged(_) => {}
            Message::ClosePane(id) => return self.close_pane(id),
            Message::SelectTab(index) => {
                if index < self.tabs.len() {
                    self.active = index;
                    return self.show_tab();
                }
            }
            Message::CloseTab(index) => return self.close_tab(index),
            Message::PaletteQuery(query) => {
                if let Some(palette) = self.palette.as_mut() {
                    palette.query = query;
                    palette.filter();
                }
            }
            Message::PaletteRun(command) => {
                let command = command.or_else(|| self.palette.as_ref().and_then(Palette::chosen));
                self.palette = None;
                self.sync_web();
                return match command {
                    Some(Command::Add(kind, down)) => self.split(kind, down),
                    Some(Command::NewTab(kind)) => self.new_tab(kind),
                    Some(Command::ClosePane) => self.shortcut(Action::ClosePane),
                    Some(Command::CloseTab) => self.shortcut(Action::CloseTab),
                    Some(Command::Magnify) => self.shortcut(Action::Magnify),
                    None => self.focus_task(),
                };
            }
            Message::Step(by) => {
                if let Some(palette) = self.palette.as_mut() {
                    palette.step(by);
                } else if let Some(id) = self.focused_id()
                    && matches!(
                        self.panes.get(&id).map(|pane| &pane.body),
                        Some(Body::Editor(_))
                    )
                {
                    return self.editor(id, EditorMessage::SwitcherMove(by));
                }
            }
            Message::Frame(at) => {
                if let Some(selftest) = self.selftest.as_mut() {
                    return selftest.frame(at);
                }
            }
            Message::SelfTest(step) => return selftest::step(self, step),
        }
        Task::none()
    }

    fn terminal_input(&mut self, id: u64, input: Input) -> Task<Message> {
        if let Input::Focus = input {
            let pane = self
                .tab()
                .grid
                .iter()
                .find(|(_, known)| **known == id)
                .map(|(pane, _)| *pane);
            return pane.map_or_else(Task::none, |pane| self.focus(pane));
        }
        let Some(Pane {
            body:
                Body::Terminal(TerminalPane {
                    session: Some(session),
                    ..
                }),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return Task::none();
        };
        match input {
            Input::Bytes(bytes) => session.type_bytes(bytes),
            Input::Resize(size) => session.resize(size),
            Input::Scroll(lines) => session.scroll(lines),
            Input::Select {
                kind,
                line,
                column,
                right_half,
            } => session.select(kind, line, column, right_half),
            Input::ExtendSelection {
                line,
                column,
                right_half,
            } => session.extend_selection(line, column, right_half),
            Input::ClearSelection => session.clear_selection(),
            Input::Copy => {
                if let Some(text) = session.selection_text() {
                    return iced::clipboard::write(text);
                }
            }
            Input::Paste(text) => {
                let bytes = crate::term::input::encode_paste(&text, session.mode());
                session.type_bytes(bytes);
            }
            Input::OpenLink(url) => {
                let _ = open::that_detached(url);
            }
            Input::Focus => {}
        }
        Task::none()
    }

    fn chat(&mut self, id: u64, message: ChatMessage) -> Task<Message> {
        let run = self.next_id;
        let Some(Pane {
            body: Body::Chat(chat),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return Task::none();
        };
        match message {
            ChatMessage::Draft(action) => chat.draft.perform(action),
            ChatMessage::Send => {
                self.next_id += 1;
                chat.send(id, run, &self.run_sender);
                self.save();
                return iced::widget::operation::snap_to_end(ChatPane::transcript_id(id));
            }
            ChatMessage::Stop => {
                chat.stop();
                self.save();
            }
            ChatMessage::ToggleMode => {
                chat.mode = match chat.mode {
                    crate::chat::Mode::ReadOnly => crate::chat::Mode::Edit,
                    crate::chat::Mode::Edit => crate::chat::Mode::ReadOnly,
                };
                self.save();
            }
            ChatMessage::Trust => {
                chat.trusted = true;
                self.save();
            }
            ChatMessage::Link(url) => {
                let _ = open::that_detached(url);
            }
        }
        Task::none()
    }

    fn web_event(&mut self, event: WebEvent) -> Task<Message> {
        let pane = match &event {
            WebEvent::Loading { pane, .. }
            | WebEvent::Loaded { pane, .. }
            | WebEvent::Title { pane, .. }
            | WebEvent::Shortcut { pane, .. } => *pane,
            WebEvent::Focused(pane) => *pane,
        };
        let history = self.web.history(pane);
        if let Some(selftest) = self.selftest.as_mut() {
            selftest.web_event(&event);
        }
        let Some(Pane {
            body: Body::Web(web),
            ..
        }) = self.panes.get_mut(&pane)
        else {
            return Task::none();
        };
        match event {
            WebEvent::Loading { url, .. } => {
                web.loading = true;
                web.url = url;
                web.address = crate::web::address::display(&web.url);
            }
            WebEvent::Loaded { url, .. } => {
                web.loading = false;
                web.url = url;
                web.address = crate::web::address::display(&web.url);
                (web.can_back, web.can_forward) = history;
                self.save();
            }
            WebEvent::Title { title, .. } => web.title = Some(title),
            WebEvent::Focused(_) => {
                let target = self
                    .tab()
                    .grid
                    .iter()
                    .find(|(_, id)| **id == pane)
                    .map(|(pane, _)| *pane);
                if let Some(target) = target {
                    self.tab_mut().focus = Some(target);
                    return iced::widget::operation::focus(NOWHERE);
                }
            }
            WebEvent::Shortcut { key, shift, .. } => {
                if let Some(action) = shortcuts::web_action(&key, shift) {
                    return self.shortcut(action);
                }
            }
        }
        Task::none()
    }

    fn web_message(&mut self, id: u64, message: WebMessage) -> Task<Message> {
        let Some(Pane {
            body: Body::Web(web),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return Task::none();
        };
        match message {
            WebMessage::Address(address) => web.address = address,
            WebMessage::Go => match crate::web::address::resolve(&web.address) {
                Some(url) => {
                    web.url = url.clone();
                    web.error = None;
                    self.web.load(id, &url);
                    self.web.focus(id);
                }
                None => web.error = Some(format!("{} is not an address or a file", web.address)),
            },
            WebMessage::Back => self.web.back(id),
            WebMessage::Forward => self.web.forward(id),
            WebMessage::Reload => self.web.reload(id),
            WebMessage::Bounds(bounds) => {
                web.bounds = Some(bounds);
                self.place_web(id);
            }
        }
        Task::none()
    }

    /// Builds a pane's web view once the window and the pane's bounds are
    /// both known, then moves it there. The two arrive in either order.
    fn place_web(&mut self, id: u64) {
        let Some(Pane {
            body: Body::Web(web),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return;
        };
        let Some(bounds) = web.bounds else {
            return;
        };
        if !self.web.is_ready() {
            return;
        }
        if !self.web.has(id)
            && let Err(error) = self.web.create(id, &web.url)
        {
            web.error = Some(format!("The web view could not start: {error}"));
        }
        self.web.set_bounds(id, bounds);
    }

    fn editor(&mut self, id: u64, message: EditorMessage) -> Task<Message> {
        if let EditorMessage::Follow(target) = &message {
            let target = target.clone();
            return self.follow(id, &target);
        }
        if let EditorMessage::PreviewLink(url) = &message {
            return match editor::preview_target(url) {
                PreviewTarget::Note(target) => self.follow(id, &target),
                PreviewTarget::External(url) => {
                    let _ = open::that_detached(url);
                    Task::none()
                }
            };
        }
        let Some(Pane {
            body: Body::Editor(editor),
            ..
        }) = self.panes.get_mut(&id)
        else {
            return Task::none();
        };
        let root = editor.root.clone();
        let index = self.vaults.get(&root).and_then(Option::as_ref);
        let started = Instant::now();
        let is_action = matches!(message, EditorMessage::Action(_));
        let (task, saved) = editor.update(id, message, index);
        if is_action && let Some(selftest) = self.selftest.as_mut() {
            selftest.edited(started);
        }
        if saved.is_some() {
            self.store_saved(&root, saved);
            self.save();
        }
        task
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![
            Subscription::run_with(self.term_feed.clone(), feed::stream).map(Message::Term),
            Subscription::run_with(self.run_feed.clone(), feed::stream).map(Message::Run),
            Subscription::run_with(self.web_feed.clone(), feed::stream).map(Message::WebEvent),
            iced::event::listen_with(|event, _status, _window| match event {
                iced::Event::Keyboard(keyboard::Event::KeyPressed {
                    key: keyboard::Key::Named(keyboard::key::Named::ArrowUp),
                    ..
                }) => Some(Message::Step(-1)),
                iced::Event::Keyboard(keyboard::Event::KeyPressed {
                    key: keyboard::Key::Named(keyboard::key::Named::ArrowDown),
                    ..
                }) => Some(Message::Step(1)),
                iced::Event::Keyboard(keyboard::Event::KeyPressed { key, modifiers, .. }) => {
                    shortcuts::action(&key, modifiers).map(Message::Shortcut)
                }
                _ => None,
            }),
            window::close_requests().map(Message::CloseRequested),
        ];
        if cfg!(target_os = "linux") && !self.web.is_empty() {
            // WebKitGTK only: see `host::pump`. macOS needs no timer.
            subscriptions.push(
                iced::time::every(std::time::Duration::from_millis(16)).map(|_| Message::WebPump),
            );
        }
        if self
            .selftest
            .as_ref()
            .is_some_and(selftest::SelfTest::wants_frames)
        {
            subscriptions.push(iced::event::listen_raw(
                |event, _status, _window| match event {
                    iced::Event::Window(window::Event::RedrawRequested(at)) => {
                        Some(Message::Frame(at))
                    }
                    _ => None,
                },
            ));
        }
        Subscription::batch(subscriptions)
    }

    fn view(&self) -> Element<'_, Message> {
        let mut tabs = row![].spacing(2).padding([4, 6]);
        for (index, tab) in self.tabs.iter().enumerate() {
            let focus_title = tab
                .focus
                .and_then(|pane| tab.grid.get(pane))
                .and_then(|id| self.pane_title(*id));
            let label = format!(
                "{}  {}",
                index + 1,
                focus_title.unwrap_or_else(|| tab.title.clone())
            );
            tabs = tabs.push(
                row![
                    button(text(label).size(12).wrapping(text::Wrapping::None))
                        .padding([3, 10])
                        .style(if index == self.active {
                            button::primary
                        } else {
                            button::secondary
                        })
                        .on_press(Message::SelectTab(index)),
                    button(text("×").size(12))
                        .padding([3, 6])
                        .style(button::text)
                        .on_press(Message::CloseTab(index)),
                ]
                .spacing(0),
            );
        }

        let tab = self.tab();
        let focus = tab.focus;
        let grid = PaneGrid::new(&tab.grid, |pane, id, _maximized| {
            let focused = focus == Some(pane);
            let id = *id;
            let title = self.pane_title(id).unwrap_or_default();
            let body: Element<'_, Message> = match self.panes.get(&id).map(|pane| &pane.body) {
                Some(Body::Terminal(terminal)) => terminal.view(id, focused),
                Some(Body::Editor(editor)) => {
                    editor.view(id, self.vaults.get(&editor.root).and_then(Option::as_ref))
                }
                Some(Body::Web(web)) => web.view(id),
                Some(Body::Chat(chat)) => chat.view(id),
                None => text("").into(),
            };
            let title_bar = pane_grid::TitleBar::new(text(title).size(12).style(if focused {
                text::primary
            } else {
                text::secondary
            }))
            .controls(pane_grid::Controls::new(
                button(text("×").size(12))
                    .padding([0, 6])
                    .style(button::text)
                    .on_press(Message::ClosePane(id)),
            ))
            .padding([2, 8])
            .style(move |theme: &Theme| {
                let palette = theme.extended_palette();
                container::Style::default().background(if focused {
                    palette.background.strong.color
                } else {
                    palette.background.weak.color
                })
            });
            pane_grid::Content::new(body)
                .title_bar(title_bar)
                .style(move |theme: &Theme| {
                    let palette = theme.extended_palette();
                    container::Style::default()
                        .background(palette.background.base.color)
                        .border(iced::Border {
                            color: if focused {
                                palette.primary.strong.color
                            } else {
                                palette.background.strong.color
                            },
                            width: 1.0,
                            radius: 0.0.into(),
                        })
                })
        })
        .spacing(4)
        .on_click(Message::PaneClicked)
        .on_drag(Message::PaneDragged)
        .on_resize(8, Message::PaneResized);

        let mut layers = stack![column![
            tabs,
            container(grid).padding([0, 4]).height(Length::Fill)
        ]];
        if let Some(palette) = &self.palette {
            let mut list = column![
                text_input("Type a command", &palette.query)
                    .id(PALETTE_INPUT)
                    .size(14)
                    .on_input(Message::PaletteQuery)
                    .on_submit(Message::PaletteRun(None))
            ]
            .spacing(2);
            for (index, command) in palette.matches.iter().enumerate() {
                list = list.push(
                    button(text(palette::label(*command)).size(13))
                        .width(Length::Fill)
                        .style(if index == palette.selected {
                            button::primary
                        } else {
                            button::text
                        })
                        .on_press(Message::PaletteRun(Some(*command))),
                );
            }
            layers = layers.push(
                mouse_area(
                    container(
                        container(list)
                            .width(520)
                            .padding(8)
                            .style(container::bordered_box),
                    )
                    .center_x(Length::Fill)
                    .padding(60)
                    .height(Length::Fill),
                )
                .on_press(Message::Shortcut(Action::Escape)),
            );
        }
        layers.into()
    }
}

fn leaf_panes(node: &pane_grid::Node) -> Vec<pane_grid::Pane> {
    match node {
        pane_grid::Node::Pane(pane) => vec![*pane],
        pane_grid::Node::Split { a, b, .. } => {
            let mut panes = leaf_panes(a);
            panes.extend(leaf_panes(b));
            panes
        }
    }
}

fn leaf_ids(grid: &pane_grid::State<u64>, node: &pane_grid::Node) -> Vec<u64> {
    leaf_panes(node)
        .into_iter()
        .filter_map(|pane| grid.get(pane).copied())
        .collect()
}

/// The vault a note belongs to: the nearest folder above it that holds
/// `.obsidian`, or else the note's own folder.
fn vault_root_for(path: &std::path::Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    parent
        .ancestors()
        .find(|dir| dir.join(".obsidian").is_dir())
        .map(PathBuf::from)
        .or_else(|| Some(parent.to_path_buf()))
}

fn open_vault(root: PathBuf) -> Task<Message> {
    let reading = root.clone();
    Task::perform(
        async move {
            let index = tokio::task::spawn_blocking(move || Index::open(&reading))
                .await
                .ok();
            std::sync::Arc::new(std::sync::Mutex::new(index))
        },
        move |slot| Message::VaultOpened(root.clone(), slot),
    )
}
