//! `kd`: a program in a terminal pane drives the app.
//!
//! `kd` is this binary under another name. It sends one request to the
//! running app over a Unix socket and prints the answer. The app puts the
//! socket's path, the pane's id and a secret made for that pane in the
//! pane's environment, and answers only a request that carries the secret.

pub mod cli;
pub mod client;
pub mod mcp;
pub mod protocol;
pub mod server;
pub mod shell_env;
