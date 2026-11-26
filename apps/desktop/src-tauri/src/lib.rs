mod agents;
mod fs;
mod graph;
mod graph_write;
mod ipc;
mod links;
mod local_files;
mod menu;
mod projects;
mod pty;
mod shell_env;
mod startup;
mod state;
mod vault_guard;
mod windows;

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use windows::{open_window, source_from_args, source_from_url, Source, WindowLayouts};

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
    // The same binary doubles as the command-line tool used inside panes.
    // That path must finish before any window or single-instance work.
    if let Some(code) = ipc::run_cli(std::env::args()) {
        std::process::exit(code);
    }

    // An automated run stays in the background from its first moment.
    let quiet = !startup::may_take_focus();
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    if quiet {
        // Without this the app puts itself in front as it finishes launching.
        builder = builder.activate_ignoring_other_apps(false);
    }

    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut app = builder
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
        .register_uri_scheme_protocol(local_files::SCHEME, |_context, request| {
            local_files::handle(&request)
        })
        .manage(pty::PtyState::default())
        .manage(agents::AgentState::default())
        .manage(WindowLayouts::default())
        .invoke_handler(tauri::generate_handler![
            projects::projects_read,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            startup::startup,
            startup::debug_snapshot,
            state::workspace_save,
            fs::fs_home,
            fs::fs_list,
            fs::fs_read_text,
            fs::fs_write_text,
            graph::graph_read,
            graph::graph_fingerprint,
            graph_write::graph_vault_root,
            graph_write::graph_types,
            graph_write::graph_create_node,
            graph_write::graph_add_relation,
            agents::agent_run,
            agents::agent_cancel,
            ipc::ipc_reply,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let label = window.label();
                window.state::<pty::PtyState>().kill_window(label);
                window.state::<agents::AgentState>().kill_window(label);
                window.state::<WindowLayouts>().forget(label);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            app.set_menu(menu::build(&handle)?)?;
            app.on_menu_event(|app, event| {
                menu::handle(app, event.id().as_ref());
            });

            ipc::start(&handle);

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
                        if !handle.webview_windows().is_empty() {
                            return;
                        }
                        // The link that started the app is not always
                        // delivered as an event. Ask for it before settling
                        // on the default window.
                        let launch_links = handle
                            .deep_link()
                            .get_current()
                            .ok()
                            .flatten()
                            .unwrap_or_default();
                        if launch_links.is_empty() {
                            open_or_log(&handle, Source::Default);
                            return;
                        }
                        for url in launch_links {
                            let source = source_from_url(&handle, url.as_str());
                            open_or_log(&handle, source);
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the desktop shell");

    #[cfg(target_os = "macos")]
    if quiet {
        // An accessory app has no Dock icon and is not made the front app
        // by launching it.
        app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = quiet;

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
        } if startup::may_take_focus() => open_or_log(app, Source::Default),
        _ => {}
    });
}
