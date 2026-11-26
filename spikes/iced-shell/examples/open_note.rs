//! Times the steps of opening a large note.
//!
//! `cargo run --release --example open_note -- <file>`

use std::time::Instant;

use iced::widget::text_editor::Content;

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: open_note <file>");
        return;
    };
    let started = Instant::now();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    println!("read: {:?}", started.elapsed());
    let started = Instant::now();
    let content: Content<iced::Renderer> = Content::with_text(&text);
    println!(
        "Content::with_text: {:?} ({} lines)",
        started.elapsed(),
        content.line_count()
    );
    let started = Instant::now();
    let _ = content.text();
    println!("Content::text: {:?}", started.elapsed());
}
