//! The chat pane: a transcript over a command-line agent.

use std::path::PathBuf;

use iced::widget::{button, column, container, markdown, row, scrollable, text, text_editor};
use iced::{Element, Font, Length, Theme};

use crate::chat::event::Usage;
use crate::chat::runner::{self, RunEvent, RunOutput};
use crate::chat::transcript::{Item, Status, Transcript};
use crate::chat::{Agent, Mode, RunRequest};
use crate::shell::layout::expand_home;

use super::Message;

#[derive(Debug, Clone)]
pub enum ChatMessage {
    Draft(text_editor::Action),
    Send,
    Stop,
    ToggleMode,
    Trust,
    Link(String),
}

struct Run {
    id: u64,
    group: i32,
}

pub struct ChatPane {
    pub agent: Agent,
    pub directory: Option<String>,
    pub mode: Mode,
    pub trusted: bool,
    pub transcript: Transcript,
    pub draft: text_editor::Content,
    run: Option<Run>,
    /// Parsed Markdown for each transcript item that is a message, kept in
    /// step with the transcript so a frame never parses anything.
    rendered: Vec<Option<(usize, markdown::Content)>>,
}

pub fn usage_line(usage: &Usage) -> String {
    let mut parts = Vec::new();
    if let Some(cost) = usage.cost_usd {
        parts.push(format!("${cost:.4}"));
    }
    if let Some(input) = usage.input_tokens {
        parts.push(format!("{input} in"));
    }
    if let Some(output) = usage.output_tokens {
        parts.push(format!("{output} out"));
    }
    parts.join(" · ")
}

impl ChatPane {
    pub fn new(agent: Agent, directory: Option<String>, mode: Mode, trusted: bool, transcript: Transcript) -> Self {
        let mut pane = Self {
            agent,
            directory,
            mode,
            trusted,
            transcript: transcript.restored(),
            draft: text_editor::Content::new(),
            run: None,
            rendered: Vec::new(),
        };
        pane.refresh();
        pane
    }

    pub fn input_id(id: u64) -> iced::widget::Id {
        iced::widget::Id::from(format!("chat-input-{id}"))
    }

    pub fn transcript_id(id: u64) -> iced::widget::Id {
        iced::widget::Id::from(format!("chat-transcript-{id}"))
    }

    pub fn is_running(&self) -> bool {
        self.run.is_some()
    }

    fn refresh(&mut self) {
        self.rendered.resize_with(self.transcript.items.len(), || None);
        for (item, slot) in self.transcript.items.iter().zip(&mut self.rendered) {
            let Item::Assistant { text, .. } = item else {
                *slot = None;
                continue;
            };
            if slot.as_ref().is_none_or(|(length, _)| *length != text.len()) {
                *slot = Some((text.len(), markdown::Content::parse(text)));
            }
        }
    }

    pub fn send(&mut self, pane: u64, run: u64, sender: &tokio::sync::mpsc::UnboundedSender<RunEvent>) {
        let prompt = self.draft.text().trim().to_string();
        if prompt.is_empty() || self.run.is_some() {
            return;
        }
        self.draft = text_editor::Content::new();
        self.transcript.send(prompt.clone());
        let request = RunRequest { mode: self.mode, directory: self.directory.clone(), session_id: self.transcript.session_id.clone(), trusted: self.trusted };
        let directory: Option<PathBuf> = self.directory.as_deref().map(expand_home);
        match runner::start(self.agent, self.agent.args(&request), directory.as_deref(), prompt, pane, run, sender.clone()) {
            Ok(started) => self.run = Some(Run { id: run, group: started.group }),
            Err(error) => self.transcript.start_failed(error),
        }
        self.refresh();
    }

    pub fn stop(&mut self) {
        if let Some(run) = self.run.take() {
            runner::stop_group(run.group);
            self.transcript.stop();
            self.refresh();
        }
    }

    /// Takes output from a run. Output from a run that was stopped is dropped.
    /// Returns true when the run ended.
    pub fn receive(&mut self, event: RunEvent) -> bool {
        if self.run.as_ref().is_none_or(|run| run.id != event.run) {
            return false;
        }
        let ended = match event.output {
            RunOutput::Line(line) => {
                for agent_event in self.agent.parse_line(&line) {
                    self.transcript.apply(agent_event);
                }
                false
            }
            RunOutput::Exit { code, stderr } => {
                self.transcript.exit(code, &stderr);
                self.run = None;
                true
            }
        };
        self.refresh();
        ended
    }

    pub fn view(&self, id: u64) -> Element<'_, Message> {
        let message = move |message: ChatMessage| Message::Chat(id, message);
        let theme = Theme::TokyoNight;
        let settings = markdown::Settings::with_text_size(14, markdown::Style::from_palette(theme.palette()));

        let mut items = column![].spacing(10).padding([10, 14]);
        for (index, item) in self.transcript.items.iter().enumerate() {
            let element: Element<'_, Message> = match item {
                Item::User { text: said } => container(text(said.clone()).size(14))
                    .padding([6, 10])
                    .style(container::rounded_box)
                    .width(Length::Fill)
                    .into(),
                Item::Assistant { stopped, .. } => {
                    let body: Element<'_, Message> = match self.rendered.get(index).and_then(Option::as_ref) {
                        Some((_, content)) => markdown::view(content.items(), settings).map(move |url| message(ChatMessage::Link(url))),
                        None => text("").into(),
                    };
                    if *stopped {
                        column![body, text("Stopped").size(12).style(text::secondary)].spacing(4).into()
                    } else {
                        body
                    }
                }
                Item::Tool { name, summary, .. } => text(format!("▸ {name} {summary}")).size(12).font(Font::MONOSPACE).style(text::secondary).into(),
                Item::Note { text: note } => text(note.clone()).size(12).style(text::secondary).into(),
                Item::Error { text: error } => container(text(error.clone()).size(13).style(text::danger)).padding([6, 10]).style(container::bordered_box).width(Length::Fill).into(),
                Item::Usage { usage } => text(usage_line(usage)).size(11).style(text::secondary).into(),
            };
            items = items.push(element);
        }

        let status = match (self.transcript.status, self.run.is_some()) {
            (_, true) => "Running",
            (Status::Error, _) => "Failed",
            _ => "Ready",
        };
        let total = usage_line(&self.transcript.total);
        let header = row![
            text(self.agent.label()).size(13),
            text(self.directory.clone().unwrap_or_else(|| String::from("~"))).size(12).style(text::secondary),
            iced::widget::space::horizontal(),
            text(total).size(12).style(text::secondary),
            text(status).size(12).style(if status == "Failed" { text::danger } else { text::secondary }),
            button(text(match self.mode { Mode::ReadOnly => "Read only", Mode::Edit => "Edit files" }).size(12))
                .padding([2, 8])
                .style(button::secondary)
                .on_press_maybe((!self.is_running()).then(|| message(ChatMessage::ToggleMode))),
        ]
        .spacing(10)
        .align_y(iced::Alignment::Center)
        .padding([4, 10]);

        let trust: Element<'_, Message> = if self.agent == Agent::Claude && !self.trusted {
            row![
                text("Trust this folder? Until you do, its own agent settings, hooks and skills do not load.").size(12),
                button(text("Trust").size(12)).padding([2, 10]).on_press(message(ChatMessage::Trust)),
            ]
            .spacing(10)
            .align_y(iced::Alignment::Center)
            .padding([2, 10])
            .into()
        } else {
            column![].into()
        };

        let action = if self.is_running() {
            button(text("Stop").size(13)).style(button::danger).on_press(message(ChatMessage::Stop))
        } else {
            button(text("Send").size(13)).on_press(message(ChatMessage::Send))
        };
        let input = text_editor(&self.draft)
            .id(Self::input_id(id))
            .placeholder("Message the agent. Enter sends, Shift+Enter adds a line.")
            .size(14)
            .height(Length::Shrink)
            .max_height(160)
            .on_action(move |action| message(ChatMessage::Draft(action)))
            .key_binding(move |press| {
                let enter = matches!(press.key, iced::keyboard::Key::Named(iced::keyboard::key::Named::Enter));
                if enter && !press.modifiers.shift() && !press.modifiers.logo() {
                    Some(text_editor::Binding::Custom(message(ChatMessage::Send)))
                } else {
                    text_editor::Binding::from_key_press(press)
                }
            });

        column![
            header,
            trust,
            scrollable(items).id(Self::transcript_id(id)).anchor_bottom().height(Length::Fill).width(Length::Fill),
            row![input, action].spacing(8).padding(8).align_y(iced::Alignment::End),
        ]
        .into()
    }
}
