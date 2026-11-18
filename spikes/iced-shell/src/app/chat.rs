//! The chat pane: a transcript over a command-line agent.

use std::path::PathBuf;

use iced::widget::{
    Space, button, column, container, markdown, row, scrollable, text, text_editor,
};
use iced::{Element, Length, Padding};

use crate::chat::event::Usage;
use crate::chat::runner::{self, RunEvent, RunOutput};
use crate::chat::transcript::{Item, Status, Transcript};
use crate::chat::{Agent, Mode, RunRequest};
use crate::shell::layout::expand_home;
use crate::style::{self, Step, measure, size, space};

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
    pub fn new(
        agent: Agent,
        directory: Option<String>,
        mode: Mode,
        trusted: bool,
        transcript: Transcript,
    ) -> Self {
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
        self.rendered
            .resize_with(self.transcript.items.len(), || None);
        for (item, slot) in self.transcript.items.iter().zip(&mut self.rendered) {
            let Item::Assistant { text, .. } = item else {
                *slot = None;
                continue;
            };
            if slot
                .as_ref()
                .is_none_or(|(length, _)| *length != text.len())
            {
                *slot = Some((text.len(), markdown::Content::parse(text)));
            }
        }
    }

    pub fn send(
        &mut self,
        pane: u64,
        run: u64,
        sender: &tokio::sync::mpsc::UnboundedSender<RunEvent>,
    ) {
        let prompt = self.draft.text().trim().to_string();
        if prompt.is_empty() || self.run.is_some() {
            return;
        }
        self.draft = text_editor::Content::new();
        self.transcript.send(prompt.clone());
        let request = RunRequest {
            mode: self.mode,
            directory: self.directory.clone(),
            session_id: self.transcript.session_id.clone(),
            trusted: self.trusted,
        };
        let directory: Option<PathBuf> = self.directory.as_deref().map(expand_home);
        match runner::start(
            self.agent,
            self.agent.args(&request),
            directory.as_deref(),
            prompt,
            pane,
            run,
            sender.clone(),
        ) {
            Ok(started) => {
                self.run = Some(Run {
                    id: run,
                    group: started.group,
                })
            }
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

    /// The note at the right of the pane's status line: what the agent is
    /// doing, and what the chat has cost.
    pub fn status_note(&self) -> String {
        let state = match (self.transcript.status, self.run.is_some()) {
            (_, true) => "Running",
            (Status::Error, _) => "Failed",
            _ => "Ready",
        };
        match self.transcript.total.cost_usd {
            Some(cost) => format!("{state}, ${cost:.2}"),
            None => String::from(state),
        }
    }

    pub fn view(&self, id: u64, mode: style::Mode, focused: bool) -> Element<'_, Message> {
        let message = move |message: ChatMessage| Message::Chat(id, message);
        let settings = style::prose(mode, focused, size::PROSE);
        let viewer = ProseViewer { focused };

        let mut items = column![].spacing(space::XL);
        for (index, item) in self.transcript.items.iter().enumerate() {
            let element: Element<'_, Message> = match item {
                Item::User { text: said } => row![
                    style::mark(),
                    column![
                        text("You").size(size::META).style(style::muted),
                        text(said.clone())
                            .size(size::ASK)
                            .font(style::ui_strong())
                            .line_height(style::leading::DISPLAY),
                    ]
                    .spacing(space::XXS)
                ]
                .spacing(space::L)
                .into(),
                Item::Assistant { stopped, .. } => {
                    let body: Element<'_, Message> =
                        match self.rendered.get(index).and_then(Option::as_ref) {
                            Some((_, content)) => {
                                markdown::view_with(content.items(), settings, &viewer)
                                    .map(move |url| message(ChatMessage::Link(url)))
                            }
                            None => Space::new().into(),
                        };
                    if *stopped {
                        column![
                            body,
                            step(
                                Step::Quiet,
                                text("Stopped").size(size::BODY).style(style::muted)
                            )
                        ]
                        .spacing(space::M)
                        .into()
                    } else {
                        body
                    }
                }
                Item::Tool { name, summary, .. } => step(
                    Step::Done,
                    row![
                        text(name.clone())
                            .size(size::BODY)
                            .font(style::ui_strong())
                            .wrapping(text::Wrapping::None),
                        text(summary.clone())
                            .size(size::MONO)
                            .font(style::mono())
                            .style(style::muted),
                    ]
                    .spacing(space::L)
                    .align_y(iced::Alignment::Center),
                ),
                Item::Note { text: note } => text(note.clone())
                    .size(size::LABEL)
                    .style(style::muted)
                    .into(),
                Item::Error { text: error } => step(
                    Step::Failed,
                    column![
                        text("Failed")
                            .size(size::BODY)
                            .font(style::ui_strong())
                            .style(style::bad),
                        container(text(error.clone()).size(size::MONO).font(style::mono()))
                            .padding(Padding::from([space::L, space::XL]))
                            .width(Length::Fill)
                            .style(style::well_bad),
                    ]
                    .spacing(space::M),
                ),
                Item::Usage { usage } => text(usage_line(usage))
                    .size(size::META)
                    .style(style::muted)
                    .into(),
            };
            items = items.push(element);
        }

        let total = usage_line(&self.transcript.total);
        let summary = row![
            text(if total.is_empty() {
                String::from("Nothing spent in this chat yet.")
            } else {
                format!("This chat: {total}")
            })
            .size(size::LABEL)
            .style(style::muted)
            .width(Length::Fill),
            button(
                text(match self.mode {
                    Mode::ReadOnly => "Read only",
                    Mode::Edit => "Can edit files",
                })
                .size(size::LABEL)
                .style(style::inherit)
                .wrapping(text::Wrapping::None)
            )
            .padding(Padding::from([space::XXS, space::M]))
            .style(style::quiet)
            .on_press_maybe((!self.is_running()).then(|| message(ChatMessage::ToggleMode))),
        ]
        .spacing(space::L)
        .align_y(iced::Alignment::Center);

        let action = if self.is_running() {
            button(
                text("Stop")
                    .size(size::BODY)
                    .font(style::ui_strong())
                    .style(style::inherit),
            )
            .style(style::danger)
            .on_press(message(ChatMessage::Stop))
        } else {
            button(
                text("Send")
                    .size(size::BODY)
                    .font(style::ui_strong())
                    .style(style::inherit),
            )
            .style(style::primary)
            .on_press(message(ChatMessage::Send))
        }
        .padding(Padding::from([space::L, space::XXL]));
        let input = text_editor(&self.draft)
            .id(Self::input_id(id))
            .placeholder("Message the agent. Enter sends, Shift+Enter adds a line.")
            .size(size::BODY)
            .padding(Padding::from([space::L, space::XL]))
            .height(Length::Shrink)
            .max_height(measure::COMPOSER_MAX)
            .style(style::composer)
            .on_action(move |action| message(ChatMessage::Draft(action)))
            .key_binding(move |press| {
                let enter = matches!(
                    press.key,
                    iced::keyboard::Key::Named(iced::keyboard::key::Named::Enter)
                );
                if enter && !press.modifiers.shift() && !press.modifiers.logo() {
                    Some(text_editor::Binding::Custom(message(ChatMessage::Send)))
                } else {
                    text_editor::Binding::from_key_press(press)
                }
            });

        let mut foot = column![].spacing(space::M);
        if self.agent == Agent::Claude && !self.trusted {
            foot = foot.push(
                container(
                    row![
                        text("Trust this folder? Until you do, its own agent settings, hooks and skills do not load.")
                            .size(size::LABEL)
                            .width(Length::Fill),
                        button(text("Trust").size(size::LABEL).font(style::ui_strong()).style(style::inherit))
                            .padding(Padding::from([space::XS, space::XL]))
                            .style(style::secondary)
                            .on_press(message(ChatMessage::Trust)),
                    ]
                    .spacing(space::L)
                    .align_y(iced::Alignment::Center),
                )
                .padding(Padding::from([space::M, space::XL]))
                .style(style::notice),
            );
        }
        foot = foot.push(summary).push(
            row![input, action]
                .spacing(space::L)
                .align_y(iced::Alignment::End),
        );

        column![
            scrollable(
                container(items.max_width(measure::READING))
                    .center_x(Length::Fill)
                    .padding(Padding::from([space::HUGE, space::HUGE]).bottom(space::XXL)),
            )
            .id(Self::transcript_id(id))
            .direction(style::scroll_direction())
            .style(style::scrollbar)
            .anchor_bottom()
            .height(Length::Fill)
            .width(Length::Fill),
            container(foot.max_width(measure::READING))
                .center_x(Length::Fill)
                .padding(Padding::from([space::NONE, space::HUGE]).bottom(space::XL)),
        ]
        .into()
    }
}

/// One thing an agent did: a marker, then what it was.
fn step<'a>(kind: Step, what: impl Into<Element<'a, Message>>) -> Element<'a, Message> {
    row![
        container(style::dot(kind)).padding(Padding::default().top(space::S)),
        what.into()
    ]
    .spacing(space::L)
    .into()
}

/// Draws an agent's Markdown with the shell's own code blocks.
struct ProseViewer {
    focused: bool,
}

impl<'a> markdown::Viewer<'a, String> for ProseViewer {
    fn on_link_click(url: markdown::Uri) -> String {
        url
    }

    fn code_block(
        &self,
        _settings: markdown::Settings,
        _language: Option<&'a str>,
        code: &'a str,
        _lines: &'a [markdown::Text],
    ) -> Element<'a, String> {
        style::code_block(code, self.focused)
    }
}
