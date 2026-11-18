# Vendored crates

## iced_winit 0.14.1 (MIT)

Copied from crates.io without changes except one block in `src/lib.rs`, in
`run`, where the event loop is built:

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
builder, and winit offers the setting only on the builder.

Remove this crate and the `[patch.crates-io]` entry once iced lets an app
configure the macOS event loop.
