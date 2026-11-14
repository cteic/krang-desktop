mod links;
mod pty;
mod startup;
mod windows;

use std::thread;
use std::time::Duration;

use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use windows::{open_window, source_from_args, source_from_url, Source, WindowLayouts};

const NEW_WINDOW_MENU_ID: &str = "new-window";
/// How long a launch waits for a link before it opens the default window.
/// The link that started the app arrives just after launch, not with it.
const LAUNCH_LINK_GRACE: Duration = Duration::from_millis(400);

/// Opens a window from its own thread. Link and menu handlers run inside the
/// event loop, and building a window there waits on that same loop forever.
fn open_or_log(app: &AppHandle, source: Source) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(error) = open_window(&app, source) {
            eprintln!("could not open a window: {error}");
        }
    });
}

fn is_link(arg: &str) -> bool {
    arg.contains("://")
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch lands here, in the first instance. A link in
            // its arguments is handled by the link handler below.
            if argv.iter().any(|arg| is_link(arg)) {
                return;
            }
            let source = source_from_args(argv.into_iter().skip(1), false);
            open_or_log(app, source.unwrap_or(Source::Default));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(pty::PtyState::default())
        .manage(WindowLayouts::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            startup::startup,
            startup::debug_snapshot,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let label = window.label();
                window.state::<pty::PtyState>().kill_window(label);
                window.state::<WindowLayouts>().forget(label);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            let menu = Menu::default(&handle)?;
            let new_window = MenuItemBuilder::with_id(NEW_WINDOW_MENU_ID, "New Window")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let shell_menu = SubmenuBuilder::new(app, "Shell")
                .item(&new_window)
                .build()?;
            menu.insert(&shell_menu, 1)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == NEW_WINDOW_MENU_ID {
                    open_or_log(app, Source::Default);
                }
            });

            let link_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let source = source_from_url(&link_handle, url.as_str());
                    open_or_log(&link_handle, source);
                }
            });

            match source_from_args(std::env::args().skip(1), true) {
                Some(source) => open_or_log(&handle, source),
                None => {
                    thread::spawn(move || {
                        thread::sleep(LAUNCH_LINK_GRACE);
                        if handle.webview_windows().is_empty() {
                            open_or_log(&handle, Source::Default);
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the desktop shell");

    app.run(|app, event| match event {
        // Closing the last window leaves the app running, as Mac apps do.
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => open_or_log(app, Source::Default),
        _ => {}
    });
}
