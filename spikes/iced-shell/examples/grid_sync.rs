//! What a redraw costs under heavy output: a full grid clone, as `iced_term`
//! 0.8 does on every sync, against the visible-rows snapshot this app takes.
//!
//! `cargo run --release --example grid_sync`

use std::time::{Duration, Instant};

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use krang_shell::term::snapshot::Snapshot;

fn time(rounds: u32, mut f: impl FnMut()) -> Duration {
    let start = Instant::now();
    for _ in 0..rounds {
        f();
    }
    start.elapsed() / rounds
}

fn main() {
    let (columns, lines) = (200, 50);
    let config = Config { scrolling_history: 10_000, ..Config::default() };
    let mut term = Term::new(config, &TermSize::new(columns, lines), VoidListener);
    let mut parser: Processor = Processor::new();
    let mut output = Vec::new();
    for line in 0..20_000 {
        output.extend_from_slice(format!("\x1b[3{}m{line:>8} {}\x1b[0m\r\n", line % 8, "x".repeat(150)).as_bytes());
    }
    parser.advance(&mut term, &output);

    let rounds = 200;
    let clone = time(rounds, || {
        std::hint::black_box(term.grid().clone());
    });
    let snapshot = time(rounds, || {
        std::hint::black_box(Snapshot::take(&term));
    });
    println!("terminal {columns}x{lines}, 10000 lines of scrollback, full");
    println!("full grid clone (iced_term 0.8 sync): {:>9.3} ms", clone.as_secs_f64() * 1e3);
    println!("visible-rows snapshot (this app):     {:>9.3} ms", snapshot.as_secs_f64() * 1e3);
}
