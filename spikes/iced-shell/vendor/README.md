# Vendored crates

Two iced crates are copied from crates.io and patched through
`[patch.crates-io]` in `Cargo.toml`. Each change is one marked block. Remove
a crate and its patch entry once iced offers the same thing.

## iced_winit 0.14.1 (MIT): quiet launch on macOS

In `src/lib.rs`, in `run`, where the event loop is built:

```rust
#[cfg(target_os = "macos")]
if std::env::var_os("KRANG_QUIET").is_some_and(|value| value == "1") {
    use winit::platform::macos::EventLoopBuilderExtMacOS;

    let _ = builder.with_activate_ignoring_other_apps(false);
}
```

winit calls `activateIgnoringOtherApps(true)` when the app finishes
launching, and iced builds the event loop with no way to change that. With
`false`, macOS activates the app only if no other app is active, so a window
opened from a terminal leaves the keyboard where it was. This is the
smallest change that does it: iced exposes no hook for the event loop
builder, and winit offers the setting only on the builder. Not tested on a
Mac yet.

## iced_graphics 0.14.0 (MIT): open a large note without shaping it all

In `src/text/editor.rs`, in `Editor::with_text`:

```rust
buffer.set_size(font_system.raw(), None, Some(0.0));
```

iced builds the editor's text buffer with no height, so cosmic-text shapes
every line of a new text before the first frame: 2.67 s for a 50,000-line
note on the test machine. With a height of zero only the first line is
shaped, and the widget sets the real size before it draws, so only the lines
on screen are shaped: 19.6 ms (`cargo run --release --example open_note`).
