use tauri::AppHandle;

/// Starts whatever lets a program inside a pane talk to the app.
/// Not built yet: this is the seam.
pub fn start(_app: &AppHandle) {}

/// Extra environment for a pane's shell, such as where to reach the app.
pub fn pane_env() -> Vec<(String, String)> {
    Vec::new()
}

/// Runs the command-line side when the binary was started as that tool
/// rather than as the app. Returns the exit code, or `None` to start the app.
pub fn run_cli<I>(_args: I) -> Option<i32>
where
    I: IntoIterator<Item = String>,
{
    None
}
