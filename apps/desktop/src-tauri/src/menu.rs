use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::windows::{open_window, Source};

const NEW_WINDOW: &str = "new-window";
const CLOSE_WINDOW: &str = "close-window";
const MENU_EVENT: &str = "menu-action";

/// Items the focused window acts on: id, label, shortcut. The ids are the
/// contract with the page, which decides what each one does.
const WINDOW_ACTIONS: [(&str, &str, &str); 10] = [
    ("new-tab", "New Tab", "CmdOrCtrl+T"),
    ("split-right", "Split Right", "CmdOrCtrl+D"),
    ("split-down", "Split Down", "CmdOrCtrl+Shift+D"),
    ("magnify-pane", "Magnify Pane", "CmdOrCtrl+Shift+Enter"),
    ("next-pane", "Next Pane", "CmdOrCtrl+]"),
    ("previous-pane", "Previous Pane", "CmdOrCtrl+["),
    ("next-tab", "Next Tab", "CmdOrCtrl+Shift+]"),
    ("previous-tab", "Previous Tab", "CmdOrCtrl+Shift+["),
    ("close-pane", "Close Pane", "CmdOrCtrl+W"),
    ("close-tab", "Close Tab", "CmdOrCtrl+Shift+W"),
];

pub fn is_window_action(id: &str) -> bool {
    WINDOW_ACTIONS.iter().any(|(action, _, _)| *action == id)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let mut shell = SubmenuBuilder::new(app, "Shell").item(
        &MenuItemBuilder::with_id(NEW_WINDOW, "New Window")
            .accelerator("CmdOrCtrl+N")
            .build(app)?,
    );
    for (index, (id, label, shortcut)) in WINDOW_ACTIONS.iter().enumerate() {
        // Visual groups: tabs and splits, movement, closing.
        if index == 0 || index == 4 || index == 8 {
            shell = shell.separator();
        }
        shell = shell.item(
            &MenuItemBuilder::with_id(*id, *label)
                .accelerator(*shortcut)
                .build(app)?,
        );
    }
    let shell_menu = shell.build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(
            &MenuItemBuilder::with_id(CLOSE_WINDOW, "Close Window")
                .accelerator("CmdOrCtrl+Alt+W")
                .build(app)?,
        )
        .build()?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &shell_menu, &window_menu])
}

fn focused_label(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

pub fn handle(app: &AppHandle, id: &str) {
    if id == NEW_WINDOW {
        let app = app.clone();
        // Building a window inside a menu handler waits on the event loop
        // that is running the handler. A thread of its own avoids that.
        std::thread::spawn(move || {
            if let Err(error) = open_window(&app, Source::Default) {
                eprintln!("could not open a window: {error}");
            }
        });
        return;
    }
    let Some(label) = focused_label(app) else {
        return;
    };
    if id == CLOSE_WINDOW {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
        return;
    }
    if is_window_action(id) {
        let _ = app.emit_to(label, MENU_EVENT, id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_actions_are_recognised_and_app_actions_are_not() {
        assert!(is_window_action("split-right"));
        assert!(is_window_action("close-pane"));
        assert!(!is_window_action(NEW_WINDOW));
        assert!(!is_window_action("format-disk"));
    }

    #[test]
    fn every_shortcut_is_used_once() {
        let mut shortcuts: Vec<&str> = WINDOW_ACTIONS.iter().map(|(_, _, s)| *s).collect();
        shortcuts.push("CmdOrCtrl+N");
        shortcuts.push("CmdOrCtrl+Alt+W");
        let count = shortcuts.len();
        shortcuts.sort_unstable();
        shortcuts.dedup();
        assert_eq!(shortcuts.len(), count);
    }
}
