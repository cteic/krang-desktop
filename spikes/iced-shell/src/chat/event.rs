//! What an agent's output line means, in terms the transcript understands.
//! Each agent has its own JSON event format; an adapter turns one line of it
//! into zero or more of these.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    Session(String),
    /// A piece of the message being written.
    TextDelta(String),
    /// A whole message. It may repeat text already sent as deltas.
    Text(String),
    /// A tool call. `id` is the agent's own id for it, when it gives one.
    Tool {
        id: Option<String>,
        name: String,
        summary: String,
    },
    /// An output line that could not be read, kept as it came.
    Note(String),
    Done(Usage),
    Error(String),
}

/// What a turn cost, as the agent reported it. Codex reports tokens but no
/// price; Claude Code reports both.
#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Usage {
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        fn sum<T: std::ops::Add<Output = T>>(a: Option<T>, b: Option<T>) -> Option<T> {
            match (a, b) {
                (Some(a), Some(b)) => Some(a + b),
                (a, b) => a.or(b),
            }
        }
        self.cost_usd = sum(self.cost_usd, other.cost_usd);
        self.input_tokens = sum(self.input_tokens, other.input_tokens);
        self.output_tokens = sum(self.output_tokens, other.output_tokens);
    }

    pub fn is_empty(&self) -> bool {
        self.cost_usd.is_none() && self.input_tokens.is_none() && self.output_tokens.is_none()
    }
}

const SUMMARY_LIMIT: usize = 120;

/// Squeezes text onto one line and cuts it to a length a note can show.
pub fn one_line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= SUMMARY_LIMIT {
        return flat;
    }
    let mut cut: String = flat.chars().take(SUMMARY_LIMIT - 1).collect();
    cut.push('…');
    cut
}

pub enum Line {
    Blank,
    Json(Value),
    /// Not JSON: kept as a note, so nothing the agent printed is lost.
    Note(AgentEvent),
}

pub fn parse_json_line(line: &str) -> Line {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Line::Blank;
    }
    match serde_json::from_str(trimmed) {
        Ok(value) => Line::Json(value),
        Err(_) => Line::Note(AgentEvent::Note(trimmed.to_string())),
    }
}

pub fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_flattens_and_cuts() {
        assert_eq!(one_line("  a\n b\tc "), "a b c");
        let long = "x".repeat(200);
        let cut = one_line(&long);
        assert_eq!(cut.chars().count(), SUMMARY_LIMIT);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn usage_adds_what_each_side_knows() {
        let mut total = Usage::default();
        total.add(Usage {
            cost_usd: Some(0.5),
            input_tokens: Some(10),
            output_tokens: None,
        });
        total.add(Usage {
            cost_usd: Some(0.25),
            input_tokens: None,
            output_tokens: Some(3),
        });
        assert_eq!(
            total,
            Usage {
                cost_usd: Some(0.75),
                input_tokens: Some(10),
                output_tokens: Some(3)
            }
        );
    }
}
