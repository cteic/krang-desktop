use std::path::PathBuf;

use krang_shell::app::{self, Options, selftest};

const USAGE: &str = "usage: krang-shell [--layout <file>]... [--fresh]";

fn main() -> iced::Result {
    // Started under the name `kd`, this program is the pane tool: it sends
    // one request to the running app and exits.
    let mut started_as = std::env::args();
    if krang_shell::kd::cli::invoked_as_kd(started_as.next().as_deref()) {
        let args: Vec<String> = started_as.collect();
        std::process::exit(krang_shell::kd::cli::run(&args));
    }
    // With this flag, the program is the Local chat agent for one turn.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some(krang_shell::chat::local::HELPER_FLAG) {
        std::process::exit(krang_shell::chat::local::run_helper(&args[1..]));
    }
    selftest::mark_process_start();
    let mut options = Options {
        selftest: selftest::Plan::from_env(),
        ..Options::default()
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--layout" => match args.next() {
                Some(path) => options.layouts.push(PathBuf::from(path)),
                None => {
                    eprintln!("{USAGE}");
                    std::process::exit(2);
                }
            },
            "--fresh" => options.fresh = true,
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => match other.strip_prefix("--layout=") {
                Some(path) => options.layouts.push(PathBuf::from(path)),
                None => {
                    eprintln!("krang-shell: unknown argument {other}\n{USAGE}");
                    std::process::exit(2);
                }
            },
        }
    }
    app::run(options)
}
