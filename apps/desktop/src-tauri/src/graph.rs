//! Reads a notes vault that uses the Discourse Graphs plugin for Obsidian.
//!
//! A vault is a directory of Markdown notes. A note is a graph node when its
//! frontmatter names a node type and an instance id. Relations between nodes
//! live in one JSON file at the vault root. Node and relation types come from
//! the plugin's settings file. A canvas is a note that embeds a drawing of
//! nodes and relations with saved positions.
//!
//! The relations file is the record of what relates to what. A canvas's
//! arrows are part of its drawing and are reported with the canvas only.
//!
//! Nothing here writes to the vault.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::startup::expand_home;

const SETTINGS_PATH: &str = ".obsidian/plugins/discourse-graphs/data.json";
const RELATIONS_FILE: &str = "relations.json";
const NOTE_SUFFIX: &str = ".md";
/// Directories that never hold notes. Directories whose name starts with a
/// dot are skipped as well.
const SKIPPED_DIRS: [&str; 2] = ["node_modules", ".trash"];
/// Holds the patterns new notes are made from, which are not notes
/// themselves. Matched without regard to case.
const TEMPLATES_DIR: &str = "templates";
/// Starts the id of a node whose note has no instance id yet.
const PATH_ID_PREFIX: &str = "path:";
const BLOCK_REF_PREFIX: &str = "asset:obsidian.blockref.";

/// A vault with more notes than this is read up to the limit and marked as
/// cut short.
const MAX_NOTES: usize = 20_000;
const MAX_DEPTH: usize = 32;
/// How much of a note is read for its frontmatter, which sits at the very
/// top.
const FRONTMATTER_BYTES: u64 = 16 * 1024;
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CANVAS_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CANVASES: usize = 200;
/// The canvas text read in one pass over a vault, all canvases together.
const MAX_CANVAS_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
/// The files and folders looked at in one walk of a vault, notes or not.
/// A walk runs every few seconds, so its cost must not grow with a vault
/// that is full of other files.
const MAX_ENTRIES: usize = 100_000;
/// The candidate tags searched for. Every line with a `#` is checked
/// against each one.
const MAX_TAG_RULES: usize = 64;
/// A note over this size is not searched for candidate tags.
const CANDIDATE_BYTES: u64 = 512 * 1024;
/// Once this much text has been searched for candidate tags, the rest of
/// the notes are read for their frontmatter only.
const CANDIDATE_BUDGET: u64 = 96 * 1024 * 1024;
const MAX_CANDIDATES: usize = 2_000;
const MAX_CANDIDATE_CHARS: usize = 300;
const MAX_ISSUES: usize = 500;

const CANVAS_START: &str = "```json !!!_START_OF_TLDRAW_DG_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!";
const CANVAS_END: &str = "!!!_END_OF_TLDRAW_DG_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!";
const DEFAULT_NODE_WIDTH: f64 = 200.0;
const DEFAULT_NODE_HEIGHT: f64 = 100.0;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeType {
    id: String,
    name: String,
    /// The naming pattern for notes of this type, such as `QUE - {content}`.
    format: String,
    /// A hex colour. Missing when the settings give none.
    color: Option<String>,
    /// The tag, without its `#`, that marks a line as a candidate for a
    /// node of this type. Missing when the settings give none.
    tag: Option<String>,
}

/// One row of the settings' list of which node types a relation type may
/// join, and which way round.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllowedRelation {
    source_type_id: String,
    destination_type_id: String,
    relation_type_id: String,
}

/// A line in a note that carries a node type's candidate tag.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// The absolute path of the note the line is in.
    path: String,
    /// The line's number in the note, counted from 1.
    line: usize,
    /// The line, trimmed and cut to a fixed length.
    text: String,
    type_id: String,
}

/// Something in the vault that a reader should look at.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// `sharedId`, `skippedRelation`, `file`, `limit` or `more`.
    kind: &'static str,
    text: String,
    /// The absolute path of the note the row is about, when there is one.
    path: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationType {
    id: String,
    label: String,
    /// The label read from the far end, such as `is supported by`.
    complement: String,
    /// A colour name from the canvas palette, such as `light-blue`.
    color: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    /// The note's instance id, which relations refer to. When several notes
    /// carry the same instance id, the first in path order keeps it and the
    /// others get `#2`, `#3` and so on added, so every node id is unique.
    /// The plugin writes the instance id late, so a note may have none yet:
    /// its id is then `path:` followed by its absolute path.
    id: String,
    type_id: String,
    /// The note's file name without its extension.
    title: String,
    /// The note's absolute path.
    path: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    id: String,
    type_id: String,
    /// The instance id of the node the relation starts at.
    source: String,
    /// The instance id of the node the relation points to.
    destination: String,
    /// True when an end names an instance id that several notes share. The
    /// relation is attached to the first of them, which may be the wrong one.
    ambiguous: bool,
    /// The relation's own `tentative` entry, when it has one.
    tentative: Option<bool>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPage {
    id: String,
    name: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    /// The shape id, unique within the canvas.
    id: String,
    page_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// The canvas size step of the box's text: `s`, `m`, `l` or `xl`.
    size: String,
    /// The file name, without extension, of the note the box stands for.
    /// When the note cannot be found, the title the canvas last saved.
    title: String,
    type_id: String,
    /// The absolute path of the note the box stands for, when it is found.
    path: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasRelation {
    id: String,
    page_id: String,
    type_id: String,
    label: String,
    /// The shape id of the box the arrow starts at.
    source: String,
    /// The shape id of the box the arrow points to.
    destination: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasText {
    id: String,
    page_id: String,
    x: f64,
    y: f64,
    /// The width the text wraps at, before `scale`. Zero when the text
    /// sets its own width and so wraps nowhere.
    w: f64,
    /// The canvas size step: `s`, `m`, `l` or `xl`.
    size: String,
    scale: f64,
    text: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    /// The canvas file's name without its extension.
    name: String,
    path: String,
    pages: Vec<CanvasPage>,
    nodes: Vec<CanvasNode>,
    relations: Vec<CanvasRelation>,
    texts: Vec<CanvasText>,
    /// Relation arrows that are not attached to a box at both ends.
    unbound_relations: usize,
    /// Shapes of kinds this reader does not draw, such as images.
    other_shapes: usize,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultGraph {
    /// The vault directory as resolved: home expanded, made absolute.
    directory: String,
    /// Set when the directory holds no graph data at all. Says what was
    /// looked for.
    message: Option<String>,
    /// Things that could not be read. The rest of the graph is still given.
    warnings: Vec<String>,
    /// True when the vault has more notes than are read.
    truncated: bool,
    /// True when a file could not be read or parsed, as happens while
    /// another program is half way through writing it. Worth asking again.
    incomplete: bool,
    node_types: Vec<NodeType>,
    relation_types: Vec<RelationType>,
    allowed_relations: Vec<AllowedRelation>,
    nodes: Vec<Node>,
    relations: Vec<Relation>,
    /// Relations left out because an end names no note, or the entry is
    /// malformed.
    skipped_relations: usize,
    /// Notes whose instance id another note already uses.
    repeated_ids: usize,
    canvases: Vec<Canvas>,
    /// Lines that carry a node type's candidate tag, in path then line order.
    candidates: Vec<Candidate>,
    /// What was left out or may be wrong, one row per note, relation or file.
    issues: Vec<Issue>,
}

#[derive(Debug)]
struct NoteFile {
    path: PathBuf,
    size: u64,
    modified_ms: u64,
}

#[derive(Debug)]
struct Walk {
    notes: Vec<NoteFile>,
    truncated: bool,
    /// The walk stopped at the limit on files and folders, not on notes.
    entries_cut: bool,
}

/// How much of a vault one pass reads.
#[derive(Debug, Clone, Copy)]
struct Limits {
    notes: usize,
    entries: usize,
    canvas_bytes: u64,
}

const LIMITS: Limits = Limits {
    notes: MAX_NOTES,
    entries: MAX_ENTRIES,
    canvas_bytes: MAX_CANVAS_TOTAL_BYTES,
};

#[derive(Debug, Default, PartialEq)]
struct Frontmatter {
    node_type_id: Option<String>,
    node_instance_id: Option<String>,
    canvas: bool,
}

#[derive(Debug, Default)]
struct Settings {
    node_types: Vec<NodeType>,
    relation_types: Vec<RelationType>,
    allowed_relations: Vec<AllowedRelation>,
}

fn resolve(path: &str) -> String {
    let home = std::env::var("HOME").ok();
    expand_home(path, home.as_deref())
}

fn text_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.')
        || SKIPPED_DIRS.contains(&name)
        || name.eq_ignore_ascii_case(TEMPLATES_DIR)
}

/// Finds the notes under `root`, in a fixed order, stopping at the limit
/// on notes or on files and folders looked at, whichever comes first.
/// A linked directory is not entered, so a link back up the tree cannot
/// make the walk run for ever.
fn walk(root: &Path, limits: Limits) -> Walk {
    let mut notes = Vec::new();
    let mut visited = 0_usize;
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        // One more than there is room for, to see that the room ran out.
        let room = limits.entries.saturating_sub(visited);
        let mut entries: Vec<fs::DirEntry> =
            entries.filter_map(Result::ok).take(room + 1).collect();
        let entries_cut = entries.len() > room;
        entries.truncate(room);
        visited += entries.len();
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut subdirs = Vec::new();
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !is_skipped_dir(&name) {
                    subdirs.push(entry.path());
                }
                continue;
            }
            if !name.ends_with(NOTE_SUFFIX) {
                continue;
            }
            // Follows a link to a file, so a linked note still counts.
            let Ok(metadata) = fs::metadata(entry.path()) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            if notes.len() >= limits.notes {
                return Walk {
                    notes,
                    truncated: true,
                    entries_cut: false,
                };
            }
            notes.push(NoteFile {
                path: entry.path(),
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        }
        if entries_cut {
            return Walk {
                notes,
                truncated: true,
                entries_cut: true,
            };
        }
        // Popped from the end, so pushed in reverse to visit in name order.
        pending.extend(subdirs.into_iter().rev().map(|path| (path, depth + 1)));
    }
    Walk {
        notes,
        truncated: false,
        entries_cut: false,
    }
}

/// Reads a whole file unless it is over `limit`. A missing file is `None`.
fn read_capped(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    if metadata.len() > limit {
        return Err(format!(
            "{} is {} bytes, over the {limit} byte limit",
            path.display(),
            metadata.len()
        ));
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// The value of a one-line frontmatter entry, without quotes. `None` when
/// nothing follows the colon on the same line.
fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    let unquoted = ['"', '\'']
        .iter()
        .find_map(|quote| {
            value
                .strip_prefix(*quote)
                .and_then(|rest| rest.strip_suffix(*quote))
        })
        .unwrap_or(value)
        .trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

/// Picks the three entries this reader cares about out of a note's
/// frontmatter. It is not a YAML parser: it reads top-level `key: value`
/// lines and nothing else.
fn parse_frontmatter(head: &str) -> Frontmatter {
    let mut found = Frontmatter::default();
    let mut lines = head.strip_prefix('\u{feff}').unwrap_or(head).lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return found;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" || line == "..." {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key {
            "nodeTypeId" => found.node_type_id = scalar(value),
            "nodeInstanceId" => found.node_instance_id = scalar(value),
            "tldr-dg" => found.canvas = scalar(value).as_deref() == Some("true"),
            _ => {}
        }
    }
    found
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn number_field(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn list_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Copies the node types and relation types out of the plugin's settings.
/// The same file holds account details, so nothing else is copied and the
/// parsed file never leaves this function.
fn settings_from(bytes: &[u8]) -> Result<Settings, String> {
    // The parser's own message can quote the file, so only the position
    // of the fault is reported.
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        format!(
            "the plugin settings are not valid JSON (line {}, column {})",
            error.line(),
            error.column()
        )
    })?;
    let node_types = list_field(&value, "nodeTypes")
        .iter()
        .filter_map(|entry| {
            let id = string_field(entry, "id")?;
            Some(NodeType {
                name: string_field(entry, "name").unwrap_or_else(|| id.clone()),
                format: string_field(entry, "format").unwrap_or_default(),
                color: string_field(entry, "color"),
                tag: string_field(entry, "tag")
                    .map(|tag| tag.trim_start_matches('#').to_string())
                    .filter(|tag| !tag.is_empty()),
                id,
            })
        })
        .collect();
    let relation_types = list_field(&value, "relationTypes")
        .iter()
        .filter_map(|entry| {
            let id = string_field(entry, "id")?;
            Some(RelationType {
                label: string_field(entry, "label").unwrap_or_else(|| id.clone()),
                complement: string_field(entry, "complement").unwrap_or_default(),
                color: string_field(entry, "color"),
                id,
            })
        })
        .collect();
    let allowed_relations = list_field(&value, "discourseRelations")
        .iter()
        .filter_map(|entry| {
            Some(AllowedRelation {
                source_type_id: string_field(entry, "sourceId")?,
                destination_type_id: string_field(entry, "destinationId")?,
                relation_type_id: string_field(entry, "relationshipTypeId")?,
            })
        })
        .collect();
    Ok(Settings {
        node_types,
        relation_types,
        allowed_relations,
    })
}

#[derive(Default)]
struct Resolved {
    relations: Vec<Relation>,
    skipped: usize,
    /// One line per relation left out, saying what it points at.
    skipped_notes: Vec<String>,
}

/// Names one end of a relation that was left out: the note's title when a
/// note carries the id, and otherwise the id, marked as unknown.
fn end_text(end: Option<&str>, titles: &HashMap<&str, &str>) -> String {
    match end {
        None => String::from("nothing"),
        Some(id) => match titles.get(id) {
            Some(title) => format!("\"{title}\""),
            None => format!("unknown id {id}"),
        },
    }
}

/// Keeps the relations whose two ends are both known nodes. `titles` has
/// the title of the note that holds each instance id. `shared` holds the
/// instance ids that more than one note carries.
fn resolve_relations(
    bytes: &[u8],
    titles: &HashMap<&str, &str>,
    shared: &HashSet<&str>,
    labels: &HashMap<&str, &str>,
) -> Result<Resolved, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        format!(
            "{RELATIONS_FILE} is not valid JSON (line {}, column {})",
            error.line(),
            error.column()
        )
    })?;
    let mut relations = Vec::new();
    let mut skipped = 0;
    let mut skipped_notes = Vec::new();
    let entries = value.get("relations").and_then(Value::as_object);
    for (key, entry) in entries.into_iter().flatten() {
        let ends = (
            string_field(entry, "type"),
            string_field(entry, "source"),
            string_field(entry, "destination"),
        );
        match ends {
            (Some(type_id), Some(source), Some(destination))
                if titles.contains_key(source.as_str())
                    && titles.contains_key(destination.as_str()) =>
            {
                relations.push(Relation {
                    id: string_field(entry, "id").unwrap_or_else(|| key.clone()),
                    ambiguous: shared.contains(source.as_str())
                        || shared.contains(destination.as_str()),
                    tentative: entry.get("tentative").and_then(Value::as_bool),
                    type_id,
                    source,
                    destination,
                });
            }
            (type_id, source, destination) => {
                skipped += 1;
                let kind = match type_id.as_deref() {
                    Some(id) => labels.get(id).copied().unwrap_or(id),
                    None => "a relation with no type",
                };
                skipped_notes.push(format!(
                    "Relation {key}: {kind}, from {} to {}",
                    end_text(source.as_deref(), titles),
                    end_text(destination.as_deref(), titles)
                ));
            }
        }
    }
    relations.sort_by(|a, b| a.id.cmp(&b.id));
    skipped_notes.sort();
    Ok(Resolved {
        relations,
        skipped,
        skipped_notes,
    })
}

/// Finds a note from the text of a link to it.
#[derive(Default)]
struct NoteIndex {
    by_stem: HashMap<String, String>,
    by_relative: HashMap<String, String>,
}

impl NoteIndex {
    fn new(root: &Path, notes: &[NoteFile]) -> Self {
        let mut index = Self::default();
        for note in notes {
            let path = text_of(&note.path);
            if let Some(stem) = note.path.file_stem() {
                // The first note in path order keeps a name that repeats.
                index
                    .by_stem
                    .entry(stem.to_string_lossy().into_owned())
                    .or_insert_with(|| path.clone());
            }
            let relative = note.path.strip_prefix(root).unwrap_or(&note.path);
            let relative = text_of(relative);
            let relative = relative.strip_suffix(NOTE_SUFFIX).unwrap_or(&relative);
            index.by_relative.insert(relative.to_string(), path);
        }
        index
    }

    /// A link names a note by its path from the vault root, or by the
    /// shortest text that still picks it out, which is often the bare name.
    fn resolve(&self, link: &str) -> Option<&str> {
        let link = link.trim().trim_start_matches('/');
        let link = link.strip_suffix(NOTE_SUFFIX).unwrap_or(link);
        let name = link.rsplit('/').next().unwrap_or(link);
        self.by_relative
            .get(link)
            .or_else(|| self.by_stem.get(name))
            .map(String::as_str)
    }
}

fn stem_of(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The note a line links to: the text of its first `[[link]]`, without any
/// `|alias` or `#heading`.
fn link_target(line: &str) -> Option<String> {
    let (_, rest) = line.split_once("[[")?;
    let (inner, _) = rest.split_once("]]")?;
    let target = inner.split(['|', '#']).next()?.trim();
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

/// A canvas note lists the notes its boxes stand for as a link with a block
/// id on the line below it. This maps each block id to its link's target.
/// The list may sit before or after the embedded drawing.
fn block_links(text: &str) -> HashMap<String, String> {
    let mut links = HashMap::new();
    let mut previous = "";
    let mut in_data = false;
    for line in text.lines() {
        let line = line.trim();
        if in_data {
            if line.starts_with(CANVAS_END) {
                in_data = false;
                previous = "";
            }
            continue;
        }
        if line == CANVAS_START {
            in_data = true;
            continue;
        }
        if let Some(block) = line.strip_prefix('^') {
            if let Some(target) = link_target(previous) {
                links.insert(block.trim().to_string(), target);
            }
        }
        previous = line;
    }
    links
}

/// The JSON a canvas note embeds, between its two marker lines.
fn canvas_json(text: &str) -> Option<&str> {
    let mut offset = 0;
    let mut start = None;
    for line in text.split_inclusive('\n') {
        match start {
            None if line.trim_end() == CANVAS_START => start = Some(offset + line.len()),
            Some(start) if line.starts_with(CANVAS_END) => return text.get(start..offset),
            _ => {}
        }
        offset += line.len();
    }
    None
}

const BLOCK_KINDS: [&str; 6] = [
    "paragraph",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "blockquote",
];

/// Flattens a rich-text document to plain text, one line per block.
fn flatten_rich_text(node: &Value, out: &mut String) {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    if BLOCK_KINDS.contains(&kind) && !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if kind == "hardBreak" {
        out.push('\n');
    }
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        out.push_str(text);
    }
    for child in list_field(node, "content") {
        flatten_rich_text(child, out);
    }
}

fn text_of_shape(props: &Value) -> String {
    let mut text = String::new();
    if let Some(rich) = props.get("richText") {
        flatten_rich_text(rich, &mut text);
    } else if let Some(plain) = props.get("text").and_then(Value::as_str) {
        text.push_str(plain);
    }
    text.trim().to_string()
}

/// The page a shape sits on directly. A shape inside a group or frame has
/// positions relative to its parent, which this reader does not work out.
fn page_of(record: &Value) -> Option<String> {
    string_field(record, "parentId").filter(|parent| parent.starts_with("page:"))
}

/// What a canvas note says about its boxes outside the drawing itself.
struct CanvasLinks<'a> {
    blocks: HashMap<String, String>,
    notes: &'a NoteIndex,
}

impl CanvasLinks<'_> {
    /// The note a box stands for. The box's `src` names a block in the
    /// canvas note, and the link above that block names the note. The title
    /// saved on the box is a copy that can be out of date, so it is only
    /// tried when the block cannot be followed.
    fn note_for(&self, props: &Value) -> Option<&str> {
        let linked = string_field(props, "src")
            .as_deref()
            .and_then(|src| src.strip_prefix(BLOCK_REF_PREFIX))
            .and_then(|block| self.blocks.get(block))
            .and_then(|link| self.notes.resolve(link));
        linked.or_else(|| {
            string_field(props, "title")
                .as_deref()
                .and_then(|title| self.notes.resolve(title))
        })
    }
}

/// Copies the named entries of a box and nothing else. A box can also hold
/// the path of an image on the machine that drew it, which stays behind.
fn canvas_node(record: &Value, links: &CanvasLinks) -> Option<CanvasNode> {
    let props = record.get("props")?;
    let path = links.note_for(props).map(str::to_string);
    let title = match &path {
        Some(path) => stem_of(path),
        None => string_field(props, "title")?,
    };
    Some(CanvasNode {
        id: string_field(record, "id")?,
        page_id: page_of(record)?,
        x: number_field(record, "x")?,
        y: number_field(record, "y")?,
        w: number_field(props, "w").unwrap_or(DEFAULT_NODE_WIDTH),
        h: number_field(props, "h").unwrap_or(DEFAULT_NODE_HEIGHT),
        size: string_field(props, "size").unwrap_or_else(|| String::from("s")),
        title,
        type_id: string_field(props, "nodeTypeId").unwrap_or_default(),
        path,
    })
}

fn canvas_text(record: &Value) -> Option<CanvasText> {
    let props = record.get("props")?;
    let text = text_of_shape(props);
    if text.is_empty() {
        return None;
    }
    // A text that sizes itself keeps a width too, but it is not one the
    // drawing wraps at.
    let fixed = props.get("autoSize").and_then(Value::as_bool) == Some(false);
    let width = if fixed {
        number_field(props, "w").unwrap_or(0.0)
    } else {
        0.0
    };
    Some(CanvasText {
        id: string_field(record, "id")?,
        page_id: page_of(record)?,
        x: number_field(record, "x")?,
        y: number_field(record, "y")?,
        w: width,
        size: string_field(props, "size").unwrap_or_else(|| String::from("m")),
        scale: number_field(props, "scale").unwrap_or(1.0),
        text,
    })
}

struct Arrow {
    id: String,
    type_id: String,
    label: String,
}

#[derive(Default)]
struct Ends {
    start: Option<String>,
    end: Option<String>,
}

/// The records of a drawing. Older canvases hold a list, newer ones an
/// object keyed by record id.
fn records_of(value: &Value) -> Option<Vec<&Value>> {
    match value.get("raw")?.get("records")? {
        Value::Array(list) => Some(list.iter().collect()),
        Value::Object(map) => Some(map.values().collect()),
        _ => None,
    }
}

fn parse_canvas(path: &Path, text: &str, notes: &NoteIndex) -> Result<Canvas, String> {
    let shown = path.display();
    let json = canvas_json(text).ok_or_else(|| format!("{shown}: no canvas data block found"))?;
    let value: Value = serde_json::from_str(json).map_err(|error| {
        format!(
            "{shown}: the canvas data is not valid JSON (line {}, column {})",
            error.line(),
            error.column()
        )
    })?;
    let records =
        records_of(&value).ok_or_else(|| format!("{shown}: the canvas data has no records"))?;
    let links = CanvasLinks {
        blocks: block_links(text),
        notes,
    };

    let mut pages: Vec<(String, CanvasPage)> = Vec::new();
    let mut nodes = Vec::new();
    let mut texts = Vec::new();
    let mut arrows = Vec::new();
    let mut ends: HashMap<String, Ends> = HashMap::new();
    let mut other_shapes = 0;

    for record in records {
        let type_name = record.get("typeName").and_then(Value::as_str);
        let kind = record.get("type").and_then(Value::as_str);
        match (type_name, kind) {
            (Some("page"), _) => {
                if let Some(id) = string_field(record, "id") {
                    let index = string_field(record, "index").unwrap_or_default();
                    let name = string_field(record, "name").unwrap_or_else(|| id.clone());
                    pages.push((index, CanvasPage { id, name }));
                }
            }
            (Some("shape"), Some("discourse-node")) => match canvas_node(record, &links) {
                Some(node) => nodes.push(node),
                None => other_shapes += 1,
            },
            (Some("shape"), Some("discourse-relation")) => {
                if let Some(id) = string_field(record, "id") {
                    let props = record.get("props").unwrap_or(&Value::Null);
                    arrows.push(Arrow {
                        id,
                        type_id: string_field(props, "relationTypeId").unwrap_or_default(),
                        label: string_field(props, "text").unwrap_or_default(),
                    });
                }
            }
            (Some("shape"), Some("text")) => {
                // A text box with nothing in it draws nothing, so it is
                // not counted as left out either.
                if let Some(text) = canvas_text(record) {
                    texts.push(text);
                }
            }
            (Some("shape"), _) => other_shapes += 1,
            (Some("binding"), Some("discourse-relation")) => {
                let from = string_field(record, "fromId");
                let to = string_field(record, "toId");
                let terminal = record
                    .get("props")
                    .and_then(|props| props.get("terminal"))
                    .and_then(Value::as_str);
                if let (Some(from), Some(to)) = (from, to) {
                    let entry = ends.entry(from).or_default();
                    match terminal {
                        Some("start") => entry.start = Some(to),
                        Some("end") => entry.end = Some(to),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    let page_of_node: HashMap<&str, &str> = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.page_id.as_str()))
        .collect();
    let mut relations = Vec::new();
    let mut unbound_relations = 0;
    for arrow in arrows {
        let bound = ends.get(&arrow.id).and_then(|ends| {
            let source = ends.start.as_deref()?;
            let destination = ends.end.as_deref()?;
            let page = page_of_node.get(source)?;
            page_of_node.get(destination)?;
            Some((source, destination, *page))
        });
        match bound {
            Some((source, destination, page)) => relations.push(CanvasRelation {
                page_id: page.to_string(),
                type_id: arrow.type_id,
                label: arrow.label,
                source: source.to_string(),
                destination: destination.to_string(),
                id: arrow.id,
            }),
            None => unbound_relations += 1,
        }
    }

    // An object of records has no order of its own, so everything is put
    // in one: pages by their saved position, the rest by id.
    pages.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    texts.sort_by(|a, b| a.id.cmp(&b.id));
    relations.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Canvas {
        name: path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: text_of(path),
        pages: pages.into_iter().map(|(_, page)| page).collect(),
        nodes,
        relations,
        texts,
        unbound_relations,
        other_shapes,
    })
}

fn read_canvas(note: &NoteFile, notes: &NoteIndex) -> Result<Canvas, String> {
    if note.size > MAX_CANVAS_BYTES {
        return Err(format!(
            "{} is {} bytes, over the {MAX_CANVAS_BYTES} byte limit for a canvas",
            note.path.display(),
            note.size
        ));
    }
    let text = fs::read_to_string(&note.path)
        .map_err(|error| format!("{}: {error}", note.path.display()))?;
    parse_canvas(&note.path, &text, notes)
}

fn open_vault(dir: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(dir).map_err(|error| format!("{dir}: {error}"))?;
    if !root.is_dir() {
        return Err(format!("{dir} is not a directory"));
    }
    Ok(root)
}

fn is_tag_char(letter: char) -> bool {
    letter.is_alphanumeric() || matches!(letter, '_' | '-' | '/')
}

/// Whether a line carries `#tag` as a whole tag. Both are lower case. A
/// tag does not start in the middle of a word or of a web address, or
/// straight after a backtick, and it ends where the tag's letters end.
fn has_tag(line: &str, tag: &str) -> bool {
    let mut from = 0;
    while let Some(found) = line[from..].find('#') {
        let at = from + found;
        let rest = &line[at + 1..];
        if let Some(after) = rest.strip_prefix(tag) {
            let opens = line[..at]
                .chars()
                .next_back()
                .is_none_or(|before| !(before.is_alphanumeric() || "_/#`".contains(before)));
            let closes = after.chars().next().is_none_or(|next| !is_tag_char(next));
            if opens && closes {
                return true;
            }
        }
        from = at + 1;
    }
    false
}

/// A candidate tag, in lower case, with the id of the node type it marks.
struct TagRule<'a> {
    tag: String,
    type_id: &'a str,
}

/// Adds the lines of one note that carry a candidate tag, up to the limit.
fn find_candidates(path: &str, text: &str, rules: &[TagRule], out: &mut Vec<Candidate>) {
    if !text.contains('#') {
        return;
    }
    for (index, line) in text.lines().enumerate() {
        if !line.contains('#') {
            continue;
        }
        let lower = line.to_lowercase();
        for rule in rules {
            if !has_tag(&lower, &rule.tag) {
                continue;
            }
            if out.len() >= MAX_CANDIDATES {
                return;
            }
            out.push(Candidate {
                path: path.to_string(),
                line: index + 1,
                text: line.trim().chars().take(MAX_CANDIDATE_CHARS).collect(),
                type_id: rule.type_id.to_string(),
            });
        }
    }
}

/// Reads the first `limit` bytes of a file.
fn read_bytes(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn file_issue(text: &str) -> Issue {
    Issue {
        kind: "file",
        text: text.to_string(),
        path: None,
    }
}

/// The note that first carried an instance id, and how many carry it.
struct Holder {
    count: usize,
    first: usize,
}

fn read_graph_with(dir: &str, limits: Limits) -> Result<VaultGraph, String> {
    let root = open_vault(dir)?;
    let mut warnings = Vec::new();
    let mut issues = Vec::new();
    let mut incomplete = false;

    let settings_bytes =
        read_capped(&root.join(SETTINGS_PATH), MAX_JSON_BYTES).unwrap_or_else(|_| {
            warnings.push(String::from("the plugin settings could not be read"));
            incomplete = true;
            None
        });
    let has_settings = settings_bytes.is_some();
    let settings = match settings_bytes.as_deref().map(settings_from) {
        Some(Ok(settings)) => Some(settings),
        Some(Err(error)) => {
            warnings.push(error);
            incomplete = true;
            None
        }
        None => None,
    };
    issues.extend(warnings.iter().map(|warning| file_issue(warning)));
    // With no settings to go by, every typed note is taken as a node.
    let configured: Option<HashSet<&str>> = settings.as_ref().map(|settings| {
        settings
            .node_types
            .iter()
            .map(|node_type| node_type.id.as_str())
            .collect()
    });
    let mut rules: Vec<TagRule> = settings
        .iter()
        .flat_map(|settings| &settings.node_types)
        .filter_map(|node_type| {
            Some(TagRule {
                tag: node_type.tag.as_ref()?.to_lowercase(),
                type_id: &node_type.id,
            })
        })
        .collect();
    if rules.len() > MAX_TAG_RULES {
        issues.push(Issue {
            kind: "limit",
            text: format!(
                "the settings give {} node types a candidate tag, so only the first \
                 {MAX_TAG_RULES} were searched for",
                rules.len()
            ),
            path: None,
        });
        rules.truncate(MAX_TAG_RULES);
    }

    let found = walk(&root, limits);
    if found.truncated {
        let text = if found.entries_cut {
            format!(
                "this vault has more than {} files and folders, so the rest were not read",
                limits.entries
            )
        } else {
            let note_limit = limits.notes;
            format!(
                "this vault has more than {note_limit} notes, so only the first {note_limit} \
                 were read"
            )
        };
        issues.push(Issue {
            kind: "limit",
            text: text.clone(),
            path: None,
        });
        warnings.push(text);
    }
    let index = NoteIndex::new(&root, &found.notes);

    let mut nodes: Vec<Node> = Vec::new();
    let mut canvases = Vec::new();
    let mut candidates = Vec::new();
    let mut shared_issues = Vec::new();
    let mut holders: HashMap<String, Holder> = HashMap::new();
    let mut budget = CANDIDATE_BUDGET;
    let mut unsearched = 0_usize;
    let mut canvas_budget = limits.canvas_bytes;
    let mut canvases_unread = 0_usize;
    for note in &found.notes {
        // The whole note is read only when it is to be searched for
        // candidate tags. Otherwise the top is enough.
        let search = !rules.is_empty()
            && note.size <= CANDIDATE_BYTES.min(budget)
            && candidates.len() < MAX_CANDIDATES;
        let limit = if search {
            CANDIDATE_BYTES
        } else {
            FRONTMATTER_BYTES
        };
        let Ok(bytes) = read_bytes(&note.path, limit) else {
            continue;
        };
        let top = usize::try_from(FRONTMATTER_BYTES)
            .unwrap_or(usize::MAX)
            .min(bytes.len());
        let frontmatter = parse_frontmatter(&String::from_utf8_lossy(&bytes[..top]));
        if frontmatter.canvas {
            // A canvas over the limit for one canvas is not read at all, so
            // it takes nothing from what is left for the others.
            let fits_alone = note.size <= MAX_CANVAS_BYTES;
            if canvases.len() >= MAX_CANVASES || (fits_alone && note.size > canvas_budget) {
                canvases_unread += 1;
                continue;
            }
            if fits_alone {
                canvas_budget -= note.size;
            }
            match read_canvas(note, &index) {
                Ok(canvas) => canvases.push(canvas),
                Err(error) => {
                    issues.push(file_issue(&error));
                    warnings.push(error);
                    incomplete = true;
                }
            }
            continue;
        }
        let path = text_of(&note.path);
        if search {
            budget = budget.saturating_sub(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
            find_candidates(
                &path,
                &String::from_utf8_lossy(&bytes),
                &rules,
                &mut candidates,
            );
        } else if !rules.is_empty() {
            unsearched += 1;
        }
        let Some(type_id) = frontmatter.node_type_id else {
            continue;
        };
        if configured
            .as_ref()
            .is_some_and(|configured| !configured.contains(type_id.as_str()))
        {
            continue;
        }
        let title = stem_of(&path);
        let id = match frontmatter.node_instance_id {
            Some(id) => {
                let holder = holders.entry(id.clone()).or_insert(Holder {
                    count: 0,
                    first: nodes.len(),
                });
                holder.count += 1;
                if holder.count == 1 {
                    id
                } else {
                    let first = nodes.get(holder.first).map_or("", |node| &node.title);
                    shared_issues.push(Issue {
                        kind: "sharedId",
                        text: format!("\"{title}\" carries the same instance id as \"{first}\""),
                        path: Some(path.clone()),
                    });
                    format!("{id}#{}", holder.count)
                }
            }
            None => format!("{PATH_ID_PREFIX}{path}"),
        };
        nodes.push(Node {
            id,
            type_id,
            title,
            path,
        });
    }
    if unsearched > 0 {
        issues.push(Issue {
            kind: "limit",
            text: format!(
                "{unsearched} notes were not searched for candidates: each is over \
                 {CANDIDATE_BYTES} bytes, or a search limit was reached before it"
            ),
            path: None,
        });
    }
    if canvases_unread > 0 {
        issues.push(Issue {
            kind: "limit",
            text: format!(
                "{canvases_unread} canvases were not read: at most {MAX_CANVASES} canvases \
                 and {} bytes of canvas text are read from one vault",
                limits.canvas_bytes
            ),
            path: None,
        });
    }
    let repeated_ids: usize = holders.values().map(|holder| holder.count - 1).sum();
    if repeated_ids > 0 {
        warnings.push(format!(
            "{repeated_ids} notes share an instance id with an earlier note, so relations \
             to those ids may be drawn to the wrong note"
        ));
    }
    issues.append(&mut shared_issues);

    let titles: HashMap<&str, &str> = holders
        .iter()
        .filter_map(|(id, holder)| Some((id.as_str(), nodes.get(holder.first)?.title.as_str())))
        .collect();
    let shared: HashSet<&str> = holders
        .iter()
        .filter(|(_, holder)| holder.count > 1)
        .map(|(id, _)| id.as_str())
        .collect();
    let labels: HashMap<&str, &str> = settings
        .iter()
        .flat_map(|settings| &settings.relation_types)
        .map(|relation_type| (relation_type.id.as_str(), relation_type.label.as_str()))
        .collect();
    let relation_bytes =
        read_capped(&root.join(RELATIONS_FILE), MAX_JSON_BYTES).unwrap_or_else(|error| {
            issues.push(file_issue(&error));
            warnings.push(error);
            incomplete = true;
            None
        });
    let has_relations = relation_bytes.is_some();
    let resolved = match relation_bytes
        .as_deref()
        .map(|bytes| resolve_relations(bytes, &titles, &shared, &labels))
    {
        Some(Ok(resolved)) => resolved,
        Some(Err(error)) => {
            issues.push(file_issue(&error));
            warnings.push(error);
            incomplete = true;
            Resolved::default()
        }
        None => Resolved::default(),
    };
    issues.extend(resolved.skipped_notes.into_iter().map(|text| Issue {
        kind: "skippedRelation",
        text,
        path: None,
    }));
    if issues.len() > MAX_ISSUES {
        let more = issues.len() - MAX_ISSUES;
        issues.truncate(MAX_ISSUES);
        issues.push(Issue {
            kind: "more",
            text: format!("and {more} more"),
            path: None,
        });
    }

    let empty = !has_settings && !has_relations && nodes.is_empty() && canvases.is_empty();
    let directory = text_of(&root);
    let message = (empty && !incomplete).then(|| {
        format!(
            "No Discourse Graphs data found in {directory}. A vault has notes with \
             nodeTypeId in their frontmatter, a {RELATIONS_FILE} file, or the plugin \
             settings at {SETTINGS_PATH}."
        )
    });
    let settings = settings.unwrap_or_default();

    Ok(VaultGraph {
        directory,
        message,
        warnings,
        truncated: found.truncated,
        incomplete,
        node_types: settings.node_types,
        relation_types: settings.relation_types,
        allowed_relations: settings.allowed_relations,
        nodes,
        relations: resolved.relations,
        skipped_relations: resolved.skipped,
        repeated_ids,
        canvases,
        candidates,
        issues,
    })
}

pub fn read_graph(dir: &str) -> Result<VaultGraph, String> {
    read_graph_with(dir, LIMITS)
}

const HASH_SEED: u64 = 0xcbf2_9ce4_8422_2325;
const HASH_PRIME: u64 = 0x0000_0100_0000_01b3;

fn hash_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(HASH_PRIME);
    }
    hash
}

fn file_mark(name: &str, size: u64, modified_ms: u64) -> u64 {
    let hash = hash_bytes(HASH_SEED, name.as_bytes());
    let hash = hash_bytes(hash, &size.to_le_bytes());
    hash_bytes(hash, &modified_ms.to_le_bytes())
}

/// A short text that changes when the graph may have changed: a note was
/// added, removed, renamed or edited, or the relations or settings file
/// was. It reads file names, sizes and times only, never contents, so it
/// is cheap enough to ask for every few seconds.
pub fn fingerprint(dir: &str) -> Result<String, String> {
    let root = open_vault(dir)?;
    let found = walk(&root, LIMITS);
    let mut sum = 0_u64;
    for note in &found.notes {
        let name = note.path.strip_prefix(&root).unwrap_or(&note.path);
        sum = sum.wrapping_add(file_mark(
            &name.to_string_lossy(),
            note.size,
            note.modified_ms,
        ));
    }
    for extra in [RELATIONS_FILE, SETTINGS_PATH] {
        if let Ok(metadata) = fs::metadata(root.join(extra)) {
            sum = sum.wrapping_add(file_mark(extra, metadata.len(), modified_ms(&metadata)));
        }
    }
    Ok(format!("{}-{sum:016x}", found.notes.len()))
}

#[tauri::command(async)]
pub fn graph_read(path: String) -> Result<VaultGraph, String> {
    read_graph(&resolve(&path))
}

#[tauri::command(async)]
pub fn graph_fingerprint(path: String) -> Result<String, String> {
    fingerprint(&resolve(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, SystemTime};

    const SECRET: &str = "correct-horse-battery-staple";
    const ACCOUNT: &str = "account-1745604720";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("graph-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn write(root: &Path, name: &str, text: &str) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn note(type_id: &str, id: &str) -> String {
        format!("---\nnodeTypeId: {type_id}\nnodeInstanceId: {id}\n---\n\nBody text.\n")
    }

    fn settings_text() -> String {
        json!({
            "nodeTypes": [
                {"id": "node_q", "name": "Question", "format": "QUE - {content}", "color": "#F2C123", "tag": "que"},
                {"id": "node_c", "name": "Claim", "format": "CLM - {content}", "color": "#2E9E82"},
                {"name": "no id, so it is left out"}
            ],
            "relationTypes": [
                {"id": "rel_s", "label": "supports", "complement": "is supported by", "color": "green"},
                {"id": "rel_o", "label": "opposes", "complement": "is opposed by", "color": "red"}
            ],
            "spacePassword": SECRET,
            "accountLocalId": ACCOUNT,
            "spaceNames": {"space": SECRET}
        })
        .to_string()
    }

    fn relations_text() -> String {
        json!({
            "version": 1,
            "relations": {
                "r2": {"id": "r2", "type": "rel_o", "source": "id-c2", "destination": "id-q"},
                "r1": {"id": "r1", "type": "rel_s", "source": "id-c1", "destination": "id-q",
                       "author": "someone", "authorId": 7, "importedFromRid": "x", "created": 1},
                "r3": {"id": "r3", "type": "rel_s", "source": "id-c1", "destination": "id-gone"},
                "r4": {"id": "r4", "type": "rel_s", "source": "id-c1"}
            }
        })
        .to_string()
    }

    fn vault(name: &str) -> PathBuf {
        let root = scratch(name);
        write(&root, SETTINGS_PATH, &settings_text());
        write(&root, RELATIONS_FILE, &relations_text());
        write(&root, "QUE - why.md", &note("node_q", "id-q"));
        write(
            &root,
            "claims/CLM - because.md",
            &note("node_c", "\"id-c1\""),
        );
        write(
            &root,
            "claims/deep/CLM - or not.md",
            &note("node_c", "id-c2"),
        );
        write(&root, "plain.md", "# Just a note\n");
        write(
            &root,
            "junk.md",
            "---\nnodeTypeId:\ntags:\n  - a\nnodeInstanceId: id-junk\n---\n",
        );
        write(
            &root,
            "CLM - no id yet.md",
            "---\nnodeTypeId: node_c\nnodeInstanceId:\ntags: []\n---\n",
        );
        write(&root, "old type.md", &note("node_retired", "id-old"));
        write(&root, "Meta/Templates/Claim.md", &note("node_c", "id-c1"));
        write(&root, "templates/Question.md", &note("node_q", "id-t"));
        write(
            &root,
            ".trash/CLM - binned.md",
            &note("node_c", "id-binned"),
        );
        write(
            &root,
            ".hidden/CLM - hidden.md",
            &note("node_c", "id-hidden"),
        );
        write(
            &root,
            "node_modules/pkg/CLM - vendored.md",
            &note("node_c", "id-vendored"),
        );
        root
    }

    fn titles(graph: &VaultGraph) -> Vec<&str> {
        graph.nodes.iter().map(|node| node.title.as_str()).collect()
    }

    #[test]
    fn reads_nodes_types_and_relations() {
        let root = vault("read");
        let graph = read_graph(root.to_str().unwrap()).unwrap();

        assert_eq!(graph.directory, root.to_str().unwrap());
        assert_eq!(graph.message, None);
        assert!(graph.warnings.is_empty(), "{:?}", graph.warnings);
        assert!(!graph.truncated);
        assert!(!graph.incomplete);
        // Left out: the plain note, the one with no type, the one whose
        // type is not configured, and everything in a templates folder.
        assert_eq!(
            titles(&graph),
            vec![
                "CLM - no id yet",
                "QUE - why",
                "CLM - because",
                "CLM - or not"
            ]
        );
        assert_eq!(graph.repeated_ids, 0);
        // A note the plugin has not given an instance id is still a node.
        let pending = &graph.nodes[0];
        assert_eq!(
            pending.id,
            format!("path:{}", root.join("CLM - no id yet.md").display())
        );
        assert_eq!(pending.type_id, "node_c");
        let because = &graph.nodes[2];
        assert_eq!(because.id, "id-c1");
        assert_eq!(because.type_id, "node_c");
        assert_eq!(
            because.path,
            root.join("claims/CLM - because.md").to_str().unwrap()
        );

        assert_eq!(
            graph.node_types,
            vec![
                NodeType {
                    id: String::from("node_q"),
                    name: String::from("Question"),
                    format: String::from("QUE - {content}"),
                    color: Some(String::from("#F2C123")),
                    tag: Some(String::from("que")),
                },
                NodeType {
                    id: String::from("node_c"),
                    name: String::from("Claim"),
                    format: String::from("CLM - {content}"),
                    color: Some(String::from("#2E9E82")),
                    tag: None,
                },
            ]
        );
        assert_eq!(graph.relation_types.len(), 2);
        assert_eq!(graph.relation_types[0].complement, "is supported by");

        assert_eq!(
            graph.relations,
            vec![
                Relation {
                    id: String::from("r1"),
                    type_id: String::from("rel_s"),
                    source: String::from("id-c1"),
                    destination: String::from("id-q"),
                    ambiguous: false,
                    tentative: None,
                },
                Relation {
                    id: String::from("r2"),
                    type_id: String::from("rel_o"),
                    source: String::from("id-c2"),
                    destination: String::from("id-q"),
                    ambiguous: false,
                    tentative: None,
                },
            ]
        );
        assert_eq!(graph.skipped_relations, 2);
        // Each relation left out is named, with what it points at.
        let skipped: Vec<&str> = graph
            .issues
            .iter()
            .filter(|issue| issue.kind == "skippedRelation")
            .map(|issue| issue.text.as_str())
            .collect();
        assert_eq!(
            skipped,
            vec![
                "Relation r3: supports, from \"CLM - because\" to unknown id id-gone",
                "Relation r4: supports, from \"CLM - because\" to nothing",
            ]
        );
        assert_eq!(graph.issues.len(), 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn account_details_in_the_settings_never_leave() {
        let root = vault("secret");
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        let sent = serde_json::to_string(&graph).unwrap();
        let shown = format!("{graph:?}");
        for text in [&sent, &shown] {
            assert!(!text.contains(SECRET));
            assert!(!text.contains(ACCOUNT));
            assert!(!text.contains("spacePassword"));
            assert!(!text.contains("accountLocalId"));
            assert!(!text.contains("spaceNames"));
        }
        // What is meant to cross does cross.
        assert!(sent.contains("Question"));

        // A settings file that does not parse must not be quoted either.
        let broken = format!("{{\"spacePassword\": \"{SECRET}\", \"nodeTypes\": [,]}}");
        write(&root, SETTINGS_PATH, &broken);
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        let sent = serde_json::to_string(&graph).unwrap();
        assert!(!sent.contains(SECRET));
        assert!(graph.node_types.is_empty());
        assert!(graph.incomplete);
        assert_eq!(graph.warnings.len(), 1);
        assert!(graph.warnings[0].starts_with("the plugin settings are not valid JSON (line 1,"));
        // With no types to check against, every typed note is kept.
        assert!(titles(&graph).contains(&"old type"));

        // Types of the wrong shape are dropped, not echoed in an error.
        let odd = json!({"nodeTypes": SECRET, "relationTypes": [{"id": 7, "label": SECRET}]});
        write(&root, SETTINGS_PATH, &odd.to_string());
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert!(!serde_json::to_string(&graph).unwrap().contains(SECRET));
        assert!(graph.relation_types.is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_wire_shape_uses_camel_case() {
        let root = scratch("shape");
        write(&root, "QUE - why.md", &note("node_q", "id-q"));
        let value = serde_json::to_value(read_graph(root.to_str().unwrap()).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({
                "directory": root.to_str().unwrap(),
                "message": null,
                "warnings": [],
                "truncated": false,
                "incomplete": false,
                "nodeTypes": [],
                "relationTypes": [],
                "allowedRelations": [],
                "nodes": [{
                    "id": "id-q",
                    "typeId": "node_q",
                    "title": "QUE - why",
                    "path": root.join("QUE - why.md").to_str().unwrap(),
                }],
                "relations": [],
                "skippedRelations": 0,
                "repeatedIds": 0,
                "canvases": [],
                "candidates": [],
                "issues": [],
            })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn frontmatter_needs_a_value_on_the_same_line() {
        assert_eq!(
            parse_frontmatter("---\nnodeTypeId: node_a\nnodeInstanceId: 'abc'\n---\n"),
            Frontmatter {
                node_type_id: Some(String::from("node_a")),
                node_instance_id: Some(String::from("abc")),
                canvas: false,
            }
        );
        assert_eq!(
            parse_frontmatter("---\nnodeTypeId:\ntags:\n  - x\n---\n").node_type_id,
            None
        );
        assert_eq!(
            parse_frontmatter("---\nnodeTypeId: \"\"\n---\n").node_type_id,
            None
        );
        // Windows line ends and a byte order mark are fine.
        assert_eq!(
            parse_frontmatter("\u{feff}---\r\nnodeTypeId: node_a\r\n---\r\n").node_type_id,
            Some(String::from("node_a"))
        );
        // Nested or later entries are not frontmatter entries.
        assert_eq!(
            parse_frontmatter("---\nmeta:\n  nodeTypeId: node_a\n---\n").node_type_id,
            None
        );
        assert_eq!(
            parse_frontmatter("---\ntitle: x\n---\nnodeTypeId: node_a\n").node_type_id,
            None
        );
        assert_eq!(
            parse_frontmatter("nodeTypeId: node_a\n"),
            Frontmatter::default()
        );
        assert!(parse_frontmatter("---\ntldr-dg: true\n---\n").canvas);
        assert!(!parse_frontmatter("---\ntldr-dg: false\n---\n").canvas);
    }

    #[test]
    fn only_the_top_of_a_note_is_read() {
        let root = scratch("head");
        let padding = "x".repeat(usize::try_from(FRONTMATTER_BYTES).unwrap());
        write(
            &root,
            "late.md",
            &format!("---\ntitle: {padding}\nnodeTypeId: node_a\nnodeInstanceId: late\n---\n"),
        );
        write(
            &root,
            "early.md",
            &format!("{}{padding}{padding}", note("node_a", "early")),
        );
        let head = read_bytes(&root.join("early.md"), FRONTMATTER_BYTES).unwrap();
        assert_eq!(head.len(), usize::try_from(FRONTMATTER_BYTES).unwrap());

        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert_eq!(titles(&graph), vec!["early"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_vault_over_the_note_limit_is_cut_short_and_says_so() {
        let root = scratch("limit");
        for name in ["a", "b", "c"] {
            write(&root, &format!("{name}.md"), &note("node_a", name));
        }
        let limits = Limits { notes: 2, ..LIMITS };
        let graph = read_graph_with(root.to_str().unwrap(), limits).unwrap();
        assert!(graph.truncated);
        assert_eq!(titles(&graph), vec!["a", "b"]);
        assert!(graph.warnings[0].contains("more than 2 notes"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_vault_full_of_other_files_is_cut_short_and_says_so() {
        let root = scratch("entries");
        write(&root, "a/first.md", &note("node_a", "first"));
        for n in 0..40 {
            write(&root, &format!("b/file-{n:02}.png"), "x");
        }
        write(&root, "c/never.md", &note("node_a", "never"));
        let dir = root.to_str().unwrap();

        // Three folders, one note, and room for six of the other files.
        let limits = Limits {
            entries: 10,
            ..LIMITS
        };
        let found = walk(&root, limits);
        assert!(found.truncated && found.entries_cut);
        assert_eq!(found.notes.len(), 1);
        let graph = read_graph_with(dir, limits).unwrap();
        assert!(graph.truncated);
        assert_eq!(titles(&graph), vec!["first"]);
        assert_eq!(
            graph.warnings,
            ["this vault has more than 10 files and folders, so the rest were not read"]
        );
        assert_eq!(graph.issues[0].kind, "limit");

        // With room for every file, nothing is cut.
        let graph = read_graph_with(dir, LIMITS).unwrap();
        assert!(!graph.truncated);
        assert_eq!(titles(&graph), vec!["first", "never"]);
        assert_eq!(graph.warnings, Vec::<String>::new());
        // Three folders and 42 files: a limit of exactly that many cuts nothing.
        for (entries, cut) in [(44, true), (45, false)] {
            let limits = Limits { entries, ..LIMITS };
            assert_eq!(walk(&root, limits).truncated, cut, "{entries}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canvases_are_read_up_to_a_total_size() {
        let root = scratch("canvas-total");
        let canvas = |name: &str| {
            write(
                &root,
                name,
                &format!("---\ntldr-dg: true\n---\n{}\n", "x".repeat(1000)),
            );
        };
        for name in ["a.md", "b.md", "c.md", "d.md"] {
            canvas(name);
        }
        let limits = Limits {
            canvas_bytes: 2_500,
            ..LIMITS
        };
        let graph = read_graph_with(root.to_str().unwrap(), limits).unwrap();
        // Two were read, and each says it holds no canvas. Two were not read.
        assert_eq!(graph.warnings.len(), 2, "{:?}", graph.warnings);
        let limit: Vec<&str> = graph
            .issues
            .iter()
            .filter(|issue| issue.kind == "limit")
            .map(|issue| issue.text.as_str())
            .collect();
        assert_eq!(
            limit,
            [
                "2 canvases were not read: at most 200 canvases and 2500 bytes of canvas text \
              are read from one vault"
            ]
        );
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert_eq!(graph.warnings.len(), 4);
        assert!(graph.issues.iter().all(|issue| issue.kind != "limit"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_that_share_an_instance_id_are_all_kept_and_flagged() {
        let root = scratch("repeat");
        write(&root, "a.md", &note("node_a", "same"));
        write(&root, "b.md", &note("node_a", "same"));
        write(&root, "c.md", &note("node_a", "same"));
        write(&root, "d.md", &note("node_a", "own"));
        write(
            &root,
            RELATIONS_FILE,
            &json!({"relations": {
                "r1": {"type": "rel_s", "source": "own", "destination": "same", "tentative": false},
                "r2": {"type": "relation_x", "source": "own", "destination": "own", "tentative": true}
            }})
            .to_string(),
        );
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        let ids: Vec<&str> = graph.nodes.iter().map(|node| node.id.as_str()).collect();
        assert_eq!(ids, vec!["same", "same#2", "same#3", "own"]);
        assert_eq!(titles(&graph), vec!["a", "b", "c", "d"]);
        assert_eq!(graph.repeated_ids, 2);
        assert!(graph.warnings[0].starts_with("2 notes share an instance id"));
        // One row per note that repeats an id, naming the note that had it first.
        let rows: Vec<(&str, &str, Option<&str>)> = graph
            .issues
            .iter()
            .map(|issue| (issue.kind, issue.text.as_str(), issue.path.as_deref()))
            .collect();
        assert_eq!(
            rows,
            vec![
                (
                    "sharedId",
                    "\"b\" carries the same instance id as \"a\"",
                    root.join("b.md").to_str()
                ),
                (
                    "sharedId",
                    "\"c\" carries the same instance id as \"a\"",
                    root.join("c.md").to_str()
                ),
            ]
        );
        let flags: Vec<(&str, bool)> = graph
            .relations
            .iter()
            .map(|relation| (relation.destination.as_str(), relation.ambiguous))
            .collect();
        assert_eq!(flags, vec![("same", true), ("own", false)]);
        let tentative: Vec<Option<bool>> = graph
            .relations
            .iter()
            .map(|relation| relation.tentative)
            .collect();
        assert_eq!(tentative, vec![Some(false), Some(true)]);
        // A type id is kept whole, whatever it starts with.
        assert_eq!(graph.relations[1].type_id, "relation_x");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_directory_that_is_not_a_vault_is_an_empty_graph_with_a_message() {
        let root = scratch("empty");
        write(&root, "readme.md", "# Nothing here\n");
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert!(graph.nodes.is_empty());
        assert!(graph.relations.is_empty());
        assert!(graph.canvases.is_empty());
        let message = graph.message.unwrap();
        assert!(
            message.starts_with("No Discourse Graphs data found in "),
            "{message}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_missing_directory_or_a_file_is_an_error() {
        assert!(read_graph("/definitely/not/here").is_err());
        assert!(fingerprint("/definitely/not/here").is_err());
        let root = scratch("file");
        write(&root, "a.md", "x");
        let error = read_graph(root.join("a.md").to_str().unwrap()).unwrap_err();
        assert!(error.ends_with("is not a directory"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn broken_relations_are_a_warning_not_a_failure() {
        let root = vault("broken");
        write(&root, RELATIONS_FILE, "{ not json");
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert_eq!(graph.nodes.len(), 4);
        assert!(graph.relations.is_empty());
        assert!(graph.warnings[0].starts_with("relations.json is not valid JSON"));
        // The caller is told to ask again: the file may be half written.
        assert!(graph.incomplete);
        assert_eq!(graph.message, None);
        fs::remove_dir_all(root).unwrap();
    }

    const IMAGE_PATH: &str = "app://local/Users/someone/vault/attachments/bird.png";

    /// A canvas note: block links before the drawing, the drawing, and more
    /// block links after it.
    fn canvas_text_for(records: &Value) -> String {
        let data = json!({"meta": {}, "raw": {"records": records}});
        format!(
            "---\ntldr-dg: true\n---\n[[QUE - why]]\n^block-q\n\n{CANVAS_START}\n{}\n{CANVAS_END}\n```\n\
             [[claims/CLM - because|the reason]]\n^block-c\n\n[[No such note]]\n^block-gone\n",
            serde_json::to_string_pretty(&data).unwrap()
        )
    }

    fn canvas_records() -> Value {
        json!([
            {"typeName": "document", "id": "document:document"},
            {"typeName": "page", "id": "page:two", "name": "Second", "index": "a2"},
            {"typeName": "page", "id": "page:one", "name": "First", "index": "a1"},
            {"typeName": "instance", "id": "instance:instance", "currentPageId": "page:one"},
            {"typeName": "shape", "type": "discourse-node", "id": "shape:q", "parentId": "page:one",
             "x": 10.5, "y": -20, "props": {"w": 400, "h": 112, "src": "asset:obsidian.blockref.block-q",
             "title": "QUE - an old name", "nodeTypeId": "node_q", "imageSrc": IMAGE_PATH,
             "size": "m", "fontFamily": "mono"}},
            {"typeName": "shape", "type": "discourse-node", "id": "shape:c", "parentId": "page:one",
             "x": 500, "y": 300, "props": {"src": "asset:obsidian.blockref.block-c",
             "title": "CLM - because", "nodeTypeId": "node_c"}},
            {"typeName": "shape", "type": "discourse-node", "id": "shape:far", "parentId": "page:two",
             "x": 0, "y": 0, "props": {"w": 200, "h": 100, "src": "asset:obsidian.blockref.block-lost",
             "title": "CLM - or not", "nodeTypeId": "node_c"}},
            {"typeName": "shape", "type": "discourse-node", "id": "shape:gone", "parentId": "page:two",
             "x": 0, "y": 200, "props": {"src": "asset:obsidian.blockref.block-gone",
             "title": "CLM - deleted since", "nodeTypeId": "node_c"}},
            {"typeName": "shape", "type": "discourse-node", "id": "shape:grouped", "parentId": "shape:frame",
             "x": 0, "y": 0, "props": {"title": "CLM - in a frame", "nodeTypeId": "node_c"}},
            {"typeName": "shape", "type": "discourse-relation", "id": "shape:arrow", "parentId": "page:one",
             "x": 1, "y": 2, "meta": {"relationInstanceId": "not-in-the-relations-file"},
             "props": {"text": "supports", "relationTypeId": "rel_s"}},
            {"typeName": "shape", "type": "discourse-relation", "id": "shape:loose", "parentId": "page:one",
             "x": 1, "y": 2, "props": {"text": "opposes", "relationTypeId": "rel_o"}},
            {"typeName": "binding", "type": "discourse-relation", "id": "binding:1",
             "fromId": "shape:arrow", "toId": "shape:c", "props": {"terminal": "start"}},
            {"typeName": "binding", "type": "discourse-relation", "id": "binding:2",
             "fromId": "shape:arrow", "toId": "shape:q", "props": {"terminal": "end"}},
            {"typeName": "binding", "type": "discourse-relation", "id": "binding:3",
             "fromId": "shape:loose", "toId": "shape:q", "props": {"terminal": "end"}},
            {"typeName": "binding", "type": "arrow", "id": "binding:4",
             "fromId": "shape:plain", "toId": "shape:q", "props": {"terminal": "end"}},
            {"typeName": "shape", "type": "text", "id": "shape:t", "parentId": "page:one", "x": 5, "y": 6,
             "props": {"w": 260, "autoSize": false, "size": "xl", "scale": 1.5, "richText": {"type": "doc", "content": [
                 {"type": "paragraph", "content": [
                     {"type": "text", "marks": [{"type": "highlight"}], "text": "Untested"},
                     {"type": "text", "text": " claims"}
                 ]},
                 {"type": "paragraph"},
                 {"type": "paragraph", "content": [{"type": "text", "text": "second line"}]}
             ]}}},
            {"typeName": "shape", "type": "text", "id": "shape:older", "parentId": "page:two", "x": 1, "y": 1,
             "props": {"text": "plain text, no size", "w": 90, "autoSize": true}},
            {"typeName": "shape", "type": "text", "id": "shape:blank", "parentId": "page:one", "x": 5, "y": 6,
             "props": {"richText": {"type": "doc", "content": [{"type": "paragraph"}]}}},
            {"typeName": "shape", "type": "image", "id": "shape:img", "parentId": "page:one", "x": 0, "y": 0},
            {"typeName": "shape", "type": "note", "id": "shape:sticky", "parentId": "page:one", "x": 0, "y": 0}
        ])
    }

    fn check_canvas(root: &Path, graph: &VaultGraph) {
        assert!(graph.warnings.is_empty(), "{:?}", graph.warnings);
        assert!(!graph.incomplete);
        // A canvas is not a node, and its arrows are not relations: the
        // relations file alone says what relates to what.
        assert_eq!(graph.nodes.len(), 4);
        assert_eq!(graph.relations.len(), 2);
        assert_eq!(graph.canvases.len(), 1);

        let canvas = &graph.canvases[0];
        assert_eq!(canvas.name, "Overview");
        assert_eq!(
            canvas.path,
            root.join("Canvases/Overview.md").to_str().unwrap()
        );
        assert_eq!(
            canvas.pages,
            vec![
                CanvasPage {
                    id: String::from("page:one"),
                    name: String::from("First"),
                },
                CanvasPage {
                    id: String::from("page:two"),
                    name: String::from("Second"),
                },
            ]
        );
        let by_id = |id: &str| canvas.nodes.iter().find(|node| node.id == id).unwrap();
        // The block link wins over the title saved on the box.
        assert_eq!(
            by_id("shape:q"),
            &CanvasNode {
                id: String::from("shape:q"),
                page_id: String::from("page:one"),
                x: 10.5,
                y: -20.0,
                w: 400.0,
                h: 112.0,
                size: String::from("m"),
                title: String::from("QUE - why"),
                type_id: String::from("node_q"),
                path: Some(text_of(&root.join("QUE - why.md"))),
            }
        );
        // A link with a folder and an alias, listed after the drawing. A
        // box with no saved size gets the plugin's default.
        let because = by_id("shape:c");
        assert_eq!(
            because.path,
            Some(text_of(&root.join("claims/CLM - because.md")))
        );
        assert_eq!((because.w, because.h), (200.0, 100.0));
        assert_eq!(because.size, "s");
        // No block for this box, so its saved title is tried.
        let far = by_id("shape:far");
        assert_eq!(far.title, "CLM - or not");
        assert_eq!(
            far.path,
            Some(text_of(&root.join("claims/deep/CLM - or not.md")))
        );
        // Neither the block's link nor the title names a note.
        let gone = by_id("shape:gone");
        assert_eq!(gone.title, "CLM - deleted since");
        assert_eq!(gone.path, None);
        assert_eq!(canvas.nodes.len(), 4);

        assert_eq!(
            canvas.relations,
            vec![CanvasRelation {
                id: String::from("shape:arrow"),
                page_id: String::from("page:one"),
                type_id: String::from("rel_s"),
                label: String::from("supports"),
                source: String::from("shape:c"),
                destination: String::from("shape:q"),
            }]
        );
        assert_eq!(canvas.unbound_relations, 1);
        assert_eq!(
            canvas.texts,
            vec![
                CanvasText {
                    id: String::from("shape:older"),
                    page_id: String::from("page:two"),
                    x: 1.0,
                    y: 1.0,
                    w: 0.0,
                    size: String::from("m"),
                    scale: 1.0,
                    text: String::from("plain text, no size"),
                },
                CanvasText {
                    id: String::from("shape:t"),
                    page_id: String::from("page:one"),
                    x: 5.0,
                    y: 6.0,
                    w: 260.0,
                    size: String::from("xl"),
                    scale: 1.5,
                    text: String::from("Untested claims\nsecond line"),
                },
            ]
        );
        // The framed box, the image and the sticky note.
        assert_eq!(canvas.other_shapes, 3);

        // An image path from the machine that drew the canvas stays behind.
        let sent = serde_json::to_string(graph).unwrap();
        assert!(!sent.contains(IMAGE_PATH));
        assert!(!sent.contains("imageSrc"));
        assert!(!sent.contains("blockref"));

        let value = serde_json::to_value(canvas).unwrap();
        for key in ["unboundRelations", "otherShapes", "pages", "texts"] {
            assert!(value.get(key).is_some(), "{key}");
        }
        assert!(value["nodes"][0].get("pageId").is_some());
        assert!(value["nodes"][0].get("typeId").is_some());
    }

    #[test]
    fn reads_a_canvas_with_its_saved_positions() {
        let root = vault("canvas");
        write(
            &root,
            "Canvases/Overview.md",
            &canvas_text_for(&canvas_records()),
        );
        check_canvas(&root, &read_graph(root.to_str().unwrap()).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canvas_records_may_be_an_object_keyed_by_id() {
        let root = vault("canvas-object");
        let keyed: serde_json::Map<String, Value> = canvas_records()
            .as_array()
            .unwrap()
            .iter()
            .map(|record| (record["id"].as_str().unwrap().to_string(), record.clone()))
            .collect();
        write(
            &root,
            "Canvases/Overview.md",
            &canvas_text_for(&Value::Object(keyed)),
        );
        check_canvas(&root, &read_graph(root.to_str().unwrap()).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_block_link_is_the_line_above_its_block_id() {
        let text = format!(
            "[[A]]\n^one\n\n{CANVAS_START}\n[[Not a link]]\n^inside\n{CANVAS_END}\n```\n\
             ![[folder/B#Heading|shown as]]\n^two\ntext with no link\n^three\n^four\n"
        );
        let links = block_links(&text);
        assert_eq!(links.get("one").map(String::as_str), Some("A"));
        assert_eq!(links.get("two").map(String::as_str), Some("folder/B"));
        assert_eq!(links.len(), 2);
    }

    #[test]
    fn a_link_resolves_by_path_or_by_bare_name() {
        let root = Path::new("/vault");
        let notes: Vec<NoteFile> = ["/vault/a/Note.md", "/vault/b/Note.md", "/vault/b/Other.md"]
            .iter()
            .map(|path| NoteFile {
                path: PathBuf::from(path),
                size: 0,
                modified_ms: 0,
            })
            .collect();
        let index = NoteIndex::new(root, &notes);
        assert_eq!(index.resolve("Other"), Some("/vault/b/Other.md"));
        assert_eq!(index.resolve("Other.md"), Some("/vault/b/Other.md"));
        assert_eq!(index.resolve("b/Note"), Some("/vault/b/Note.md"));
        assert_eq!(index.resolve("Note"), Some("/vault/a/Note.md"));
        assert_eq!(index.resolve("elsewhere/Other"), Some("/vault/b/Other.md"));
        assert_eq!(index.resolve("Missing"), None);
    }

    #[test]
    fn a_canvas_that_cannot_be_read_is_a_warning() {
        let root = scratch("bad-canvas");
        write(
            &root,
            "no-block.md",
            "---\ntldr-dg: true\n---\nnothing here\n",
        );
        write(
            &root,
            "bad-json.md",
            &format!("---\ntldr-dg: true\n---\n{CANVAS_START}\n{{ nope\n{CANVAS_END}\n```\n"),
        );
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert!(graph.canvases.is_empty());
        assert_eq!(graph.warnings.len(), 2);
        assert!(graph.warnings[0].contains("not valid JSON"));
        assert!(graph.warnings[1].ends_with("no canvas data block found"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_canvas_block_ends_at_the_end_marker() {
        let text = format!("intro\n{CANVAS_START}\n{{\"a\": 1}}\n{CANVAS_END}\n```\nafter\n");
        assert_eq!(canvas_json(&text), Some("{\"a\": 1}\n"));
        assert_eq!(canvas_json("no markers"), None);
        assert_eq!(canvas_json(&format!("{CANVAS_START}\n{{}}\n")), None);
    }

    #[test]
    fn a_tag_is_matched_whole_and_not_inside_a_word_or_an_address() {
        assert!(has_tag("#clm-candidate: it scales", "clm-candidate"));
        assert!(has_tag("which is ==#clm-candidate== more", "clm-candidate"));
        assert!(has_tag("- a point (#clm-candidate)", "clm-candidate"));
        assert!(has_tag("#other then #clm-candidate", "clm-candidate"));
        assert!(!has_tag("#clm-candidates", "clm-candidate"));
        assert!(!has_tag("#clm-candidate/sub", "clm-candidate"));
        assert!(!has_tag(
            "see https://example.org/#clm-candidate",
            "clm-candidate"
        ));
        assert!(!has_tag("word#clm-candidate", "clm-candidate"));
        assert!(!has_tag("tag a line `#clm-candidate`", "clm-candidate"));
        assert!(!has_tag("clm-candidate with no hash", "clm-candidate"));
    }

    #[test]
    fn finds_the_lines_that_carry_a_candidate_tag() {
        let root = scratch("candidates");
        write(
            &root,
            SETTINGS_PATH,
            &json!({
                "nodeTypes": [
                    {"id": "node_c", "name": "Claim", "tag": "clm-candidate"},
                    {"id": "node_q", "name": "Question", "tag": "#QUE-candidate"},
                    {"id": "node_e", "name": "Evidence", "tag": ""},
                    {"id": "node_x", "name": "Experiment", "tag": null}
                ],
                "discourseRelations": [
                    {"sourceId": "node_e", "destinationId": "node_c", "relationshipTypeId": "rel_s"},
                    {"sourceId": "node_e", "relationshipTypeId": "rel_s"}
                ],
                "spacePassword": SECRET
            })
            .to_string(),
        );
        let long = "y".repeat(400);
        write(
            &root,
            "daily/monday.md",
            &format!(
                "# Monday\n\n  - Birds are light #clm-candidate  \nNothing here.\n\
                 Why so light? #que-candidate and #CLM-Candidate\n#clm-candidate {long}\n"
            ),
        );
        write(
            &root,
            "CLM - a node.md",
            &format!("{}#clm-candidate in a node\n", note("node_c", "id-c")),
        );
        write(
            &root,
            "Templates/Claim.md",
            "#clm-candidate in a template\n",
        );
        write(&root, ".trash/old.md", "#clm-candidate in the bin\n");
        write(
            &root,
            "board.md",
            "---\ntldr-dg: true\n---\n#clm-candidate in a canvas\n",
        );
        let big = "z".repeat(usize::try_from(CANDIDATE_BYTES).unwrap());
        write(&root, "huge.md", &format!("#clm-candidate\n{big}\n"));

        let graph = read_graph(root.to_str().unwrap()).unwrap();
        let tags: Vec<Option<&str>> = graph
            .node_types
            .iter()
            .map(|node_type| node_type.tag.as_deref())
            .collect();
        assert_eq!(
            tags,
            vec![Some("clm-candidate"), Some("QUE-candidate"), None, None]
        );
        assert_eq!(
            graph.allowed_relations,
            vec![AllowedRelation {
                source_type_id: String::from("node_e"),
                destination_type_id: String::from("node_c"),
                relation_type_id: String::from("rel_s"),
            }]
        );

        let monday = text_of(&root.join("daily/monday.md"));
        let found: Vec<(&str, usize, &str, &str)> = graph
            .candidates
            .iter()
            .map(|candidate| {
                (
                    candidate.path.as_str(),
                    candidate.line,
                    candidate.type_id.as_str(),
                    candidate.text.as_str(),
                )
            })
            .collect();
        let node_note = text_of(&root.join("CLM - a node.md"));
        assert_eq!(found.len(), 5);
        assert_eq!(
            found[0],
            (node_note.as_str(), 7, "node_c", "#clm-candidate in a node")
        );
        assert_eq!(
            found[1],
            (
                monday.as_str(),
                3,
                "node_c",
                "- Birds are light #clm-candidate"
            )
        );
        // One line with two tags is a candidate for both types.
        assert_eq!((found[2].1, found[2].2), (5, "node_c"));
        assert_eq!((found[3].1, found[3].2), (5, "node_q"));
        // A long line is cut.
        assert_eq!(found[4].1, 6);
        assert_eq!(found[4].3.chars().count(), MAX_CANDIDATE_CHARS);
        // A note with a tagged line is still a node.
        assert_eq!(titles(&graph), vec!["CLM - a node"]);
        // The note over the size limit was not searched, and the reader says so.
        let limits: Vec<&Issue> = graph
            .issues
            .iter()
            .filter(|issue| issue.kind == "limit")
            .collect();
        assert_eq!(limits.len(), 1);
        assert!(limits[0]
            .text
            .starts_with("1 notes were not searched for candidates"));
        assert!(!serde_json::to_string(&graph).unwrap().contains(SECRET));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_so_many_candidate_tags_are_searched_for() {
        let root = scratch("many-tags");
        let node_types: Vec<Value> = (0..MAX_TAG_RULES + 40)
            .map(|n| json!({"id": format!("node_{n}"), "name": format!("N{n}"), "tag": format!("tag-{n}")}))
            .collect();
        write(
            &root,
            SETTINGS_PATH,
            &json!({ "nodeTypes": node_types }).to_string(),
        );
        let last_searched = MAX_TAG_RULES - 1;
        write(
            &root,
            "note.md",
            &format!(
                "first #tag-0
last #tag-{last_searched}
past #tag-{MAX_TAG_RULES}
"
            ),
        );
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        let lines: Vec<usize> = graph.candidates.iter().map(|found| found.line).collect();
        assert_eq!(lines, [1, 2]);
        let limits: Vec<&str> = graph
            .issues
            .iter()
            .filter(|issue| issue.kind == "limit")
            .map(|issue| issue.text.as_str())
            .collect();
        assert_eq!(
            limits,
            [format!(
                "the settings give {} node types a candidate tag, so only the first \
                 {MAX_TAG_RULES} were searched for",
                MAX_TAG_RULES + 40
            )]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_vault_with_no_candidate_tags_reads_only_the_top_of_each_note() {
        let root = scratch("no-tags");
        write(&root, "note.md", "A line with #clm-candidate in it.\n");
        let graph = read_graph(root.to_str().unwrap()).unwrap();
        assert!(graph.candidates.is_empty());
        assert!(graph.issues.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn searching_for_candidates_leaves_the_fingerprint_alone() {
        let root = vault("print-candidates");
        let dir = root.to_str().unwrap();
        let before = fingerprint(dir).unwrap();
        read_graph(dir).unwrap();
        assert_eq!(fingerprint(dir).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    fn set_modified(path: &Path, seconds_after_epoch: u64) {
        let time = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds_after_epoch);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    #[test]
    fn the_fingerprint_changes_when_the_graph_may_have() {
        let root = vault("fingerprint");
        let dir = root.to_str().unwrap();
        let first = fingerprint(dir).unwrap();
        assert_eq!(fingerprint(dir).unwrap(), first);
        assert!(first.starts_with("7-"), "{first}");

        // Files the walk skips do not count.
        write(
            &root,
            ".trash/CLM - also binned.md",
            &note("node_c", "id-b2"),
        );
        write(&root, "notes.txt", "not a note");
        write(&root, "Meta/Templates/Source.md", &note("node_c", "id-s"));
        assert_eq!(fingerprint(dir).unwrap(), first);

        write(&root, "CLM - new.md", &note("node_c", "id-new"));
        let added = fingerprint(dir).unwrap();
        assert_ne!(added, first);
        assert!(added.starts_with("8-"), "{added}");

        // A rename keeps the count, size and time, and still shows.
        fs::rename(root.join("CLM - new.md"), root.join("CLM - renamed.md")).unwrap();
        let renamed = fingerprint(dir).unwrap();
        assert_ne!(renamed, added);

        set_modified(&root.join("QUE - why.md"), 1_900_000_000);
        let touched = fingerprint(dir).unwrap();
        assert_ne!(touched, renamed);

        set_modified(&root.join(RELATIONS_FILE), 1_900_000_001);
        let related = fingerprint(dir).unwrap();
        assert_ne!(related, touched);

        set_modified(&root.join(SETTINGS_PATH), 1_900_000_002);
        assert_ne!(fingerprint(dir).unwrap(), related);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_linked_directory_is_not_followed() {
        let root = scratch("link");
        write(&root, "real/a.md", &note("node_a", "a"));
        std::os::unix::fs::symlink(&root, root.join("real/loop")).unwrap();
        std::os::unix::fs::symlink(root.join("real/a.md"), root.join("linked.md")).unwrap();
        let found = walk(&root, LIMITS);
        let names: Vec<String> = found
            .notes
            .iter()
            .map(|note| text_of(note.path.strip_prefix(&root).unwrap()))
            .collect();
        assert_eq!(names, vec!["linked.md", "real/a.md"]);
        fs::remove_dir_all(root).unwrap();
    }
}
