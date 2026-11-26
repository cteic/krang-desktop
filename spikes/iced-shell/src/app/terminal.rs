//! The terminal pane: a session plus what the pane shows around it.

use std::path::PathBuf;

use iced::widget::{button, center, column, container, text};
use iced::{Element, Length, Padding};

use crate::style::{self, Mode};
use crate::term::events::Sender;
use crate::term::palette::Scheme;
use crate::term::session::{GridSize, Session, Spawn};
use crate::term::view::TerminalView;

use super::Message;

pub const FONT_SIZE: f32 = style::size::MONO;

pub struct TerminalPane {
    pub session: Option<Session>,
    pub error: Option<String>,
    pub title: Option<String>,
    pub start_directory: Option<PathBuf>,
}

impl TerminalPane {
    pub fn start(
        id: u64,
        directory: Option<PathBuf>,
        size: GridSize,
        sender: &Sender,
        commands: &[String],
        mode: Mode,
        env: Vec<(String, String)>,
    ) -> Self {
        let directory = directory.filter(|dir| dir.is_dir());
        let spawned = Session::spawn(
            Spawn {
                id,
                directory: directory.as_deref(),
                size,
                scheme: Scheme::of(mode),
                env,
            },
            sender.clone(),
        );
        let (session, error) = match spawned {
            Ok(session) => {
                for command in commands {
                    session.write(format!("{command}\r").into_bytes());
                }
                (Some(session), None)
            }
            Err(error) => (None, Some(format!("Could not start the shell: {error}"))),
        };
        Self {
            session,
            error,
            title: None,
            start_directory: directory,
        }
    }

    pub fn working_directory(&self) -> Option<PathBuf> {
        self.session
            .as_ref()
            .and_then(Session::working_directory)
            .or_else(|| self.start_directory.clone())
    }

    /// What the shell is called: `zsh` for `/bin/zsh`.
    pub fn shell_name() -> String {
        std::env::var("SHELL")
            .ok()
            .and_then(|shell| shell.rsplit('/').next().map(str::to_string))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| String::from("shell"))
    }

    pub fn view(&self, id: u64, focused: bool, mode: Mode) -> Element<'_, Message> {
        let colors = &mode.tokens().terminal;
        match &self.session {
            Some(session) => container(TerminalView::new(
                session.snapshot(),
                session.size(),
                focused,
                FONT_SIZE,
                if focused {
                    colors.background
                } else {
                    colors.background_idle
                },
                move |input| Message::Terminal(id, input),
            ))
            .padding(Padding::from([style::space::L, style::space::XL]))
            .into(),
            None => center(
                column![
                    text(
                        self.error
                            .clone()
                            .unwrap_or_else(|| String::from("The shell has exited."))
                    )
                    .size(style::size::BODY)
                    .style(style::muted),
                    button(text("Start a new shell").size(style::size::BODY))
                        .padding(Padding::from([style::space::M, style::space::XL]))
                        .style(style::secondary)
                        .on_press(Message::RestartTerminal(id)),
                ]
                .spacing(style::space::XL)
                .align_x(iced::Alignment::Center),
            )
            .width(Length::Fill)
            .height(Length::Fill)
            .into(),
        }
    }
}
