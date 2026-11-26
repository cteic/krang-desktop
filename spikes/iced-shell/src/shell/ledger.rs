//! The token ledger: one line per finished chat turn, so the usage pane can
//! show what each agent cost and how much work stayed on a free local model.
//!
//! The file is `ledger.jsonl` beside the saved workspace. A line that does
//! not parse is skipped, so a half-written line after a crash costs one turn
//! and never the whole ledger.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::chat::Agent;
use crate::chat::event::Usage;

/// One finished turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// Seconds since the Unix epoch, when the turn ended.
    pub at: u64,
    pub agent: Agent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    pub usage: Usage,
}

impl Entry {
    pub fn now(agent: Agent, directory: Option<String>, usage: Usage) -> Self {
        Self {
            at: now_seconds(),
            agent,
            directory,
            usage,
        }
    }
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub fn ledger_file(dir: &Path) -> PathBuf {
    dir.join("ledger.jsonl")
}

/// Adds one turn to the end of the ledger.
pub fn append(dir: &Path, entry: &Entry) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut line = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(ledger_file(dir))?;
    file.write_all(&line)
}

/// Every turn in the ledger, oldest first. A missing file is an empty ledger.
pub fn read(dir: &Path) -> Vec<Entry> {
    let Ok(text) = std::fs::read_to_string(ledger_file(dir)) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// A span of time the usage pane sums over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Window {
    Day,
    Week,
    All,
}

impl Window {
    pub const ALL: [Window; 3] = [Window::Day, Window::Week, Window::All];

    pub fn label(self) -> &'static str {
        match self {
            Window::Day => "Last 24 hours",
            Window::Week => "Last 7 days",
            Window::All => "All time",
        }
    }

    fn seconds(self) -> Option<u64> {
        match self {
            Window::Day => Some(24 * 60 * 60),
            Window::Week => Some(7 * 24 * 60 * 60),
            Window::All => None,
        }
    }

    fn contains(self, at: u64, now: u64) -> bool {
        self.seconds()
            .is_none_or(|span| now.saturating_sub(at) <= span)
    }
}

/// What one agent used in a window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Row {
    pub agent: Agent,
    pub turns: u64,
    pub usage: Usage,
}

impl Row {
    pub fn tokens(&self) -> u64 {
        self.usage.input_tokens.unwrap_or(0) + self.usage.output_tokens.unwrap_or(0)
    }
}

/// The ledger summed over one window, one row per agent that ran in it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Summary {
    pub rows: Vec<Row>,
}

impl Summary {
    pub fn of(entries: &[Entry], window: Window, now: u64) -> Self {
        let mut rows: Vec<Row> = Vec::new();
        for entry in entries
            .iter()
            .filter(|entry| window.contains(entry.at, now))
        {
            match rows.iter_mut().find(|row| row.agent == entry.agent) {
                Some(row) => {
                    row.turns += 1;
                    row.usage.add(entry.usage);
                }
                None => rows.push(Row {
                    agent: entry.agent,
                    turns: 1,
                    usage: entry.usage,
                }),
            }
        }
        rows.sort_by_key(|row| std::cmp::Reverse(row.tokens()));
        Self { rows }
    }

    pub fn tokens(&self) -> u64 {
        self.rows.iter().map(Row::tokens).sum()
    }

    pub fn cost_usd(&self) -> f64 {
        self.rows.iter().filter_map(|row| row.usage.cost_usd).sum()
    }

    /// The share of tokens, from 0 to 1, that went to agents costing nothing:
    /// those whose every turn reported a cost of zero. None when no tokens
    /// were used.
    pub fn free_share(&self) -> Option<f64> {
        let total = self.tokens();
        if total == 0 {
            return None;
        }
        let free: u64 = self
            .rows
            .iter()
            .filter(|row| row.usage.cost_usd == Some(0.0))
            .map(Row::tokens)
            .sum();
        // Token counts stay far below 2^52, where f64 stops being exact.
        Some(free as f64 / total as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(cost: Option<f64>, input: u64, output: u64) -> Usage {
        Usage {
            cost_usd: cost,
            input_tokens: Some(input),
            output_tokens: Some(output),
        }
    }

    fn entry(at: u64, agent: Agent, usage: Usage) -> Entry {
        Entry {
            at,
            agent,
            directory: None,
            usage,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("krang-ledger-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_turn_written_reads_back() {
        let dir = scratch("roundtrip");
        let first = entry(10, Agent::Claude, usage(Some(0.02), 100, 20));
        let second = Entry {
            directory: Some(String::from("~/src/app")),
            ..entry(20, Agent::Codex, usage(None, 50, 5))
        };
        append(&dir, &first).unwrap();
        append(&dir, &second).unwrap();
        assert_eq!(read(&dir), vec![first, second]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_line_costs_only_itself() {
        let dir = scratch("broken");
        let good = entry(10, Agent::Claude, usage(Some(0.01), 1, 1));
        append(&dir, &good).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(ledger_file(&dir))
            .unwrap();
        file.write_all(b"{\"at\": 11, \"agent\"\n").unwrap();
        append(&dir, &good).unwrap();
        assert_eq!(read(&dir).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_file_is_an_empty_ledger() {
        assert!(read(&scratch("missing")).is_empty());
    }

    #[test]
    fn a_window_sums_only_its_own_turns() {
        let day = 24 * 60 * 60;
        let now = 30 * day;
        let entries = [
            entry(now - 10, Agent::Claude, usage(Some(0.10), 1000, 200)),
            entry(now - 20, Agent::Claude, usage(Some(0.05), 500, 100)),
            entry(now - 3 * day, Agent::Codex, usage(None, 800, 80)),
            entry(now - 20 * day, Agent::Claude, usage(Some(1.00), 9000, 900)),
        ];
        let today = Summary::of(&entries, Window::Day, now);
        assert_eq!(today.rows.len(), 1);
        assert_eq!(today.rows[0].turns, 2);
        assert_eq!(today.tokens(), 1800);
        assert!((today.cost_usd() - 0.15).abs() < 1e-9);

        let week = Summary::of(&entries, Window::Week, now);
        assert_eq!(week.rows.len(), 2);
        assert_eq!(week.rows[0].agent, Agent::Claude);

        let all = Summary::of(&entries, Window::All, now);
        assert_eq!(all.tokens(), 12_580);
    }

    #[test]
    fn free_share_counts_turns_that_cost_nothing() {
        let entries = [
            entry(1, Agent::Claude, usage(Some(0.10), 300, 100)),
            entry(2, Agent::Codex, usage(Some(0.0), 500, 100)),
        ];
        let summary = Summary::of(&entries, Window::All, 2);
        let share = summary.free_share().unwrap();
        assert!((share - 0.6).abs() < 1e-9);
        assert_eq!(Summary::default().free_share(), None);
    }

    #[test]
    fn an_unknown_price_is_not_free() {
        let entries = [entry(1, Agent::Codex, usage(None, 100, 10))];
        assert_eq!(
            Summary::of(&entries, Window::All, 1).free_share(),
            Some(0.0)
        );
    }
}
