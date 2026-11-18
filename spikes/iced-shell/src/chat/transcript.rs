//! The conversation as the chat pane shows it, built from agent events.
//! A port of the current app's transcript reducer, with the same rules: a
//! streamed message is not repeated when the whole one arrives, a stop is
//! not an error, and a run that failed is shown as failed, never as done.

use serde::{Deserialize, Serialize};

use super::event::{AgentEvent, Usage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Idle,
    Running,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Item {
    User {
        text: String,
    },
    Assistant {
        text: String,
        /// Deltas are still arriving.
        #[serde(default)]
        streaming: bool,
        /// The text came as deltas and the whole message has not arrived.
        #[serde(default)]
        unconfirmed: bool,
        #[serde(default)]
        stopped: bool,
    },
    Tool {
        tool_id: Option<String>,
        name: String,
        summary: String,
    },
    Note {
        text: String,
    },
    Error {
        text: String,
    },
    /// What a finished turn cost.
    Usage {
        usage: Usage,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Transcript {
    pub items: Vec<Item>,
    pub session_id: Option<String>,
    pub status: Status,
    #[serde(default)]
    pub total: Usage,
}

const STDERR_TAIL_LINES: usize = 8;

/// The last few lines of what a process wrote to standard error.
pub fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(STDERR_TAIL_LINES)..].join("\n")
}

impl Transcript {
    /// Where the current turn begins: just after the person's last message.
    fn turn_start(&self) -> usize {
        self.items
            .iter()
            .rposition(|item| matches!(item, Item::User { .. }))
            .map_or(0, |index| index + 1)
    }

    /// Marks every message as finished.
    fn settle(&mut self) {
        for item in &mut self.items {
            if let Item::Assistant { streaming, .. } = item {
                *streaming = false;
            }
        }
    }

    fn push(&mut self, item: Item) {
        self.settle();
        self.items.push(item);
    }

    pub fn send(&mut self, text: String) {
        self.settle();
        self.status = Status::Running;
        self.items.push(Item::User { text });
    }

    pub fn apply(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::Session(id) => self.session_id = Some(id),
            AgentEvent::TextDelta(delta) => {
                if let Some(Item::Assistant {
                    text,
                    streaming: true,
                    ..
                }) = self.items.last_mut()
                {
                    text.push_str(&delta);
                } else {
                    self.push(Item::Assistant {
                        text: delta,
                        streaming: true,
                        unconfirmed: true,
                        stopped: false,
                    });
                }
            }
            AgentEvent::Text(whole) => {
                let start = self.turn_start();
                let streamed = self.items.iter_mut().skip(start).find(|item| {
                    matches!(item, Item::Assistant { unconfirmed: true, text, .. } if whole.trim().starts_with(text.trim()))
                });
                if let Some(Item::Assistant {
                    text,
                    streaming,
                    unconfirmed,
                    ..
                }) = streamed
                {
                    *text = whole;
                    *streaming = false;
                    *unconfirmed = false;
                } else {
                    self.push(Item::Assistant {
                        text: whole,
                        streaming: false,
                        unconfirmed: false,
                        stopped: false,
                    });
                }
            }
            AgentEvent::Tool { id, name, summary } => {
                let start = self.turn_start();
                let known = id.as_ref().and_then(|id| {
                    self.items.iter_mut().skip(start).find(|item| matches!(item, Item::Tool { tool_id: Some(known), .. } if known == id))
                });
                if let Some(Item::Tool {
                    name: known_name,
                    summary: known_summary,
                    ..
                }) = known
                {
                    *known_name = name;
                    if !summary.is_empty() {
                        *known_summary = summary;
                    }
                } else {
                    self.push(Item::Tool {
                        tool_id: id,
                        name,
                        summary,
                    });
                }
            }
            AgentEvent::Note(text) => self.push(Item::Note { text }),
            AgentEvent::Done(usage) => {
                // The turn is written. The run is over when the process exits.
                self.settle();
                if !usage.is_empty() {
                    self.total.add(usage);
                    self.items.push(Item::Usage { usage });
                }
            }
            AgentEvent::Error(message) => self.fail(message),
        }
    }

    fn fail(&mut self, message: String) {
        self.settle();
        self.status = Status::Error;
        if !matches!(self.items.last(), Some(Item::Error { text }) if *text == message) {
            self.items.push(Item::Error { text: message });
        }
    }

    /// The process ended.
    pub fn exit(&mut self, code: Option<i32>, stderr: &str) {
        self.settle();
        if code == Some(0) {
            if self.status == Status::Running {
                self.status = Status::Idle;
            }
            return;
        }
        let tail = stderr_tail(stderr);
        if tail.is_empty() && self.status == Status::Error {
            return;
        }
        let ending = match code {
            None => String::from("The agent was stopped by a signal"),
            Some(code) => format!("The agent exited with code {code}"),
        };
        self.fail(if tail.is_empty() {
            ending
        } else {
            format!("{ending}\n{tail}")
        });
    }

    pub fn start_failed(&mut self, message: String) {
        self.fail(message);
    }

    /// The person stopped the run. A stop is not an error.
    pub fn stop(&mut self) {
        self.settle();
        self.status = Status::Idle;
        if let Some(Item::Assistant {
            unconfirmed,
            stopped,
            ..
        }) = self.items.last_mut()
        {
            *unconfirmed = false;
            *stopped = true;
        } else {
            self.items.push(Item::Assistant {
                text: String::new(),
                streaming: false,
                unconfirmed: false,
                stopped: true,
            });
        }
    }

    /// A transcript saved while a run was going comes back with no run.
    pub fn restored(mut self) -> Self {
        if self.status == Status::Running {
            self.stop();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant_texts(transcript: &Transcript) -> Vec<&str> {
        transcript
            .items
            .iter()
            .filter_map(|item| match item {
                Item::Assistant { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn deltas_then_the_whole_message_make_one_message() {
        let mut transcript = Transcript::default();
        transcript.send("hi".into());
        transcript.apply(AgentEvent::TextDelta("Hel".into()));
        transcript.apply(AgentEvent::TextDelta("lo".into()));
        transcript.apply(AgentEvent::Text("Hello there".into()));
        assert_eq!(assistant_texts(&transcript), ["Hello there"]);
        transcript.apply(AgentEvent::Done(Usage::default()));
        transcript.exit(Some(0), "");
        assert_eq!(transcript.status, Status::Idle);
    }

    #[test]
    fn a_failure_is_never_shown_as_done() {
        let mut transcript = Transcript::default();
        transcript.send("hi".into());
        transcript.apply(AgentEvent::Error("bad key".into()));
        transcript.exit(Some(1), "");
        assert_eq!(transcript.status, Status::Error);
        let errors: Vec<_> = transcript
            .items
            .iter()
            .filter(|item| matches!(item, Item::Error { .. }))
            .collect();
        assert_eq!(errors.len(), 1);

        let mut silent = Transcript::default();
        silent.send("hi".into());
        silent.exit(Some(2), "line one\nfatal: no login\n");
        assert_eq!(silent.status, Status::Error);
        assert_eq!(
            silent.items.last(),
            Some(&Item::Error {
                text: "The agent exited with code 2\nline one\nfatal: no login".into()
            })
        );
    }

    #[test]
    fn a_stop_marks_the_message_and_is_not_an_error() {
        let mut transcript = Transcript::default();
        transcript.send("hi".into());
        transcript.apply(AgentEvent::TextDelta("partial".into()));
        transcript.stop();
        assert_eq!(transcript.status, Status::Idle);
        assert!(
            transcript
                .items
                .iter()
                .any(|item| matches!(item, Item::Assistant { stopped: true, .. }))
        );
    }

    #[test]
    fn the_session_id_and_cost_are_kept() {
        let mut transcript = Transcript::default();
        transcript.send("a".into());
        transcript.apply(AgentEvent::Session("s1".into()));
        transcript.apply(AgentEvent::Done(Usage {
            cost_usd: Some(0.5),
            input_tokens: Some(3),
            output_tokens: Some(4),
        }));
        transcript.send("b".into());
        transcript.apply(AgentEvent::Done(Usage {
            cost_usd: Some(0.25),
            input_tokens: Some(1),
            output_tokens: Some(1),
        }));
        assert_eq!(transcript.session_id.as_deref(), Some("s1"));
        assert_eq!(transcript.total.cost_usd, Some(0.75));
        assert_eq!(transcript.total.output_tokens, Some(5));
    }

    #[test]
    fn a_second_event_for_a_tool_fills_in_the_first() {
        let mut transcript = Transcript::default();
        transcript.send("a".into());
        transcript.apply(AgentEvent::Tool {
            id: Some("t".into()),
            name: "Read".into(),
            summary: String::new(),
        });
        transcript.apply(AgentEvent::Tool {
            id: Some("t".into()),
            name: "Read".into(),
            summary: "/x".into(),
        });
        let tools: Vec<_> = transcript
            .items
            .iter()
            .filter(|item| matches!(item, Item::Tool { .. }))
            .collect();
        assert_eq!(
            tools,
            [&Item::Tool {
                tool_id: Some("t".into()),
                name: "Read".into(),
                summary: "/x".into()
            }]
        );
    }

    #[test]
    fn survives_a_round_trip_and_a_restart_mid_run() {
        let mut transcript = Transcript::default();
        transcript.send("a".into());
        transcript.apply(AgentEvent::TextDelta("half".into()));
        let json = serde_json::to_string(&transcript).unwrap_or_default();
        let back: Transcript = serde_json::from_str::<Transcript>(&json)
            .map(Transcript::restored)
            .unwrap_or_default();
        assert_eq!(back.status, Status::Idle);
        assert!(
            back.items
                .iter()
                .any(|item| matches!(item, Item::Assistant { stopped: true, .. }))
        );
    }
}
