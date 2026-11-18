//! The pane tree of a tab, as saved between runs and as read from a layout
//! file in the current app's TOML format.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::chat::transcript::Transcript;
use crate::chat::{self, Agent};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    /// Side by side, divided by a vertical line.
    Vertical,
    /// Stacked, divided by a horizontal line.
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EditorMode {
    #[default]
    Edit,
    Split,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PaneKind {
    Terminal {
        #[serde(default)]
        directory: Option<String>,
        /// Typed into the shell once, when the pane first opens.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        commands: Vec<String>,
    },
    Editor {
        #[serde(default)]
        vault: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        mode: EditorMode,
    },
    Web {
        url: String,
    },
    Chat {
        #[serde(default)]
        agent: Agent,
        #[serde(default)]
        directory: Option<String>,
        #[serde(default)]
        mode: chat::Mode,
        #[serde(default)]
        trusted: bool,
        #[serde(default)]
        transcript: Transcript,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaneSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub kind: PaneKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tree {
    Split {
        axis: Axis,
        ratio: f32,
        a: Box<Tree>,
        b: Box<Tree>,
    },
    Pane(PaneSpec),
}

impl Tree {
    /// The panes left to right and top to bottom.
    pub fn leaves(&self) -> Vec<&PaneSpec> {
        match self {
            Tree::Pane(spec) => vec![spec],
            Tree::Split { a, b, .. } => {
                let mut leaves = a.leaves();
                leaves.extend(b.leaves());
                leaves
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabSpec {
    pub title: String,
    pub tree: Tree,
    /// Which leaf has the keyboard, by its place in [`Tree::leaves`].
    #[serde(default)]
    pub focus: Option<usize>,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Workspace {
    pub version: u32,
    pub tabs: Vec<TabSpec>,
    pub active: usize,
}

pub const WORKSPACE_VERSION: u32 = 1;

fn text(table: &toml::Table, key: &str) -> Option<String> {
    table.get(key).and_then(toml::Value::as_str).map(String::from)
}

fn pane_kind(id: &str, table: &toml::Table) -> Result<PaneKind, String> {
    let kind = table.get("type").and_then(toml::Value::as_str).unwrap_or("terminal");
    Ok(match kind {
        "terminal" => PaneKind::Terminal {
            directory: text(table, "directory"),
            commands: table
                .get("commands")
                .and_then(toml::Value::as_array)
                .map(|commands| commands.iter().filter_map(toml::Value::as_str).map(String::from).collect())
                .unwrap_or_default(),
        },
        "editor" => PaneKind::Editor {
            vault: None,
            path: text(table, "path"),
            mode: match text(table, "mode").as_deref() {
                Some("split") => EditorMode::Split,
                Some("preview") => EditorMode::Preview,
                _ => EditorMode::Edit,
            },
        },
        // This shell has no separate file list or graph: both open the
        // folder as a vault in the editor, whose tree lists its files.
        "files" | "graph" => PaneKind::Editor { vault: text(table, "directory"), path: None, mode: EditorMode::Edit },
        "web" => PaneKind::Web { url: text(table, "url").unwrap_or_default() },
        "chat" => PaneKind::Chat {
            agent: match text(table, "agent").as_deref() {
                Some("codex") => Agent::Codex,
                _ => Agent::Claude,
            },
            directory: text(table, "directory"),
            mode: match text(table, "mode").as_deref() {
                Some("edit") => chat::Mode::Edit,
                _ => chat::Mode::ReadOnly,
            },
            trusted: false,
            transcript: Transcript::default(),
        },
        other => return Err(format!("pane {id}: unknown type {other}")),
    })
}

struct Entry<'a> {
    table: &'a toml::Table,
    children: Vec<String>,
}

/// Turns a split with any number of children into nested pairs, keeping the
/// relative sizes: `[1, 2, 1]` gives the first child a quarter.
fn chain(axis: Axis, mut children: Vec<(Tree, f32)>) -> Option<Tree> {
    if children.len() <= 1 {
        return children.pop().map(|(tree, _)| tree);
    }
    let (first, weight) = children.remove(0);
    let rest: f32 = children.iter().map(|(_, weight)| weight).sum();
    let ratio = (weight / (weight + rest)).clamp(0.05, 0.95);
    Some(Tree::Split { axis, ratio, a: Box::new(first), b: Box::new(chain(axis, children)?) })
}

fn build(
    id: &str,
    entries: &HashMap<String, Entry<'_>>,
    seen: &mut HashSet<String>,
    focused: &mut Option<String>,
) -> Result<Tree, String> {
    if !seen.insert(id.to_string()) {
        return Err(format!("pane {id} appears twice in the tree"));
    }
    let entry = entries.get(id).ok_or_else(|| format!("no pane with id {id}"))?;
    if let Some(split) = entry.table.get("split").and_then(toml::Value::as_str) {
        let axis = match split {
            "vertical" => Axis::Vertical,
            "horizontal" => Axis::Horizontal,
            other => return Err(format!("pane {id}: split must be vertical or horizontal, not {other}")),
        };
        let sizes: Vec<f32> = entry
            .table
            .get("sizes")
            .and_then(toml::Value::as_array)
            .map(|sizes| sizes.iter().filter_map(|size| size.as_float().or_else(|| size.as_integer().map(|n| n as f64))).map(|n| n as f32).collect())
            .unwrap_or_default();
        let mut children = Vec::new();
        for (index, child) in entry.children.iter().enumerate() {
            let weight = sizes.get(index).copied().filter(|size| *size > 0.0).unwrap_or(1.0);
            children.push((build(child, entries, seen, focused)?, weight));
        }
        return chain(axis, children).ok_or_else(|| format!("split {id} has no children"));
    }
    if entry.table.get("is_focused").and_then(toml::Value::as_bool) == Some(true) {
        *focused = Some(id.to_string());
    }
    Ok(Tree::Pane(PaneSpec { title: text(entry.table, "title"), kind: pane_kind(id, entry.table)? }))
}

/// Reads one layout file, which describes one tab.
pub fn parse_layout(source: &str) -> Result<TabSpec, String> {
    let document: toml::Table = source.parse().map_err(|error: toml::de::Error| error.message().to_string())?;
    let panes = document.get("panes").and_then(toml::Value::as_array).ok_or("the layout has no [[panes]]")?;
    let mut entries = HashMap::new();
    let mut order = Vec::new();
    for (index, pane) in panes.iter().enumerate() {
        let table = pane.as_table().ok_or_else(|| format!("pane {index} is not a table"))?;
        let id = text(table, "id").unwrap_or_else(|| format!("pane-{index}"));
        let children = table
            .get("children")
            .and_then(toml::Value::as_array)
            .map(|children| children.iter().filter_map(toml::Value::as_str).map(String::from).collect())
            .unwrap_or_default();
        order.push(id.clone());
        entries.insert(id, Entry { table, children });
    }
    let referenced: HashSet<&String> = entries.values().flat_map(|entry| &entry.children).collect();
    let roots: Vec<&String> = order.iter().filter(|id| !referenced.contains(id)).collect();
    let root = match roots.as_slice() {
        [root] => (*root).clone(),
        _ if entries.contains_key("root") => String::from("root"),
        _ => return Err(String::from("the layout must have exactly one pane that is no split's child")),
    };
    let mut focused = None;
    let tree = build(&root, &entries, &mut HashSet::new(), &mut focused)?;
    let focus = focused.and_then(|id| {
        let title = entries.get(&id).and_then(|entry| text(entry.table, "title"));
        let kind = entries.get(&id).and_then(|entry| pane_kind(&id, entry.table).ok())?;
        let wanted = PaneSpec { title, kind };
        tree.leaves().iter().position(|leaf| **leaf == wanted)
    });
    let title = text(&document, "title").or_else(|| text(&document, "name")).unwrap_or_else(|| String::from("layout"));
    Ok(TabSpec { title, tree, focus, maximized: false })
}

/// Expands a leading `~` to the home directory. Layout files are written by
/// hand and by scripts, and both use `~/project`.
pub fn expand_home(path: &str) -> std::path::PathBuf {
    match (path, dirs::home_dir()) {
        ("~", Some(home)) => home,
        (path, Some(home)) if path.starts_with("~/") => home.join(&path[2..]),
        _ => std::path::PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO: &str = r#"
name = "demo"
title = "my project"

[[panes]]
id = "root"
split = "vertical"
children = ["left", "page", "chat"]
sizes = [2, 1, 1]

[[panes]]
id = "left"
split = "horizontal"
children = ["shell", "notes"]

[[panes]]
id = "shell"
directory = "~/src/project"
is_focused = true
commands = ["git status -sb"]

[[panes]]
id = "notes"
type = "editor"
path = "~/src/project/README.md"
mode = "split"

[[panes]]
id = "page"
type = "web"
url = "localhost:3000"

[[panes]]
id = "chat"
type = "chat"
agent = "codex"
mode = "edit"
"#;

    #[test]
    fn reads_the_current_apps_format() {
        let tab = match parse_layout(DEMO) {
            Ok(tab) => tab,
            Err(error) => panic!("{error}"),
        };
        assert_eq!(tab.title, "my project");
        let leaves = tab.tree.leaves();
        assert_eq!(leaves.len(), 4);
        assert!(matches!(&leaves[0].kind, PaneKind::Terminal { commands, .. } if commands == &["git status -sb"]));
        assert!(matches!(&leaves[1].kind, PaneKind::Editor { mode: EditorMode::Split, .. }));
        assert!(matches!(&leaves[2].kind, PaneKind::Web { url } if url == "localhost:3000"));
        assert!(matches!(&leaves[3].kind, PaneKind::Chat { agent: Agent::Codex, mode: chat::Mode::Edit, .. }));
        assert_eq!(tab.focus, Some(0));
        // The first of three children with sizes 2, 1, 1 takes half.
        let Tree::Split { axis, ratio, .. } = &tab.tree else { panic!("root is not a split") };
        assert_eq!((*axis, *ratio), (Axis::Vertical, 0.5));
    }

    #[test]
    fn a_pane_with_no_type_is_a_terminal_and_files_open_a_vault() {
        let tab = parse_layout("[[panes]]\nid = \"a\"\n").map(|tab| tab.tree);
        assert!(matches!(tab, Ok(Tree::Pane(PaneSpec { kind: PaneKind::Terminal { .. }, .. }))));
        let tab = parse_layout("[[panes]]\nid = \"a\"\ntype = \"files\"\ndirectory = \"/v\"\n").map(|tab| tab.tree);
        assert!(matches!(tab, Ok(Tree::Pane(PaneSpec { kind: PaneKind::Editor { vault: Some(_), .. }, .. }))));
    }

    #[test]
    fn bad_layouts_say_why() {
        assert!(parse_layout("title = 1").is_err());
        assert!(parse_layout("[[panes]]\nid = \"a\"\ntype = \"radio\"\n").is_err_and(|error| error.contains("radio")));
        let cycle = "[[panes]]\nid = \"root\"\nsplit = \"vertical\"\nchildren = [\"root\"]\n";
        assert!(parse_layout(cycle).is_err());
        let missing = "[[panes]]\nid = \"root\"\nsplit = \"vertical\"\nchildren = [\"x\"]\n";
        assert!(parse_layout(missing).is_err_and(|error| error.contains("no pane with id x")));
    }

    #[test]
    fn a_workspace_round_trips_through_json() {
        let tab = parse_layout(DEMO).ok();
        let workspace = Workspace { version: WORKSPACE_VERSION, tabs: tab.into_iter().collect(), active: 0 };
        let json = serde_json::to_string(&workspace).unwrap_or_default();
        let back: Option<Workspace> = serde_json::from_str(&json).ok();
        assert_eq!(back, Some(workspace));
    }
}
