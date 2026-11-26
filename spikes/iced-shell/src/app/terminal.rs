//! The terminal pane: a session plus what the pane shows around it.

use std::path::PathBuf;

use iced::widget::{button, center, column, text};
use iced::{Element, Length};

use crate::term::events::Sender;
use crate::term::session::{GridSize, Session, Spawn};
use crate::term::view::TerminalView;

use super::Message;

pub const FONT_SIZE: f32 = 13.0;

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
    ) -> Self {
        let directory = directory.filter(|dir| dir.is_dir());
        let spawned = Session::spawn(
            Spawn {
                id,
                directory: directory.as_deref(),
                size,
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

    pub fn view(&self, id: u64, focused: bool) -> Element<'_, Message> {
        match &self.session {
            Some(session) => TerminalView::new(
                session.snapshot(),
                session.size(),
                focused,
                FONT_SIZE,
                move |input| Message::Terminal(id, input),
            )
            .into(),
            None => center(
                column![
                    text(
                        self.error
                            .clone()
                            .unwrap_or_else(|| String::from("The shell has exited."))
                    ),
                    button("Start a new shell").on_press(Message::RestartTerminal(id)),
                ]
                .spacing(12),
            )
            .width(Length::Fill)
            .height(Length::Fill)
            .into(),
        }
    }
}
