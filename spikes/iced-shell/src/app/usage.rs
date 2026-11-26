//! The usage pane: what each agent used, read from the token ledger, and how
//! much of the work ran on a model that costs nothing.

use iced::widget::{column, container, row, scrollable, text};
use iced::{Element, Length, Padding};

use crate::shell::ledger::{self, Summary, Window};
use crate::style::{self, size, space};

use super::Message;

pub struct UsagePane {
    summaries: Vec<(Window, Summary)>,
    turns: usize,
}

impl Default for UsagePane {
    fn default() -> Self {
        let mut pane = Self {
            summaries: Vec::new(),
            turns: 0,
        };
        pane.refresh();
        pane
    }
}

impl UsagePane {
    /// Reads the ledger again.
    pub fn refresh(&mut self) {
        let entries = crate::shell::store::state_dir()
            .map(|dir| ledger::read(&dir))
            .unwrap_or_default();
        let now = ledger::now_seconds();
        self.turns = entries.len();
        self.summaries = Window::ALL
            .iter()
            .map(|window| (*window, Summary::of(&entries, *window, now)))
            .collect();
    }

    pub fn status_note(&self) -> String {
        match self.turns {
            1 => String::from("1 turn"),
            turns => format!("{turns} turns"),
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        let mut body = column![].spacing(space::XL);
        if self.turns == 0 {
            body = body.push(
                text("No chat turns yet. Each finished reply in a chat pane is counted here.")
                    .size(size::LABEL)
                    .style(style::muted),
            );
        }
        for (window, summary) in &self.summaries {
            if summary.rows.is_empty() {
                continue;
            }
            body = body.push(section(*window, summary));
        }
        scrollable(
            container(body)
                .width(Length::Fill)
                .padding(Padding::from([space::L, space::XL])),
        )
        .style(style::scrollbar)
        .height(Length::Fill)
        .into()
    }
}

fn section(window: Window, summary: &Summary) -> Element<'_, Message> {
    let free = summary
        .free_share()
        .map(|share| format!("{:.0}% free", share * 100.0))
        .unwrap_or_default();
    let heading = row![
        text(window.label()).size(size::LABEL),
        text(format!(
            "{} tokens, {}  {free}",
            thousands(summary.tokens()),
            money(Some(summary.cost_usd()))
        ))
        .size(size::META)
        .style(style::muted),
    ]
    .spacing(space::L)
    .align_y(iced::Alignment::Center);

    let mut table = column![header()].spacing(space::S);
    for line in &summary.rows {
        table = table.push(cells([
            line.agent.label().to_string(),
            line.turns.to_string(),
            line.usage.input_tokens.map(thousands).unwrap_or_default(),
            line.usage.output_tokens.map(thousands).unwrap_or_default(),
            money(line.usage.cost_usd),
        ]));
    }
    column![heading, table].spacing(space::M).into()
}

fn header<'a>() -> Element<'a, Message> {
    let names = ["Agent", "Turns", "In", "Out", "Cost"];
    let mut line = row![].spacing(space::M);
    for (index, name) in names.into_iter().enumerate() {
        line = line.push(
            text(name)
                .size(size::META)
                .style(style::muted)
                .width(width(index)),
        );
    }
    line.into()
}

fn cells<'a>(values: [String; 5]) -> Element<'a, Message> {
    let mut line = row![].spacing(space::M);
    for (index, value) in values.into_iter().enumerate() {
        line = line.push(text(value).size(size::LABEL).width(width(index)));
    }
    line.into()
}

fn width(column: usize) -> Length {
    if column == 0 {
        Length::FillPortion(3)
    } else {
        Length::FillPortion(2)
    }
}

/// A price as the chat shows it, or "unknown" when the agent gave none.
fn money(cost: Option<f64>) -> String {
    match cost {
        Some(0.0) => String::from("$0"),
        Some(cost) => format!("${cost:.2}"),
        None => String::from("unknown"),
    }
}

/// A count with commas between groups of three, as in 12,580.
fn thousands(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_grouped_in_threes() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1000), "1,000");
        assert_eq!(thousands(12_580), "12,580");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn a_missing_price_says_so() {
        assert_eq!(money(None), "unknown");
        assert_eq!(money(Some(0.0)), "$0");
        assert_eq!(money(Some(1.234)), "$1.23");
    }
}
