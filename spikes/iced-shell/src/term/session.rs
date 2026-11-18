//! One shell on a pseudo-terminal, parsed by `alacritty_terminal`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use alacritty_terminal::event::{Notify, OnResize, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, Msg, Notifier};
use alacritty_terminal::grid::Scroll;
use alacritty_terminal::index::Side;
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;

use super::events::{EventProxy, Sender};
use super::palette::Scheme;
use super::snapshot::{Snapshot, grid_point};

/// Lines of history kept per terminal. This bounds a terminal's memory
/// however much a program prints.
pub const SCROLLBACK_LINES: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridSize {
    pub columns: u16,
    pub lines: u16,
    pub cell_width: u16,
    pub cell_height: u16,
}

impl GridSize {
    fn window_size(self) -> WindowSize {
        WindowSize {
            num_lines: self.lines,
            num_cols: self.columns,
            cell_width: self.cell_width,
            cell_height: self.cell_height,
        }
    }
}

pub struct Spawn<'a> {
    pub id: u64,
    pub directory: Option<&'a Path>,
    pub size: GridSize,
    pub scheme: Scheme,
    /// More for the shell's environment, over what every terminal gets.
    pub env: Vec<(String, String)>,
}

pub struct Session {
    term: Arc<FairMutex<Term<EventProxy>>>,
    proxy: EventProxy,
    notifier: Notifier,
    pid: u32,
    size: GridSize,
    snapshot: Snapshot,
    scheme: Scheme,
    /// Output arrived while the terminal was not on screen.
    stale: bool,
}

fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| {
            String::from(if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else {
                "/bin/sh"
            })
        })
}

impl Session {
    pub fn spawn(spawn: Spawn<'_>, sender: Sender) -> std::io::Result<Self> {
        // A login shell, so an app opened from the Dock still gets the PATH
        // the person's profile sets up.
        let (program, args) = (login_shell(), vec![String::from("-l")]);
        let mut env = HashMap::from([
            (String::from("TERM"), String::from("xterm-256color")),
            (String::from("COLORTERM"), String::from("truecolor")),
            (String::from("TERM_PROGRAM"), String::from("krang-shell")),
        ]);
        env.extend(spawn.env);
        let options = tty::Options {
            shell: Some(tty::Shell::new(program, args)),
            working_directory: spawn.directory.map(Path::to_path_buf),
            drain_on_exit: false,
            env,
        };
        let pty = tty::new(&options, spawn.size.window_size(), spawn.id)?;
        let pid = pty.child().id();
        let proxy = EventProxy::new(spawn.id, sender);
        let config = Config {
            scrolling_history: SCROLLBACK_LINES,
            ..Config::default()
        };
        let dimensions = TermSize::new(
            usize::from(spawn.size.columns),
            usize::from(spawn.size.lines),
        );
        let term = Arc::new(FairMutex::new(Term::new(
            config,
            &dimensions,
            proxy.clone(),
        )));
        let event_loop = EventLoop::new(Arc::clone(&term), proxy.clone(), pty, false, false)?;
        let notifier = Notifier(event_loop.channel());
        // The loop thread owns the pty. It ends on `Msg::Shutdown`, and
        // dropping the pty hangs up the shell and reaps it.
        let _ = event_loop.spawn();
        let snapshot = Snapshot::take(&term.lock(), &spawn.scheme);
        Ok(Self {
            term,
            proxy,
            notifier,
            pid,
            size: spawn.size,
            snapshot,
            scheme: spawn.scheme,
            stale: false,
        })
    }

    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }

    pub fn mode(&self) -> TermMode {
        self.snapshot.mode
    }

    pub fn size(&self) -> GridSize {
        self.size
    }

    /// Takes a redraw request from the reader thread. A terminal on screen
    /// copies its screen now; one in a hidden tab only notes that it must.
    pub fn wakeup(&mut self, visible: bool) {
        self.proxy.wakeup_taken();
        if visible {
            self.refresh();
        } else {
            self.stale = true;
        }
    }

    /// Brings the copy up to date for a terminal that has come on screen.
    pub fn show(&mut self) {
        if self.stale {
            self.refresh();
        }
    }

    /// Redraws in other colours, when the app goes light or dark.
    pub fn set_scheme(&mut self, scheme: Scheme) {
        if self.scheme != scheme {
            self.scheme = scheme;
            self.refresh();
        }
    }

    fn refresh(&mut self) {
        let term = self.term.lock();
        self.snapshot = Snapshot::take(&term, &self.scheme);
        self.stale = false;
    }

    pub fn write(&self, bytes: impl Into<std::borrow::Cow<'static, [u8]>>) {
        self.notifier.notify(bytes);
    }

    /// Typed input scrolls back to the bottom, as in every terminal.
    pub fn type_bytes(&mut self, bytes: Vec<u8>) {
        {
            let mut term = self.term.lock();
            if term.grid().display_offset() != 0 {
                term.scroll_display(Scroll::Bottom);
            }
            term.selection = None;
        }
        self.write(bytes);
        self.refresh();
    }

    pub fn resize(&mut self, size: GridSize) {
        if size == self.size || size.columns == 0 || size.lines == 0 {
            return;
        }
        self.size = size;
        self.notifier.on_resize(size.window_size());
        self.term.lock().resize(TermSize::new(
            usize::from(size.columns),
            usize::from(size.lines),
        ));
        self.refresh();
    }

    /// Scrolls the history by whole lines; positive is up.
    pub fn scroll(&mut self, lines: i32) {
        self.term.lock().scroll_display(Scroll::Delta(lines));
        self.refresh();
    }

    pub fn select(&mut self, kind: SelectionType, line: usize, column: usize, right_half: bool) {
        let side = if right_half { Side::Right } else { Side::Left };
        {
            let mut term = self.term.lock();
            let point = grid_point(term.grid().display_offset(), line, column);
            term.selection = Some(Selection::new(kind, point, side));
        }
        self.refresh();
    }

    pub fn extend_selection(&mut self, line: usize, column: usize, right_half: bool) {
        let side = if right_half { Side::Right } else { Side::Left };
        {
            let mut term = self.term.lock();
            let point = grid_point(term.grid().display_offset(), line, column);
            if let Some(selection) = term.selection.as_mut() {
                selection.update(point, side);
            }
        }
        self.refresh();
    }

    pub fn clear_selection(&mut self) {
        self.term.lock().selection = None;
        self.refresh();
    }

    pub fn selection_text(&self) -> Option<String> {
        self.term
            .lock()
            .selection_to_string()
            .filter(|text| !text.is_empty())
    }

    /// The shell's working directory, read from the operating system, so it
    /// is right whatever the shell's prompt does.
    pub fn working_directory(&self) -> Option<PathBuf> {
        process_cwd(self.pid)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.notifier.0.send(Msg::Shutdown);
    }
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::raw::c_int;

    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as c_int;
    // SAFETY: `info` is a buffer of exactly `size` bytes, which the call
    // fills; the result says how many bytes it wrote.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: the call succeeded and wrote the whole struct.
    let info = unsafe { info.assume_init() };
    // SAFETY: the kernel writes a NUL-terminated path into the buffer.
    let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    Some(PathBuf::from(path.to_string_lossy().into_owned()))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}
