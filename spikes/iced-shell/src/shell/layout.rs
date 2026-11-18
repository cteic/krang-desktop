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
    Files {
        #[serde(default)]
        directory: Option<String>,
        /// Open folders, as paths under the directory.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        expanded: Vec<String>,
        #[serde(default)]
        hidden: bool,
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
    /// The person chose the title, so the focused pane's own title no
    /// longer stands in for it.
    #[serde(default)]
    pub named: bool,
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
    table
        .get(key)
        .and_then(toml::Value::as_str)
        .map(String::from)
}

fn pane_kind(id: &str, table: &toml::Table) -> Result<PaneKind, String> {
    let kind = table
        .get("type")
        .and_then(toml::Value::as_str)
        .unwrap_or("terminal");
    Ok(match kind {
        "terminal" => PaneKind::Terminal {
            directory: text(table, "directory"),
            commands: table
                .get("commands")
                .and_then(toml::Value::as_array)
                .map(|commands| {
                    commands
                        .iter()
                        .filter_map(toml::Value::as_str)
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
        },
        "editor" => PaneKind::Editor {
            vault: text(table, "vault"),
            path: text(table, "path"),
            mode: match text(table, "mode").as_deref() {
                Some("split") => EditorMode::Split,
                Some("preview") => EditorMode::Preview,
                _ => EditorMode::Edit,
            },
        },
        "files" => PaneKind::Files {
            directory: text(table, "directory"),
            expanded: Vec::new(),
            hidden: table.get("hidden").and_then(toml::Value::as_bool) == Some(true),
        },
        // This shell has no graph pane: the folder opens as a vault in the
        // editor, whose tree lists its notes.
        "graph" => PaneKind::Editor {
            vault: text(table, "directory"),
            path: None,
            mode: EditorMode::Edit,
        },
        "web" => PaneKind::Web {
            url: text(table, "url").unwrap_or_default(),
        },
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
    Some(Tree::Split {
        axis,
        ratio,
        a: Box::new(first),
        b: Box::new(chain(axis, children)?),
    })
}

fn build(
    id: &str,
    entries: &HashMap<String, Entry<'_>>,
    seen: &mut HashSet<String>,
    leaves: &mut usize,
    focused: &mut Option<usize>,
) -> Result<Tree, String> {
    if !seen.insert(id.to_string()) {
        return Err(format!("pane {id} appears twice in the tree"));
    }
    let entry = entries
        .get(id)
        .ok_or_else(|| format!("no pane with id {id}"))?;
    if let Some(split) = entry.table.get("split").and_then(toml::Value::as_str) {
        let axis = match split {
            "vertical" => Axis::Vertical,
            "horizontal" => Axis::Horizontal,
            other => {
                return Err(format!(
                    "pane {id}: split must be vertical or horizontal, not {other}"
                ));
            }
        };
        let sizes: Vec<f32> = entry
            .table
            .get("sizes")
            .and_then(toml::Value::as_array)
            .map(|sizes| {
                sizes
                    .iter()
                    .filter_map(|size| {
                        size.as_float()
                            .or_else(|| size.as_integer().map(|n| n as f64))
                    })
                    .map(|n| n as f32)
                    .collect()
            })
            .unwrap_or_default();
        let mut children = Vec::new();
        for (index, child) in entry.children.iter().enumerate() {
            let weight = sizes
                .get(index)
                .copied()
                .filter(|size| *size > 0.0)
                .unwrap_or(1.0);
            children.push((build(child, entries, seen, leaves, focused)?, weight));
        }
        return chain(axis, children).ok_or_else(|| format!("split {id} has no children"));
    }
    if entry.table.get("is_focused").and_then(toml::Value::as_bool) == Some(true) {
        *focused = Some(*leaves);
    }
    *leaves += 1;
    Ok(Tree::Pane(PaneSpec {
        title: text(entry.table, "title"),
        kind: pane_kind(id, entry.table)?,
    }))
}

/// Reads one layout file, which describes one tab.
pub fn parse_layout(source: &str) -> Result<TabSpec, String> {
    let document: toml::Table = source
        .parse()
        .map_err(|error: toml::de::Error| error.message().to_string())?;
    let panes = document
        .get("panes")
        .and_then(toml::Value::as_array)
        .ok_or("the layout has no [[panes]]")?;
    let mut entries = HashMap::new();
    let mut order = Vec::new();
    for (index, pane) in panes.iter().enumerate() {
        let table = pane
            .as_table()
            .ok_or_else(|| format!("pane {index} is not a table"))?;
        let id = text(table, "id").unwrap_or_else(|| format!("pane-{index}"));
        let children = table
            .get("children")
            .and_then(toml::Value::as_array)
            .map(|children| {
                children
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        order.push(id.clone());
        entries.insert(id, Entry { table, children });
    }
    let referenced: HashSet<&String> = entries.values().flat_map(|entry| &entry.children).collect();
    let roots: Vec<&String> = order.iter().filter(|id| !referenced.contains(id)).collect();
    let root = match roots.as_slice() {
        [root] => (*root).clone(),
        _ if entries.contains_key("root") => String::from("root"),
        _ => {
            return Err(String::from(
                "the layout must have exactly one pane that is no split's child",
            ));
        }
    };
    let mut focus = None;
    let tree = build(&root, &entries, &mut HashSet::new(), &mut 0, &mut focus)?;
    let named = text(&document, "title").or_else(|| text(&document, "name"));
    Ok(TabSpec {
        named: named.is_some(),
        title: named.unwrap_or_else(|| String::from("layout")),
        tree,
        focus,
        maximized: false,
    })
}

fn leaf_table(spec: &PaneSpec) -> toml::Table {
    let mut table = toml::Table::new();
    let mut set = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            table.insert(key.to_string(), toml::Value::String(value.to_string()));
        }
    };
    set("title", spec.title.as_deref());
    match &spec.kind {
        PaneKind::Terminal { directory, .. } => {
            set("type", Some("terminal"));
            set("directory", directory.as_deref());
        }
        PaneKind::Editor { vault, path, mode } => {
            set("type", Some("editor"));
            set("vault", vault.as_deref());
            set("path", path.as_deref());
            set(
                "mode",
                Some(match mode {
                    EditorMode::Edit => "edit",
                    EditorMode::Split => "split",
                    EditorMode::Preview => "preview",
                }),
            );
        }
        PaneKind::Web { url } => {
            set("type", Some("web"));
            set("url", Some(url));
        }
        PaneKind::Files { directory, .. } => {
            set("type", Some("files"));
            set("directory", directory.as_deref());
        }
        PaneKind::Chat {
            agent,
            directory,
            mode,
            ..
        } => {
            set("type", Some("chat"));
            set(
                "agent",
                Some(match agent {
                    Agent::Claude => "claude",
                    Agent::Codex => "codex",
                }),
            );
            set("directory", directory.as_deref());
            set(
                "mode",
                Some(match mode {
                    chat::Mode::ReadOnly => "read-only",
                    chat::Mode::Edit => "edit",
                }),
            );
        }
    }
    if let PaneKind::Files { hidden: true, .. } = &spec.kind {
        table.insert(String::from("hidden"), toml::Value::Boolean(true));
    }
    if let PaneKind::Terminal { commands, .. } = &spec.kind
        && !commands.is_empty()
    {
        let commands = commands.iter().cloned().map(toml::Value::String).collect();
        table.insert(String::from("commands"), toml::Value::Array(commands));
    }
    table
}

/// The two sizes a layout file gives a split of this ratio. They are whole
/// numbers out of a thousand, so a file reads back to the ratio it wrote.
fn sizes(ratio: f32) -> (i64, i64) {
    let first = (ratio.clamp(0.05, 0.95) * 1000.0).round() as i64;
    (first, 1000 - first)
}

/// The ratio a layout file's sizes give back.
pub fn file_ratio(ratio: f32) -> f32 {
    let (first, second) = sizes(ratio);
    first as f32 / (first + second) as f32
}

struct Writer {
    panes: Vec<toml::Value>,
    leaves: usize,
    splits: usize,
    focus: Option<usize>,
}

impl Writer {
    /// Adds a node and what is under it, and returns the node's id.
    fn node(&mut self, tree: &Tree, root: bool) -> String {
        match tree {
            Tree::Pane(spec) => {
                let id = format!("pane-{}", self.leaves + 1);
                let mut table = leaf_table(spec);
                table.insert(String::from("id"), toml::Value::String(id.clone()));
                if self.focus == Some(self.leaves) {
                    table.insert(String::from("is_focused"), toml::Value::Boolean(true));
                }
                self.leaves += 1;
                self.panes.push(toml::Value::Table(table));
                id
            }
            Tree::Split { axis, ratio, a, b } => {
                self.splits += 1;
                let id = if root {
                    String::from("root")
                } else {
                    format!("split-{}", self.splits)
                };
                // A split is written before its children, as a person
                // would write the file.
                let place = self.panes.len();
                self.panes.push(toml::Value::Boolean(false));
                let children = [self.node(a, false), self.node(b, false)];
                let (first, second) = sizes(*ratio);
                let mut table = toml::Table::new();
                table.insert(String::from("id"), toml::Value::String(id.clone()));
                table.insert(
                    String::from("split"),
                    toml::Value::String(String::from(match axis {
                        Axis::Vertical => "vertical",
                        Axis::Horizontal => "horizontal",
                    })),
                );
                table.insert(
                    String::from("children"),
                    toml::Value::Array(children.map(toml::Value::String).to_vec()),
                );
                table.insert(
                    String::from("sizes"),
                    toml::Value::Array(vec![
                        toml::Value::Integer(first),
                        toml::Value::Integer(second),
                    ]),
                );
                self.panes[place] = toml::Value::Table(table);
                id
            }
        }
    }
}

/// Writes one tab as a layout file that [`parse_layout`] reads back.
///
/// A layout describes where panes go and what they open, so what a pane has
/// done since is left out: a chat's transcript and trust, the folders open
/// in a files pane, and whether a pane is magnified.
pub fn write_layout(tab: &TabSpec) -> Result<String, String> {
    let mut writer = Writer {
        panes: Vec::new(),
        leaves: 0,
        splits: 0,
        focus: tab.focus,
    };
    writer.node(&tab.tree, true);
    let mut document = toml::Table::new();
    document.insert(
        String::from("title"),
        toml::Value::String(tab.title.clone()),
    );
    document.insert(String::from("panes"), toml::Value::Array(writer.panes));
    toml::to_string(&document).map_err(|error| error.to_string())
}

/// A tab as [`write_layout`] keeps it: what [`parse_layout`] gives back for
/// the file. The tests use it, and it documents what a layout leaves out.
pub fn as_layout(tab: &TabSpec) -> TabSpec {
    fn tree(node: &Tree) -> Tree {
        match node {
            Tree::Pane(spec) => Tree::Pane(PaneSpec {
                title: spec.title.clone(),
                kind: match &spec.kind {
                    PaneKind::Chat {
                        agent,
                        directory,
                        mode,
                        ..
                    } => PaneKind::Chat {
                        agent: *agent,
                        directory: directory.clone(),
                        mode: *mode,
                        trusted: false,
                        transcript: Transcript::default(),
                    },
                    PaneKind::Files {
                        directory, hidden, ..
                    } => PaneKind::Files {
                        directory: directory.clone(),
                        expanded: Vec::new(),
                        hidden: *hidden,
                    },
                    other => other.clone(),
                },
            }),
            Tree::Split { axis, ratio, a, b } => Tree::Split {
                axis: *axis,
                ratio: file_ratio(*ratio),
                a: Box::new(tree(a)),
                b: Box::new(tree(b)),
            },
        }
    }
    TabSpec {
        title: tab.title.clone(),
        named: true,
        tree: tree(&tab.tree),
        focus: tab.focus,
        maximized: false,
    }
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
        assert!(
            matches!(&leaves[0].kind, PaneKind::Terminal { commands, .. } if commands == &["git status -sb"])
        );
        assert!(matches!(
            &leaves[1].kind,
            PaneKind::Editor {
                mode: EditorMode::Split,
                ..
            }
        ));
        assert!(matches!(&leaves[2].kind, PaneKind::Web { url } if url == "localhost:3000"));
        assert!(matches!(
            &leaves[3].kind,
            PaneKind::Chat {
                agent: Agent::Codex,
                mode: chat::Mode::Edit,
                ..
            }
        ));
        assert_eq!(tab.focus, Some(0));
        // The first of three children with sizes 2, 1, 1 takes half.
        let Tree::Split { axis, ratio, .. } = &tab.tree else {
            panic!("root is not a split")
        };
        assert_eq!((*axis, *ratio), (Axis::Vertical, 0.5));
    }

    #[test]
    fn a_pane_with_no_type_is_a_terminal_and_a_graph_opens_a_vault() {
        let tab = parse_layout("[[panes]]\nid = \"a\"\n").map(|tab| tab.tree);
        assert!(matches!(
            tab,
            Ok(Tree::Pane(PaneSpec {
                kind: PaneKind::Terminal { .. },
                ..
            }))
        ));
        let tab = parse_layout("[[panes]]\nid = \"a\"\ntype = \"graph\"\ndirectory = \"/v\"\n")
            .map(|tab| tab.tree);
        assert!(matches!(
            tab,
            Ok(Tree::Pane(PaneSpec {
                kind: PaneKind::Editor { vault: Some(_), .. },
                ..
            }))
        ));
        let tab = parse_layout("[[panes]]\nid = \"a\"\ntype = \"files\"\ndirectory = \"/v\"\n")
            .map(|tab| tab.tree);
        assert!(matches!(
            tab,
            Ok(Tree::Pane(PaneSpec {
                kind: PaneKind::Files {
                    directory: Some(_),
                    hidden: false,
                    ..
                },
                ..
            }))
        ));
    }

    #[test]
    fn bad_layouts_say_why() {
        assert!(parse_layout("title = 1").is_err());
        assert!(
            parse_layout("[[panes]]\nid = \"a\"\ntype = \"radio\"\n")
                .is_err_and(|error| error.contains("radio"))
        );
        let cycle = "[[panes]]\nid = \"root\"\nsplit = \"vertical\"\nchildren = [\"root\"]\n";
        assert!(parse_layout(cycle).is_err());
        let missing = "[[panes]]\nid = \"root\"\nsplit = \"vertical\"\nchildren = [\"x\"]\n";
        assert!(parse_layout(missing).is_err_and(|error| error.contains("no pane with id x")));
    }

    #[test]
    fn a_tab_saved_as_a_layout_reads_back_the_same() {
        let leaf = |title: Option<&str>, kind: PaneKind| {
            Tree::Pane(PaneSpec {
                title: title.map(String::from),
                kind,
            })
        };
        let terminal = || PaneKind::Terminal {
            directory: Some(String::from("~/src/project")),
            commands: vec![String::from("git status -sb")],
        };
        let mut said = Transcript::default();
        said.send(String::from("hello"));
        let tab = TabSpec {
            title: String::from("review: api \"v2\""),
            named: true,
            tree: Tree::Split {
                axis: Axis::Vertical,
                ratio: 0.3712,
                a: Box::new(Tree::Split {
                    axis: Axis::Horizontal,
                    ratio: 0.5,
                    a: Box::new(leaf(None, terminal())),
                    // The same pane twice: focus must land on the second.
                    b: Box::new(leaf(None, terminal())),
                }),
                b: Box::new(Tree::Split {
                    axis: Axis::Horizontal,
                    ratio: 0.99,
                    a: Box::new(leaf(
                        Some("notes"),
                        PaneKind::Editor {
                            vault: Some(String::from("~/notes")),
                            path: Some(String::from("~/notes/today.md")),
                            mode: EditorMode::Preview,
                        },
                    )),
                    b: Box::new(Tree::Split {
                        axis: Axis::Vertical,
                        ratio: 0.25,
                        a: Box::new(Tree::Split {
                            axis: Axis::Horizontal,
                            ratio: 0.5,
                            a: Box::new(leaf(
                                None,
                                PaneKind::Web {
                                    url: String::from("http://localhost:3000/"),
                                },
                            )),
                            b: Box::new(leaf(
                                None,
                                PaneKind::Files {
                                    directory: Some(String::from("~/src/project")),
                                    expanded: vec![String::from("src")],
                                    hidden: true,
                                },
                            )),
                        }),
                        b: Box::new(leaf(
                            None,
                            PaneKind::Chat {
                                agent: Agent::Codex,
                                directory: Some(String::from("~/src/project")),
                                mode: chat::Mode::Edit,
                                trusted: true,
                                transcript: said,
                            },
                        )),
                    }),
                }),
            },
            focus: Some(1),
            maximized: true,
        };
        let file = match write_layout(&tab) {
            Ok(file) => file,
            Err(error) => panic!("{error}"),
        };
        let back = match parse_layout(&file) {
            Ok(back) => back,
            Err(error) => panic!("{error}\n{file}"),
        };
        assert_eq!(back, as_layout(&tab), "{file}");
        assert_eq!(back.focus, Some(1));
        // Saving what was read gives the same file, byte for byte.
        assert_eq!(write_layout(&back).as_deref(), Ok(file.as_str()));
        // Sizes in the file are out of a thousand, and never squeeze a pane out.
        assert!((file_ratio(0.3712) - 0.371).abs() < 1e-6);
        assert!((file_ratio(0.99) - 0.95).abs() < 1e-6);
    }

    #[test]
    fn a_layout_with_a_title_names_its_tab() {
        let untitled = parse_layout("[[panes]]\nid = \"a\"\n");
        assert_eq!(
            untitled.map(|tab| (tab.title, tab.named)),
            Ok((String::from("layout"), false))
        );
        let titled = parse_layout("title = \"api\"\n[[panes]]\nid = \"a\"\n");
        assert_eq!(
            titled.map(|tab| (tab.title, tab.named)),
            Ok((String::from("api"), true))
        );
    }

    #[test]
    fn a_workspace_round_trips_through_json() {
        let tab = parse_layout(DEMO).ok();
        let workspace = Workspace {
            version: WORKSPACE_VERSION,
            tabs: tab.into_iter().collect(),
            active: 0,
        };
        let json = serde_json::to_string(&workspace).unwrap_or_default();
        let back: Option<Workspace> = serde_json::from_str(&json).ok();
        assert_eq!(back, Some(workspace));
    }
}
