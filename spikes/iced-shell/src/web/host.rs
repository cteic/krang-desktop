//! System web views as child views of the iced window: WKWebView on macOS,
//! WebKitGTK on Linux (X11 only), through `wry`.
//!
//! A child web view is a native view above iced's drawing surface. It is
//! moved to the bounds its pane reports each time they change, and hidden
//! when its tab is not shown or an overlay such as the command palette is
//! open, since nothing iced draws can appear above it.

use std::collections::HashMap;

use iced::Rectangle;
use raw_window_handle::{DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle, WindowHandle};
use tokio::sync::mpsc::UnboundedSender;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder};

use super::local;

#[derive(Debug, Clone)]
pub enum WebEvent {
    Loading { pane: u64, url: String },
    Loaded { pane: u64, url: String },
    Title { pane: u64, title: String },
    /// The person clicked into the page.
    Focused(u64),
    /// A Cmd (or Super) shortcut pressed while the page had the keyboard.
    Shortcut { pane: u64, key: String, shift: bool, alt: bool },
}

/// The iced window's native handles, taken once after it opens.
#[derive(Clone, Copy)]
pub struct ParentWindow {
    window: RawWindowHandle,
    display: RawDisplayHandle,
}

// SAFETY: the handles are plain pointers to the main window. They are only
// used from `update`, which iced runs on the main thread, and the window
// lives for as long as the app.
unsafe impl Send for ParentWindow {}

impl ParentWindow {
    pub fn from_window(window: &dyn iced::window::Window) -> Option<Self> {
        Some(Self {
            window: window.window_handle().ok()?.as_raw(),
            display: window.display_handle().ok()?.as_raw(),
        })
    }
}

impl HasWindowHandle for ParentWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        // SAFETY: the window outlives every web view built on it (see above).
        Ok(unsafe { WindowHandle::borrow_raw(self.window) })
    }
}

impl HasDisplayHandle for ParentWindow {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: as for the window handle.
        Ok(unsafe { DisplayHandle::borrow_raw(self.display) })
    }
}

/// Reports clicks and Cmd shortcuts to the app. Copy, paste, cut, select
/// all and undo stay with the page.
const BRIDGE: &str = r#"(() => {
  const post = (message) => { try { window.ipc.postMessage(JSON.stringify(message)); } catch (_) {} };
  window.addEventListener('mousedown', () => post({ focus: true }), true);
  window.addEventListener('keydown', (event) => {
    if (!event.metaKey) return;
    if (['c', 'v', 'x', 'a', 'z'].includes(event.key.toLowerCase())) return;
    event.preventDefault();
    post({ key: event.key, shift: event.shiftKey, alt: event.altKey });
  }, true);
})();"#;

fn rect(bounds: Rectangle) -> Rect {
    Rect {
        position: LogicalPosition::new(f64::from(bounds.x), f64::from(bounds.y)).into(),
        size: LogicalSize::new(f64::from(bounds.width.max(1.0)), f64::from(bounds.height.max(1.0))).into(),
    }
}

fn bridge_event(pane: u64, body: &str) -> Option<WebEvent> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if value.get("focus").is_some() {
        return Some(WebEvent::Focused(pane));
    }
    Some(WebEvent::Shortcut {
        pane,
        key: value.get("key")?.as_str()?.to_string(),
        shift: value.get("shift").and_then(serde_json::Value::as_bool).unwrap_or(false),
        alt: value.get("alt").and_then(serde_json::Value::as_bool).unwrap_or(false),
    })
}

struct View {
    webview: WebView,
    bounds: Option<Rectangle>,
    visible: bool,
}

pub struct WebHost {
    parent: Option<ParentWindow>,
    views: HashMap<u64, View>,
    sender: UnboundedSender<WebEvent>,
}

impl WebHost {
    pub fn new(sender: UnboundedSender<WebEvent>) -> Self {
        Self { parent: None, views: HashMap::new(), sender }
    }

    pub fn set_parent(&mut self, parent: ParentWindow) {
        #[cfg(target_os = "linux")]
        if gtk::init().is_err() {
            return;
        }
        self.parent = Some(parent);
    }

    pub fn is_ready(&self) -> bool {
        self.parent.is_some()
    }

    pub fn has(&self, pane: u64) -> bool {
        self.views.contains_key(&pane)
    }

    pub fn is_empty(&self) -> bool {
        self.views.is_empty()
    }

    /// Builds the web view for a pane, hidden until its bounds are known.
    pub fn create(&mut self, pane: u64, url: &str) -> Result<(), String> {
        let parent = self.parent.ok_or("the window is not ready")?;
        let (load, title, ipc) = (self.sender.clone(), self.sender.clone(), self.sender.clone());
        let builder = WebViewBuilder::new()
            .with_visible(false)
            .with_bounds(rect(Rectangle::new(iced::Point::ORIGIN, iced::Size::new(1.0, 1.0))))
            .with_initialization_script(BRIDGE)
            .with_custom_protocol(local::SCHEME.into(), |_, request| local::serve(&request))
            .with_on_page_load_handler(move |event, url| {
                let event = match event {
                    PageLoadEvent::Started => WebEvent::Loading { pane, url },
                    PageLoadEvent::Finished => WebEvent::Loaded { pane, url },
                };
                let _ = load.send(event);
            })
            .with_document_title_changed_handler(move |text| {
                let _ = title.send(WebEvent::Title { pane, title: text });
            })
            .with_ipc_handler(move |request| {
                if let Some(event) = bridge_event(pane, request.body()) {
                    let _ = ipc.send(event);
                }
            });
        let builder = if url.is_empty() { builder.with_html("<!doctype html><title>New page</title>") } else { builder.with_url(url) };
        let webview = builder.build_as_child(&parent).map_err(|error| error.to_string())?;
        self.views.insert(pane, View { webview, bounds: None, visible: false });
        Ok(())
    }

    pub fn close(&mut self, pane: u64) {
        self.views.remove(&pane);
    }

    pub fn set_bounds(&mut self, pane: u64, bounds: Rectangle) {
        if let Some(view) = self.views.get_mut(&pane)
            && view.bounds != Some(bounds)
        {
            view.bounds = Some(bounds);
            let _ = view.webview.set_bounds(rect(bounds));
        }
    }

    /// Shows exactly the panes in `shown` that have known bounds.
    pub fn show_only(&mut self, shown: &dyn Fn(u64) -> bool) {
        for (pane, view) in &mut self.views {
            let visible = shown(*pane) && view.bounds.is_some();
            if view.visible != visible {
                view.visible = visible;
                let _ = view.webview.set_visible(visible);
            }
        }
    }

    pub fn load(&self, pane: u64, url: &str) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.load_url(url);
        }
    }

    pub fn back(&self, pane: u64) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.go_back();
        }
    }

    pub fn forward(&self, pane: u64) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.go_forward();
        }
    }

    pub fn reload(&self, pane: u64) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.reload();
        }
    }

    pub fn history(&self, pane: u64) -> (bool, bool) {
        self.views.get(&pane).map_or((false, false), |view| {
            (view.webview.can_go_back().unwrap_or(false), view.webview.can_go_forward().unwrap_or(false))
        })
    }

    pub fn focus(&self, pane: u64) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.focus();
        }
    }

    /// Gives the keyboard back to the iced view.
    pub fn blur(&self, pane: u64) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.focus_parent();
        }
    }

    pub fn run_script(&self, pane: u64, script: &str) {
        if let Some(view) = self.views.get(&pane) {
            let _ = view.webview.evaluate_script(script);
        }
    }
}

/// WebKitGTK needs the GTK main loop, which winit does not run. This hands
/// it the events that are waiting. macOS needs nothing: WKWebView runs on
/// the run loop winit already drives.
#[cfg(target_os = "linux")]
pub fn pump() {
    while gtk::events_pending() {
        gtk::main_iteration_do(false);
    }
}

#[cfg(not(target_os = "linux"))]
pub fn pump() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bridge_messages() {
        assert!(matches!(bridge_event(3, r#"{"focus":true}"#), Some(WebEvent::Focused(3))));
        assert!(matches!(
            bridge_event(3, r#"{"key":"d","shift":true,"alt":false}"#),
            Some(WebEvent::Shortcut { pane: 3, ref key, shift: true, alt: false }) if key == "d"
        ));
        assert!(bridge_event(3, "junk").is_none());
    }
}
