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

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use iced::Task;
use iced::widget::text_editor::{Action, Edit};

use crate::web::host::WebEvent;

use super::editor::EditorMessage;
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
    Finish,
}

fn seconds() -> u64 {
    std::env::var("KRANG_SELFTEST_SECONDS").ok().and_then(|value| value.parse().ok()).unwrap_or(30)
}

fn after(delay: Duration, step: Step) -> Task<Message> {
    Task::perform(tokio::time::sleep(delay), move |()| Message::SelfTest(step.clone()))
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
    (millis(at(0.5)), millis(at(0.99)), millis(times[times.len() - 1]))
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
                report("first_frame_ms", format!("{:.1}", millis(at.duration_since(*start))));
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
                let mut intervals: Vec<Duration> = self.frames.windows(2).map(|pair| pair[1].duration_since(pair[0])).collect();
                report_summary("resize_frame", &mut intervals);
                return Task::done(Message::SelfTest(Step::Finish));
            }
        }
        Task::none()
    }

    pub fn terminal_output(&mut self, _id: u64, terminal: &TerminalPane) -> Task<Message> {
        let Some(session) = &terminal.session else { return Task::none() };
        if terminal.title.as_deref() == Some("quiet") || self.plan == Plan::Flood {
            let screen = session.snapshot().text();
            let now = Instant::now();
            self.pings.retain(|(number, sent)| {
                let seen = screen.lines().any(|line| line.trim() == format!("ping-{number}"));
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
            report("web_loaded_ms", format!("{:.1}", millis(self.web_started.elapsed())));
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
    let mut ids: Vec<u64> = app.panes.iter().filter(|(_, pane)| wanted(pane)).map(|(id, _)| *id).collect();
    ids.sort_unstable();
    ids.first().copied()
}

fn quiet_terminal(app: &App) -> Option<u64> {
    find_pane(app, |pane| pane.title.as_deref() == Some("quiet") && matches!(pane.body, Body::Terminal(_)))
}

pub fn step(app: &mut App, step: Step) -> Task<Message> {
    let Some(plan) = app.selftest.as_ref().map(|selftest| selftest.plan) else { return Task::none() };
    match (plan, step) {
        (Plan::FirstFrame, _) => Task::none(),
        (Plan::Hold | Plan::Web, Step::Begin) => after(Duration::from_secs(seconds()), Step::Finish),
        (Plan::Flood, Step::Begin) => {
            report("flood_seconds", seconds());
            Task::batch([after(Duration::from_secs(1), Step::Ping(0)), after(Duration::from_secs(seconds()), Step::Finish)])
        }
        (Plan::Flood, Step::Ping(number)) => {
            if let Some(id) = quiet_terminal(app)
                && let Some(Pane { body: Body::Terminal(TerminalPane { session: Some(session), .. }), .. }) = app.panes.get(&id)
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
                selftest.resize_until = Some(Instant::now() + Duration::from_secs(seconds().min(20)));
            }
            Task::none()
        }
        (Plan::TerminalLatency, Step::Begin) => Task::done(Message::SelfTest(Step::TerminalType(0))),
        (Plan::TerminalLatency, Step::TerminalType(number)) => {
            if number >= 60 {
                return Task::done(Message::SelfTest(Step::Finish));
            }
            let Some(id) = find_pane(app, |pane| matches!(pane.body, Body::Terminal(_))) else { return Task::none() };
            if let Some(Pane { body: Body::Terminal(TerminalPane { session: Some(session), .. }), .. }) = app.panes.get_mut(&id) {
                let before = session.snapshot().text().matches('x').count();
                if let Some(selftest) = app.selftest.as_mut() {
                    selftest.typed = Some((Instant::now(), before));
                }
                session.type_bytes(b"x".to_vec());
            }
            after(Duration::from_millis(60), Step::TerminalType(number + 1))
        }
        (Plan::Editor, Step::Begin) => {
            let ready = app.selftest.as_ref().is_some_and(|selftest| selftest.vault_ready);
            if !ready {
                return after(Duration::from_millis(100), Step::Begin);
            }
            let Some(id) = find_pane(app, |pane| matches!(pane.body, Body::Editor(_))) else { return Task::none() };
            let note = std::env::var("KRANG_SELFTEST_NOTE").unwrap_or_default();
            if let Some(Pane { body: Body::Editor(editor), .. }) = app.panes.get_mut(&id) {
                let started = Instant::now();
                let _ = editor.open(&note);
                report("editor_open_ms", format!("{:.1}", millis(started.elapsed())));
                report("editor_open_lines", editor.content.line_count());
                if let Some(selftest) = app.selftest.as_mut() {
                    selftest.probe = Some(Probe { since: started, frames: 0 });
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
            let Some(id) = find_pane(app, |pane| matches!(pane.body, Body::Editor(_))) else { return Task::none() };
            if let Some(selftest) = app.selftest.as_mut() {
                selftest.probe = Some(Probe { since: Instant::now(), frames: 0 });
            }
            let c = char::from(b'a' + (number % 26) as u8);
            Task::batch([
                Task::done(Message::Editor(id, EditorMessage::Action(Action::Edit(Edit::Insert(c))))),
                after(Duration::from_millis(40), Step::Type(number + 1)),
            ])
        }
        (_, Step::Finish) => finish(app),
        _ => Task::none(),
    }
}

fn finish(app: &mut App) -> Task<Message> {
    let Some(selftest) = app.selftest.as_mut() else { return iced::exit() };
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
            if let Some(index) = editor.and_then(|editor| app.vaults.get(&editor.root)).and_then(Option::as_ref) {
                report("vault_notes", index.len());
                for query in ["meeting", "zebra-unique-term", "#project", "the quick brown"] {
                    let started = Instant::now();
                    let hits = index.search(query, 300).len();
                    report(&format!("search_ms[{query}]"), format!("{:.2} ({hits} hits)", millis(started.elapsed())));
                }
            }
        }
        _ => {}
    }
    app.save();
    iced::exit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_reports_median_p99_and_max() {
        let mut times: Vec<Duration> = (1..=100).map(Duration::from_millis).collect();
        let (median, p99, max) = summary(&mut times);
        assert_eq!((median.round(), p99.round(), max.round()), (51.0, 99.0, 100.0));
        assert_eq!(summary(&mut []), (0.0, 0.0, 0.0));
    }
}
