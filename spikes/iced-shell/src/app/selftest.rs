//! A scripted run for tests and benchmarks, chosen with `KRANG_SELFTEST`.
//! It needs no keyboard focus and no person: it drives the app through its
//! own messages, prints `name value` lines on standard output, and exits.
//!
//! | Scenario            | What it does                                              |
//! | ------------------- | --------------------------------------------------------- |
//! | `first-frame`       | Prints the time from process start to the first frame     |
//! | `hold`              | Stays open `KRANG_SELFTEST_SECONDS`, saves, exits         |
//! | `flood`             | Pings the pane titled `quiet` each second while the others print |
//! | `resize`            | Moves the first divider every frame and times the frames |
//! | `editor`            | Opens `KRANG_SELFTEST_NOTE`, types, searches the vault    |
//! | `terminal-latency`  | Types into the first terminal and times the echo         |
//! | `web`               | Waits for the first web pane to load                      |
//! | `showcase`          | Fills the chat pane, then holds; for screenshots          |
//! | `chat-scroll`       | Fills a chat past its pane and reports where it is scrolled |
//! | `tabs`              | Names a tab, moves it, saves it as a layout, prints the tabs |
//! | `files`             | Opens `KRANG_SELFTEST_DIR` in a files pane and times it   |
//!
//! `showcase` sends two messages to the first chat pane, the second one
//! failing, so a transcript with a tool step, code, a cost and an error is
//! on screen. `KRANG_SELFTEST_SHOW=palette` then opens the command palette
//! and `KRANG_SELFTEST_SHOW=switcher` the first editor's quick switcher.
//!
//! `chat-scroll` opens a chat in a new tab, sends it messages until the
//! transcript is taller than the pane, and prints how much of it is out of
//! sight below the view: while a reply streams, and after it stops. Zero
//! means the newest line is showing. `KRANG_SELFTEST_SHOW=restored` sends
//! nothing and measures the chat that came back from the saved workspace.
//!
//! `tabs` prints the tab names as they are at the start, so a second run on
//! the same state shows what was restored. It then adds two tabs, names the
//! first `Planning` through the same messages a double click and typing
//! send, moves it one place right, saves it as a layout, prints the names
//! again and holds. `KRANG_SELFTEST_SHOW=rename` leaves the name field open.
//!
//! `files` first prints the folder and open folders of any files pane that
//! came back from the saved workspace. It then opens `KRANG_SELFTEST_DIR`
//! in a new tab and prints how long the listing took, how long the rows
//! took, and the time from a Page Down to the frame that shows it, sixty
//! times over. `KRANG_SELFTEST_OPEN` is a comma-separated list of paths
//! under the folder to click in turn, a folder before what is in it; the
//! panes of the tab are printed afterwards. `KRANG_SELFTEST_SHOW=restored`
//! opens nothing new.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use iced::Task;
use iced::widget::text_editor::{Action, Edit};

use crate::web::host::WebEvent;

use crate::shell::layout::{PaneKind, PaneSpec, TabSpec, Tree};

use super::chat::{ChatMessage, ChatPane};
use super::editor::EditorMessage;
use super::files::{FilesMessage, Nav};
use super::palette::{Command, NewPane};
use super::scroll::{Locate, Place};
use super::shortcuts::Action as Shortcut;
use super::terminal::TerminalPane;
use super::{App, Body, Message, Pane};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// Called first thing in `main`, so the first-frame time covers the app's
/// own start-up.
pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    FirstFrame,
    Hold,
    Flood,
    Resize,
    Editor,
    TerminalLatency,
    Web,
    Showcase,
    ChatScroll,
    Tabs,
    Files,
}

impl Plan {
    pub fn from_env() -> Option<Self> {
        Some(match std::env::var("KRANG_SELFTEST").ok()?.as_str() {
            "first-frame" => Plan::FirstFrame,
            "hold" => Plan::Hold,
            "flood" => Plan::Flood,
            "resize" => Plan::Resize,
            "editor" => Plan::Editor,
            "terminal-latency" => Plan::TerminalLatency,
            "web" => Plan::Web,
            "showcase" => Plan::Showcase,
            "chat-scroll" => Plan::ChatScroll,
            "tabs" => Plan::Tabs,
            "files" => Plan::Files,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub enum Step {
    Begin,
    Ping(u32),
    Type(u32),
    TerminalType(u32),
    Show(u32),
    Measured(&'static str, Place),
    Finish,
}

fn seconds() -> u64 {
    std::env::var("KRANG_SELFTEST_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(30)
}

fn after(delay: Duration, step: Step) -> Task<Message> {
    Task::perform(tokio::time::sleep(delay), move |()| {
        Message::SelfTest(step.clone())
    })
}

fn report(name: &str, value: impl std::fmt::Display) {
    println!("{name} {value}");
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1e3
}

/// Median, 99th percentile and largest of a set of times, in milliseconds.
pub fn summary(times: &mut [Duration]) -> (f64, f64, f64) {
    if times.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    times.sort();
    let at = |fraction: f64| times[((times.len() - 1) as f64 * fraction).round() as usize];
    (
        millis(at(0.5)),
        millis(at(0.99)),
        millis(times[times.len() - 1]),
    )
}

fn report_summary(name: &str, times: &mut [Duration]) {
    let (median, p99, max) = summary(times);
    report(&format!("{name}_count"), times.len());
    report(&format!("{name}_median_ms"), format!("{median:.2}"));
    report(&format!("{name}_p99_ms"), format!("{p99:.2}"));
    report(&format!("{name}_max_ms"), format!("{max:.2}"));
}

/// Waits for the frame that shows a change: the next redraw draws it, and
/// the one after starts once that frame is on screen.
struct Probe {
    since: Instant,
    frames: u8,
}

pub struct SelfTest {
    plan: Plan,
    first_frame: bool,
    probe: Option<Probe>,
    frames: Vec<Instant>,
    resize_until: Option<Instant>,
    pings: Vec<(u32, Instant)>,
    ping_times: Vec<Duration>,
    key_times: Vec<Duration>,
    echo_times: Vec<Duration>,
    typed: Option<(Instant, usize)>,
    edit_times: Vec<Duration>,
    nav_times: Vec<Duration>,
    files_started: Option<Instant>,
    vault_ready: bool,
    web_started: Instant,
}

impl SelfTest {
    pub fn new(plan: Plan) -> Self {
        Self {
            plan,
            first_frame: false,
            probe: None,
            frames: Vec::new(),
            resize_until: None,
            pings: Vec::new(),
            ping_times: Vec::new(),
            key_times: Vec::new(),
            echo_times: Vec::new(),
            typed: None,
            edit_times: Vec::new(),
            nav_times: Vec::new(),
            files_started: None,
            vault_ready: false,
            web_started: Instant::now(),
        }
    }

    pub fn start(&mut self) -> Task<Message> {
        // Give shells a moment to print their prompts.
        after(Duration::from_millis(1500), Step::Begin)
    }

    pub fn wants_frames(&self) -> bool {
        !self.first_frame || self.probe.is_some() || self.resize_until.is_some()
    }

    pub fn frame(&mut self, at: Instant) -> Task<Message> {
        if !self.first_frame {
            self.first_frame = true;
            if let Some(start) = PROCESS_START.get() {
                report(
                    "first_frame_ms",
                    format!("{:.1}", millis(at.duration_since(*start))),
                );
            }
            if self.plan == Plan::FirstFrame {
                return iced::exit();
            }
        }
        if let Some(probe) = self.probe.as_mut() {
            probe.frames += 1;
            if probe.frames >= 2 {
                let since = probe.since;
                self.probe = None;
                self.key_times.push(at.duration_since(since));
            }
        }
        if let Some(until) = self.resize_until {
            self.frames.push(at);
            if at >= until {
                self.resize_until = None;
                let mut intervals: Vec<Duration> = self
                    .frames
                    .windows(2)
                    .map(|pair| pair[1].duration_since(pair[0]))
                    .collect();
                report_summary("resize_frame", &mut intervals);
                return Task::done(Message::SelfTest(Step::Finish));
            }
        }
        Task::none()
    }

    pub fn terminal_output(&mut self, _id: u64, terminal: &TerminalPane) -> Task<Message> {
        let Some(session) = &terminal.session else {
            return Task::none();
        };
        if terminal.title.as_deref() == Some("quiet") || self.plan == Plan::Flood {
            let screen = session.snapshot().text();
            let now = Instant::now();
            self.pings.retain(|(number, sent)| {
                let seen = screen
                    .lines()
                    .any(|line| line.trim() == format!("ping-{number}"));
                if seen {
                    self.ping_times.push(now.duration_since(*sent));
                }
                !seen
            });
        }
        if let Some((since, before)) = self.typed {
            let count = session.snapshot().text().matches('x').count();
            if count > before {
                self.typed = None;
                self.echo_times.push(since.elapsed());
                self.probe = Some(Probe { since, frames: 0 });
            }
        }
        Task::none()
    }

    pub fn vault_opened(&mut self) -> Task<Message> {
        self.vault_ready = true;
        Task::none()
    }

    pub fn web_event(&mut self, event: &WebEvent) {
        if self.plan == Plan::Web
            && let WebEvent::Loaded { url, .. } = event
        {
            report(
                "web_loaded_ms",
                format!("{:.1}", millis(self.web_started.elapsed())),
            );
            report("web_loaded_url", url);
        }
    }

    pub fn edited(&mut self, started: Instant) {
        if self.plan == Plan::Editor {
            self.edit_times.push(started.elapsed());
        }
    }
}

fn find_pane(app: &App, wanted: impl Fn(&Pane) -> bool) -> Option<u64> {
    let mut ids: Vec<u64> = app
        .panes
        .iter()
        .filter(|(_, pane)| wanted(pane))
        .map(|(id, _)| *id)
        .collect();
    ids.sort_unstable();
    ids.first().copied()
}

fn quiet_terminal(app: &App) -> Option<u64> {
    find_pane(app, |pane| {
        pane.title.as_deref() == Some("quiet") && matches!(pane.body, Body::Terminal(_))
    })
}

pub fn step(app: &mut App, step: Step) -> Task<Message> {
    let Some(plan) = app.selftest.as_ref().map(|selftest| selftest.plan) else {
        return Task::none();
    };
    match (plan, step) {
        (Plan::FirstFrame, _) => Task::none(),
        (Plan::Hold | Plan::Web, Step::Begin) => {
            after(Duration::from_secs(seconds()), Step::Finish)
        }
        (Plan::Showcase, Step::Begin) => Task::batch([
            after(Duration::from_millis(200), Step::Show(0)),
            after(Duration::from_secs(seconds()), Step::Finish),
        ]),
        (Plan::Showcase, Step::Show(number)) => showcase(app, number),
        (Plan::Files, Step::Begin) => files(app, 0),
        (Plan::Files, Step::Show(number)) => files(app, number),
        (Plan::Tabs, Step::Begin) => tabs(app, 0),
        (Plan::Tabs, Step::Show(number)) => tabs(app, number),
        (Plan::ChatScroll, Step::Begin) => chat_scroll(app, 0),
        (Plan::ChatScroll, Step::Show(number)) => chat_scroll(app, number),
        (Plan::ChatScroll, Step::Measured(name, place)) => {
            report(
                &format!("chat_scroll_{name}_below_px"),
                format!("{:.0}", place.below),
            );
            report(
                &format!("chat_scroll_{name}_hidden_px"),
                format!("{:.0}", place.hidden),
            );
            Task::none()
        }
        (Plan::Flood, Step::Begin) => {
            report("flood_seconds", seconds());
            Task::batch([
                after(Duration::from_secs(1), Step::Ping(0)),
                after(Duration::from_secs(seconds()), Step::Finish),
            ])
        }
        (Plan::Flood, Step::Ping(number)) => {
            if let Some(id) = quiet_terminal(app)
                && let Some(Pane {
                    body:
                        Body::Terminal(TerminalPane {
                            session: Some(session),
                            ..
                        }),
                    ..
                }) = app.panes.get(&id)
            {
                session.write(format!("echo ping-{number}\r").into_bytes());
                if let Some(selftest) = app.selftest.as_mut() {
                    selftest.pings.push((number, Instant::now()));
                }
            }
            after(Duration::from_secs(1), Step::Ping(number + 1))
        }
        (Plan::Resize, Step::Begin) => {
            if let Some(selftest) = app.selftest.as_mut() {
                selftest.resize_until =
                    Some(Instant::now() + Duration::from_secs(seconds().min(20)));
            }
            Task::none()
        }
        (Plan::TerminalLatency, Step::Begin) => {
            Task::done(Message::SelfTest(Step::TerminalType(0)))
        }
        (Plan::TerminalLatency, Step::TerminalType(number)) => {
            if number >= 60 {
                return Task::done(Message::SelfTest(Step::Finish));
            }
            let Some(id) = find_pane(app, |pane| matches!(pane.body, Body::Terminal(_))) else {
                return Task::none();
            };
            if let Some(Pane {
                body:
                    Body::Terminal(TerminalPane {
                        session: Some(session),
                        ..
                    }),
                ..
            }) = app.panes.get_mut(&id)
            {
                let before = session.snapshot().text().matches('x').count();
                if let Some(selftest) = app.selftest.as_mut() {
                    selftest.typed = Some((Instant::now(), before));
                }
                session.type_bytes(b"x".to_vec());
            }
            after(Duration::from_millis(60), Step::TerminalType(number + 1))
        }
        (Plan::Editor, Step::Begin) => {
            let ready = app
                .selftest
                .as_ref()
                .is_some_and(|selftest| selftest.vault_ready);
            if !ready {
                return after(Duration::from_millis(100), Step::Begin);
            }
            let Some(id) = find_pane(app, |pane| matches!(pane.body, Body::Editor(_))) else {
                return Task::none();
            };
            let note = std::env::var("KRANG_SELFTEST_NOTE").unwrap_or_default();
            if let Some(Pane {
                body: Body::Editor(editor),
                ..
            }) = app.panes.get_mut(&id)
            {
                let started = Instant::now();
                let _ = editor.open(&note);
                report(
                    "editor_open_ms",
                    format!("{:.1}", millis(started.elapsed())),
                );
                report("editor_open_lines", editor.content.line_count());
                if let Some(selftest) = app.selftest.as_mut() {
                    selftest.probe = Some(Probe {
                        since: started,
                        frames: 0,
                    });
                }
            }
            after(Duration::from_millis(1500), Step::Type(0))
        }
        (Plan::Editor, Step::Type(number)) => {
            if number == 0
                && let Some(selftest) = app.selftest.as_mut()
            {
                // The first probe measured the open; keystrokes start here.
                if let Some(first) = selftest.key_times.first().copied() {
                    report("editor_open_to_frame_ms", format!("{:.1}", millis(first)));
                }
                selftest.key_times.clear();
                selftest.edit_times.clear();
            }
            if number >= 100 {
                return Task::done(Message::SelfTest(Step::Finish));
            }
            let Some(id) = find_pane(app, |pane| matches!(pane.body, Body::Editor(_))) else {
                return Task::none();
            };
            if let Some(selftest) = app.selftest.as_mut() {
                selftest.probe = Some(Probe {
                    since: Instant::now(),
                    frames: 0,
                });
            }
            let c = char::from(b'a' + (number % 26) as u8);
            Task::batch([
                Task::done(Message::Editor(
                    id,
                    EditorMessage::Action(Action::Edit(Edit::Insert(c))),
                )),
                after(Duration::from_millis(40), Step::Type(number + 1)),
            ])
        }
        (_, Step::Finish) => finish(app),
        _ => Task::none(),
    }
}

/// What the showcase says to the agent. The second message holds the word
/// the fake agent fails on.
const SHOWCASE_PROMPTS: [&str; 2] = [
    "Why does the import drop rows with a blank date?",
    "Run the linter and report the first error.",
];

fn showcase(app: &mut App, number: u32) -> Task<Message> {
    let prompt = SHOWCASE_PROMPTS.get(number as usize);
    let chat = find_pane(app, |pane| matches!(pane.body, Body::Chat(_)));
    if let (Some(prompt), Some(id)) = (prompt, chat) {
        let paste = Action::Edit(Edit::Paste(std::sync::Arc::new((*prompt).to_string())));
        return Task::batch([
            Task::done(Message::Chat(id, ChatMessage::Draft(paste))),
            Task::done(Message::Chat(id, ChatMessage::Send)),
            after(Duration::from_millis(2500), Step::Show(number + 1)),
        ]);
    }
    if number as usize > SHOWCASE_PROMPTS.len() {
        return Task::none();
    }
    match std::env::var("KRANG_SELFTEST_SHOW").as_deref() {
        Ok("palette") => Task::done(Message::Shortcut(Shortcut::Palette)),
        Ok("switcher") => {
            let editor = find_pane(app, |pane| matches!(pane.body, Body::Editor(_)));
            let pane = editor.and_then(|id| {
                app.tab()
                    .grid
                    .iter()
                    .find(|(_, known)| **known == id)
                    .map(|(pane, _)| *pane)
            });
            match pane {
                Some(pane) => {
                    app.tab_mut().focus = Some(pane);
                    Task::done(Message::Shortcut(Shortcut::QuickSwitcher))
                }
                None => Task::none(),
            }
        }
        _ => Task::none(),
    }
}

fn first_files(app: &App) -> Option<u64> {
    find_pane(app, |pane| matches!(pane.body, Body::Files(_)))
}

/// The files pane the test opened: the newest one.
fn last_files(app: &App) -> Option<u64> {
    app.panes
        .iter()
        .filter(|(_, pane)| matches!(pane.body, Body::Files(_)))
        .map(|(id, _)| *id)
        .max()
}

/// What each pane of the shown tab is, and what it has open.
fn report_panes(app: &App, name: &str) {
    let tab = app.tab();
    let panes: Vec<String> = super::leaf_ids(&tab.grid, tab.grid.layout())
        .into_iter()
        .filter_map(|id| app.panes.get(&id))
        .map(|pane| match &pane.body {
            Body::Terminal(_) => String::from("terminal"),
            Body::Chat(_) => String::from("chat"),
            Body::Files(files) => format!("files:{}", files.selected().unwrap_or("")),
            Body::Editor(editor) => format!("editor:{}", editor.path.as_deref().unwrap_or("")),
            Body::Web(web) => format!(
                "web:{}",
                web.url.rsplit('/').next().unwrap_or(web.url.as_str())
            ),
        })
        .collect();
    report(name, panes.join(" | "));
}

const FILES_PAGES: u32 = 60;

fn files(app: &mut App, number: u32) -> Task<Message> {
    let next = |delay: u64| after(Duration::from_millis(delay), Step::Show(number + 1));
    let again = |delay: u64| after(Duration::from_millis(delay), Step::Show(number));
    let restored = std::env::var("KRANG_SELFTEST_SHOW").as_deref() == Ok("restored");
    if number == 0 {
        if let Some(Pane {
            body: Body::Files(files),
            ..
        }) = first_files(app).and_then(|id| app.panes.get(&id))
        {
            report("files_restored_root", files.tree.root().display());
            report("files_restored_open", files.tree.expanded().join(","));
            report("files_restored_hidden", files.tree.show_hidden());
        }
        if restored {
            return after(Duration::from_millis(800), Step::Show(1));
        }
        let directory = std::env::var("KRANG_SELFTEST_DIR").unwrap_or_default();
        let spec = TabSpec {
            title: String::from("files"),
            named: false,
            tree: Tree::Pane(PaneSpec {
                title: None,
                kind: PaneKind::Files {
                    directory: Some(directory),
                    expanded: Vec::new(),
                    hidden: false,
                },
            }),
            focus: Some(0),
            maximized: false,
        };
        let (tab, load) = app.build_tab(spec);
        app.tabs.push(tab);
        app.active = app.tabs.len() - 1;
        if let Some(selftest) = app.selftest.as_mut() {
            selftest.files_started = Some(Instant::now());
        }
        return Task::batch([load, app.show_tab(), next(1)]);
    }
    let Some(id) = last_files(app) else {
        return Task::done(Message::SelfTest(Step::Finish));
    };
    let Some(Pane {
        body: Body::Files(pane),
        ..
    }) = app.panes.get(&id)
    else {
        return Task::none();
    };
    if restored {
        report("files_restored_rows", pane.tree.len());
        return Task::done(Message::SelfTest(Step::Finish));
    }
    let pages = 2..2 + FILES_PAGES;
    match number {
        1 if !pane.tree.is_ready() => again(1),
        1 => {
            report("files_rows", pane.tree.len());
            report("files_list_ms", format!("{:.2}", millis(pane.timings.list)));
            report("files_rows_ms", format!("{:.3}", millis(pane.timings.rows)));
            if let Some(selftest) = app.selftest.as_mut()
                && let Some(started) = selftest.files_started
            {
                report(
                    "files_open_to_listed_ms",
                    format!("{:.1}", millis(started.elapsed())),
                );
                selftest.probe = Some(Probe {
                    since: started,
                    frames: 0,
                });
            }
            next(500)
        }
        step if pages.contains(&step) => {
            if step == pages.start
                && let Some(selftest) = app.selftest.as_mut()
            {
                if let Some(first) = selftest.key_times.first().copied() {
                    report("files_open_to_frame_ms", format!("{:.1}", millis(first)));
                }
                selftest.key_times.clear();
            }
            let started = Instant::now();
            let task = app.files_nav(id, Nav::PageDown);
            if let Some(selftest) = app.selftest.as_mut() {
                selftest.nav_times.push(started.elapsed());
                selftest.probe = Some(Probe {
                    since: started,
                    frames: 0,
                });
            }
            Task::batch([task, next(40)])
        }
        step => {
            let opens: Vec<String> = std::env::var("KRANG_SELFTEST_OPEN")
                .map(|list| {
                    list.split(',')
                        .filter(|path| !path.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default();
            let index = (step - pages.end) as usize;
            if index == 0 {
                if let Some(selftest) = app.selftest.as_mut() {
                    report_summary("files_page_update", &mut selftest.nav_times);
                    report_summary("files_page_to_frame", &mut selftest.key_times);
                }
                report("files_selected", pane.selected().unwrap_or(""));
            }
            match opens.get(index) {
                Some(path) => match pane.tree.position(path) {
                    Some(row) => Task::batch([
                        Task::done(Message::Files(id, FilesMessage::Press(row))),
                        next(400),
                    ]),
                    None => {
                        report("files_not_found", path);
                        next(1)
                    }
                },
                None => {
                    report_panes(app, "files_tab_panes");
                    after(Duration::from_secs(seconds()), Step::Finish)
                }
            }
        }
    }
}

fn report_tabs(app: &App, name: &str) {
    let names: Vec<String> = app.tabs.iter().map(|tab| app.tab_name(tab)).collect();
    report(name, names.join(" | "));
    report(&format!("{name}_active"), app.active);
}

fn tabs(app: &mut App, number: u32) -> Task<Message> {
    let next = |delay: u64| after(Duration::from_millis(delay), Step::Show(number + 1));
    let show = std::env::var("KRANG_SELFTEST_SHOW").ok();
    match number {
        0 => {
            report_tabs(app, "tabs_at_start");
            Task::batch([
                app.new_tab(NewPane::Editor),
                app.new_tab(NewPane::Terminal),
                next(300),
            ])
        }
        1 => Task::batch([
            Task::done(Message::TabPressed(0)),
            Task::done(Message::TabReleased),
            Task::done(Message::RenameTab(0)),
            Task::done(Message::RenameDraft(String::from("Planning"))),
            next(300),
        ]),
        2 if show.as_deref() == Some("rename") => {
            after(Duration::from_secs(seconds()), Step::Finish)
        }
        2 => Task::batch([Task::done(Message::RenameDone), next(300)]),
        3 => Task::batch([
            Task::done(Message::PaletteRun(Some(Command::MoveTabRight))),
            next(300),
        ]),
        4 => Task::batch([
            Task::done(Message::PaletteRun(Some(Command::SaveLayout))),
            next(300),
        ]),
        5 => {
            report_tabs(app, "tabs_at_end");
            if let Some((_, notice)) = &app.notice {
                report("tabs_notice", notice);
            }
            after(Duration::from_secs(seconds()), Step::Finish)
        }
        _ => Task::none(),
    }
}

fn first_chat(app: &App) -> Option<u64> {
    find_pane(app, |pane| matches!(pane.body, Body::Chat(_)))
}

fn say(id: u64, prompt: &str) -> Task<Message> {
    let paste = Action::Edit(Edit::Paste(std::sync::Arc::new(prompt.to_string())));
    Task::batch([
        Task::done(Message::Chat(id, ChatMessage::Draft(paste))),
        Task::done(Message::Chat(id, ChatMessage::Send)),
    ])
}

/// Reads where the first chat's transcript is scrolled to.
fn measure(app: &App, name: &'static str) -> Task<Message> {
    let Some(id) = first_chat(app) else {
        return Task::none();
    };
    iced::advanced::widget::operate(Locate::new(ChatPane::transcript_id(id)))
        .map(move |place| Message::SelfTest(Step::Measured(name, place)))
}

/// How many short replies fill a chat past a pane of the default window.
const CHAT_SCROLL_REPLIES: u32 = 4;

fn chat_scroll(app: &mut App, number: u32) -> Task<Message> {
    let next = |delay: u64| after(Duration::from_millis(delay), Step::Show(number + 1));
    if std::env::var("KRANG_SELFTEST_SHOW").as_deref() == Ok("restored") {
        return match number {
            0 => Task::batch([measure(app, "restored"), next(500)]),
            _ => Task::done(Message::SelfTest(Step::Finish)),
        };
    }
    if number == 0 {
        return Task::batch([app.new_tab(NewPane::Chat), next(300)]);
    }
    let Some(id) = first_chat(app) else {
        return Task::done(Message::SelfTest(Step::Finish));
    };
    let streaming = CHAT_SCROLL_REPLIES + 1;
    match number - 1 {
        sent if sent < CHAT_SCROLL_REPLIES => Task::batch([
            say(
                id,
                &format!("Question {}: what does the import do?", sent + 1),
            ),
            next(1200),
        ]),
        // The fake agent streams a reply to this for ten seconds.
        sent if sent == CHAT_SCROLL_REPLIES => {
            Task::batch([say(id, "Take it slow and explain."), next(3000)])
        }
        step if step == streaming => Task::batch([measure(app, "streaming"), next(200)]),
        step if step == streaming + 1 => {
            Task::batch([Task::done(Message::Chat(id, ChatMessage::Stop)), next(500)])
        }
        step if step == streaming + 2 => Task::batch([measure(app, "settled"), next(300)]),
        _ => Task::done(Message::SelfTest(Step::Finish)),
    }
}

fn finish(app: &mut App) -> Task<Message> {
    let Some(selftest) = app.selftest.as_mut() else {
        return iced::exit();
    };
    match selftest.plan {
        Plan::Flood => {
            let unanswered = selftest.pings.len();
            report_summary("quiet_terminal_echo", &mut selftest.ping_times);
            report("quiet_terminal_unanswered", unanswered);
        }
        Plan::TerminalLatency => {
            report_summary("terminal_echo", &mut selftest.echo_times);
            report_summary("terminal_key_to_frame", &mut selftest.key_times);
        }
        Plan::Editor => {
            report_summary("editor_update", &mut selftest.edit_times);
            report_summary("editor_key_to_frame", &mut selftest.key_times);
            let editor = app.panes.values().find_map(|pane| match &pane.body {
                Body::Editor(editor) => Some(editor),
                _ => None,
            });
            if let Some(index) = editor
                .and_then(|editor| app.vaults.get(&editor.root))
                .and_then(Option::as_ref)
            {
                report("vault_notes", index.len());
                for query in [
                    "meeting",
                    "zebra-unique-term",
                    "#project",
                    "the quick brown",
                ] {
                    let started = Instant::now();
                    let hits = index.search(query, 300).len();
                    report(
                        &format!("search_ms[{}]", query.replace(' ', "_")),
                        format!("{:.2} ({hits} hits)", millis(started.elapsed())),
                    );
                }
            }
        }
        _ => {}
    }
    app.save();
    if let Some(tool) = &app.tool {
        tool.close();
    }
    iced::exit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_reports_median_p99_and_max() {
        let mut times: Vec<Duration> = (1..=100).map(Duration::from_millis).collect();
        let (median, p99, max) = summary(&mut times);
        assert_eq!(
            (median.round(), p99.round(), max.round()),
            (51.0, 99.0, 100.0)
        );
        assert_eq!(summary(&mut []), (0.0, 0.0, 0.0));
    }
}
