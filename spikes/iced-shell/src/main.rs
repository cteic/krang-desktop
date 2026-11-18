use std::path::PathBuf;

use krang_shell::app::{self, Options, selftest};

const USAGE: &str = "usage: krang-shell [--layout <file>]... [--fresh]";

fn main() -> iced::Result {
    selftest::mark_process_start();
    let mut options = Options { selftest: selftest::Plan::from_env(), ..Options::default() };
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
