//! Writes to a notes vault that uses the Discourse Graphs plugin for
//! Obsidian: a new node note, a relation between two nodes, and the skill
//! file that teaches an agent to do both.
//!
//! Every file is written in the plugin's own format, so the plugin reads
//! the result as if it had written it. The plugin's settings file is read
//! for its node types, relation types and allowed relations. The same file
//! holds account details, which are never copied out of it.
//!
//! Every function here is a plain file operation, so the command-line tool
//! can call them when the app is not running.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::startup::expand_home;

const VAULT_MARKER: &str = ".obsidian";
const SETTINGS_PATH: &str = ".obsidian/plugins/discourse-graphs/data.json";
const CORE_PLUGINS_PATH: &str = ".obsidian/core-plugins.json";
const TEMPLATES_SETTINGS_PATH: &str = ".obsidian/templates.json";
const RELATIONS_FILE: &str = "relations.json";
const RELATIONS_VERSION: u64 = 1;
const NOTE_SUFFIX: &str = ".md";
const TYPE_KEY: &str = "nodeTypeId";
const INSTANCE_KEY: &str = "nodeInstanceId";
const CANVAS_KEY: &str = "tldr-dg";
const SKIPPED_DIRS: [&str; 2] = ["node_modules", ".trash"];
const TEMPLATES_DIR: &str = "templates";

const MAX_NOTES: usize = 20_000;
const MAX_DEPTH: usize = 32;
const FRONTMATTER_BYTES: u64 = 16 * 1024;
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;
/// A file name may be 255 bytes on the common file systems. This leaves
/// room for the extension and for a sync tool's own suffix.
const MAX_TITLE_BYTES: usize = 200;
const NOTE_MODE: u32 = 0o644;

/// The skill file, as shipped in the repository.
pub const SKILL_TEXT: &str = include_str!("../../skills/discourse-graph/SKILL.md");
const SKILL_PATH: &str = ".claude/skills/discourse-graph/SKILL.md";

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeKind {
    pub id: String,
    pub name: String,
    /// The naming pattern for notes of this type, such as `CLM - {content}`.
    pub format: String,
    /// The pattern's text before the content, without its dash: `CLM`.
    pub prefix: String,
    pub tag: Option<String>,
    pub color: Option<String>,
    #[serde(skip)]
    template: Option<String>,
    #[serde(skip)]
    folder: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelationKind {
    pub id: String,
    pub label: String,
    /// The label read from the far end, such as `is supported by`.
    pub complement: String,
    pub color: Option<String>,
}

/// One relation the vault allows, between two node types.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Triple {
    pub source_id: String,
    pub relation_id: String,
    pub destination_id: String,
    /// The triple in words, such as `Evidence supports Claim`.
    pub sentence: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultTypes {
    pub node_types: Vec<NodeKind>,
    pub relation_types: Vec<RelationKind>,
    pub allowed: Vec<Triple>,
}

#[derive(Debug, Default)]
struct Schema {
    types: VaultTypes,
    nodes_folder: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreatedNode {
    /// The new note's instance id.
    pub id: String,
    /// The note's file name without its extension.
    pub title: String,
    /// The note's absolute path.
    pub path: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddedRelation {
    pub id: String,
    /// The relation in words, with the two notes' titles.
    pub sentence: String,
}

/// A node note that already exists in the vault.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeEntry {
    /// Missing when the note has no instance id yet.
    pub id: Option<String>,
    pub type_id: String,
    /// The type's name, when the settings know the type.
    pub type_name: Option<String>,
    pub title: String,
    pub path: String,
}

#[derive(Debug, PartialEq)]
pub enum SkillInstall {
    Written,
    Unchanged,
}

#[derive(Debug)]
struct Note {
    path: PathBuf,
    type_id: Option<String>,
    instance_id: Option<String>,
}

fn text_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// A new id of the kind the plugin makes: a version 7 UUID, which starts
/// with the time, so later ids sort after earlier ones.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().hyphenated().to_string()
}

/// The vault that holds `start`: the nearest directory, going up from a
/// file or a directory, that has an `.obsidian` directory in it.
pub fn vault_root(start: &Path) -> Option<PathBuf> {
    let first = if start.is_dir() {
        start
    } else {
        start.parent()?
    };
    first
        .ancestors()
        .find(|dir| dir.join(VAULT_MARKER).is_dir())
        .map(Path::to_path_buf)
}

fn open_vault(vault: &Path) -> Result<PathBuf, String> {
    let root = fs::canonicalize(vault).map_err(|error| format!("{}: {error}", vault.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", vault.display()));
    }
    Ok(root)
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

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn list_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Where a naming pattern's `{content}` sits: the byte range of the first
/// `{letters}` in it.
fn placeholder(format: &str) -> Option<(usize, usize)> {
    let mut search = 0;
    while let Some(open) = format[search..].find('{').map(|at| at + search) {
        let rest = &format[open + 1..];
        if let Some(close) = rest.find('}') {
            let name = &rest[..close];
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphabetic()) {
                return Some((open, open + close + 2));
            }
        }
        search = open + 1;
    }
    None
}

/// The short name people use for a type: the pattern's text before the
/// content, without the dash that separates the two.
fn prefix_of(format: &str) -> String {
    let before = placeholder(format).map_or(format, |(start, _)| &format[..start]);
    before.trim().trim_end_matches('-').trim_end().to_string()
}

/// Copies the node types, relation types and allowed relations out of the
/// plugin's settings. The same file holds account details, so nothing else
/// is copied and the parsed file never leaves this function.
fn schema_from(bytes: &[u8]) -> Result<Schema, String> {
    // The parser's own message can quote the file, so only the position
    // of the fault is reported.
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        format!(
            "the plugin settings are not valid JSON (line {}, column {})",
            error.line(),
            error.column()
        )
    })?;
    let node_types: Vec<NodeKind> = list_field(&value, "nodeTypes")
        .iter()
        .filter_map(|entry| {
            let id = string_field(entry, "id")?;
            let format = string_field(entry, "format").unwrap_or_default();
            Some(NodeKind {
                name: string_field(entry, "name").unwrap_or_else(|| id.clone()),
                prefix: prefix_of(&format),
                format,
                tag: string_field(entry, "tag"),
                color: string_field(entry, "color"),
                template: string_field(entry, "template"),
                folder: string_field(entry, "folderPath"),
                id,
            })
        })
        .collect();
    let relation_types: Vec<RelationKind> = list_field(&value, "relationTypes")
        .iter()
        .filter_map(|entry| {
            let id = string_field(entry, "id")?;
            Some(RelationKind {
                label: string_field(entry, "label").unwrap_or_else(|| id.clone()),
                complement: string_field(entry, "complement").unwrap_or_default(),
                color: string_field(entry, "color"),
                id,
            })
        })
        .collect();
    let name_of = |id: &str| {
        node_types
            .iter()
            .find(|kind| kind.id == id)
            .map(|kind| kind.name.as_str())
    };
    let allowed = list_field(&value, "discourseRelations")
        .iter()
        .filter_map(|entry| {
            let source_id = string_field(entry, "sourceId")?;
            let destination_id = string_field(entry, "destinationId")?;
            let relation_id = string_field(entry, "relationshipTypeId")?;
            let relation = relation_types.iter().find(|kind| kind.id == relation_id)?;
            let sentence = format!(
                "{} {} {}",
                name_of(&source_id)?,
                relation.label,
                name_of(&destination_id)?
            );
            Some(Triple {
                source_id,
                relation_id,
                destination_id,
                sentence,
            })
        })
        .collect();
    Ok(Schema {
        types: VaultTypes {
            node_types,
            relation_types,
            allowed,
        },
        nodes_folder: string_field(&value, "nodesFolderPath"),
    })
}

fn load_schema(root: &Path) -> Result<Schema, String> {
    let path = root.join(SETTINGS_PATH);
    let bytes = read_capped(&path, MAX_JSON_BYTES)
        .map_err(|_| String::from("the plugin settings could not be read"))?
        .ok_or_else(|| {
            format!(
                "{} has no Discourse Graphs settings (looked for {SETTINGS_PATH}). \
                 Open the vault in Obsidian with the Discourse Graphs plugin once, \
                 or pass the vault directory.",
                root.display()
            )
        })?;
    schema_from(&bytes)
}

/// The node types, relation types and allowed relations of a vault.
pub fn vault_types(vault: &Path) -> Result<VaultTypes, String> {
    Ok(load_schema(&open_vault(vault)?)?.types)
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn one_of<'a, T>(
    matches: Vec<&'a T>,
    wanted: &str,
    what: &str,
    name: impl Fn(&T) -> String,
) -> Option<Result<&'a T, String>> {
    match matches.as_slice() {
        [] => None,
        [only] => Some(Ok(only)),
        many => Some(Err(format!(
            "{wanted} names more than one {what}: {}. Use the id.",
            many.iter()
                .map(|each| name(each))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Finds a node type by its id, or without regard to case by its name, its
/// prefix or its tag.
fn find_node_kind<'a>(types: &'a VaultTypes, wanted: &str) -> Result<&'a NodeKind, String> {
    let wanted = wanted.trim();
    let tag = wanted.trim_start_matches('#');
    let describe = |kind: &NodeKind| format!("{} ({})", kind.name, kind.id);
    let tiers: [&dyn Fn(&NodeKind) -> bool; 4] = [
        &|kind| kind.id == wanted,
        &|kind| same(&kind.name, wanted),
        &|kind| !kind.prefix.is_empty() && same(&kind.prefix, wanted),
        &|kind| {
            kind.tag
                .as_deref()
                .is_some_and(|own| same(own.trim_start_matches('#'), tag))
        },
    ];
    for tier in tiers {
        let matches: Vec<&NodeKind> = types.node_types.iter().filter(|kind| tier(kind)).collect();
        if let Some(found) = one_of(matches, wanted, "node type", describe) {
            return found;
        }
    }
    let known: Vec<&str> = types
        .node_types
        .iter()
        .map(|kind| kind.name.as_str())
        .collect();
    Err(format!(
        "no node type called {wanted}. This vault has: {}",
        known.join(", ")
    ))
}

/// Finds a relation type by its id, or without regard to case by its label.
fn find_relation_kind<'a>(types: &'a VaultTypes, wanted: &str) -> Result<&'a RelationKind, String> {
    let wanted = wanted.trim();
    let describe = |kind: &RelationKind| format!("{} ({})", kind.label, kind.id);
    let tiers: [&dyn Fn(&RelationKind) -> bool; 2] =
        [&|kind| kind.id == wanted, &|kind| same(&kind.label, wanted)];
    for tier in tiers {
        let matches: Vec<&RelationKind> = types
            .relation_types
            .iter()
            .filter(|kind| tier(kind))
            .collect();
        if let Some(found) = one_of(matches, wanted, "relation type", describe) {
            return found;
        }
    }
    let known: Vec<&str> = types
        .relation_types
        .iter()
        .map(|kind| kind.label.as_str())
        .collect();
    Err(format!(
        "no relation type called {wanted}. This vault has: {}",
        known.join(", ")
    ))
}

/// Makes text safe to be part of a note's file name. The plugin refuses
/// `#`, `^`, `[`, `]` and `|` in a node's name because they break links, so
/// they are dropped. A file name cannot hold `/`, `\` or `:`, so each
/// becomes a dash. Line breaks and runs of spaces become one space.
fn clean_text(text: &str) -> String {
    let mut kept = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '#' | '^' | '[' | ']' | '|' => {}
            '/' | '\\' | ':' => kept.push('-'),
            c if c.is_control() => kept.push(' '),
            c => kept.push(c),
        }
    }
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut_to(text: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].trim_end()
}

/// The title of a new node: the type's naming pattern with the text in the
/// place of `{content}`.
fn title_for(kind: &NodeKind, text: &str) -> Result<String, String> {
    let Some((start, end)) = placeholder(&kind.format) else {
        return Err(format!(
            "the node type {} has no {{content}} in its format, so a title cannot be made",
            kind.name
        ));
    };
    let (before, after) = (&kind.format[..start], &kind.format[end..]);
    if placeholder(after).is_some() || !kind.format[start..end].eq_ignore_ascii_case("{content}") {
        return Err(format!(
            "the node type {} has a format with a placeholder other than {{content}}",
            kind.name
        ));
    }
    if kind.format.contains(['/', '\\']) {
        return Err(format!(
            "the node type {} has a format with a path separator in it",
            kind.name
        ));
    }
    let mut content = clean_text(text);
    if before.is_empty() {
        // A leading dot would make the note a hidden file.
        content = content.trim_start_matches(['.', ' ']).to_string();
    }
    let room = MAX_TITLE_BYTES.saturating_sub(before.len() + after.len());
    let content = cut_to(&content, room);
    if content.is_empty() {
        return Err(String::from("the node text is empty"));
    }
    Ok(format!("{before}{content}{after}").trim().to_string())
}

fn is_skipped_dir(name: &str, with_templates: bool) -> bool {
    name.starts_with('.')
        || SKIPPED_DIRS.contains(&name)
        || (!with_templates && name.eq_ignore_ascii_case(TEMPLATES_DIR))
}

/// The paths of the notes under `root`, in a fixed order. A linked
/// directory is not entered. Templates are notes too, but not nodes, so
/// they are listed only when asked for.
fn walk(root: &Path, with_templates: bool) -> Vec<PathBuf> {
    let mut notes = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    while let Some((dir, depth)) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut subdirs = Vec::new();
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_DEPTH && !is_skipped_dir(&name, with_templates) {
                    subdirs.push(entry.path());
                }
                continue;
            }
            if !name.ends_with(NOTE_SUFFIX) || !entry.path().is_file() {
                continue;
            }
            if notes.len() >= MAX_NOTES {
                return notes;
            }
            notes.push(entry.path());
        }
        pending.extend(subdirs.into_iter().rev().map(|path| (path, depth + 1)));
    }
    notes
}

/// Where a note's frontmatter entries sit in its text.
struct Front {
    /// The byte after the opening `---` line.
    start: usize,
    /// The byte the closing line starts at, or the end of the text.
    close: usize,
    closed: bool,
    newline: &'static str,
}

fn front_of(text: &str) -> Option<Front> {
    let skip = if text.starts_with('\u{feff}') { 3 } else { 0 };
    let mut lines = text[skip..].split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let newline = if first.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let start = skip + first.len();
    let mut offset = start;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            return Some(Front {
                start,
                close: offset,
                closed: true,
                newline,
            });
        }
        offset += line.len();
    }
    Some(Front {
        start,
        close: text.len(),
        closed: false,
        newline,
    })
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

/// The last top-level `key: value` line for `key`: its byte range and its
/// value. The graph reader takes the last such line too.
fn entry_of(text: &str, front: &Front, key: &str) -> Option<(usize, usize, Option<String>)> {
    let mut found = None;
    let mut offset = front.start;
    for line in text[front.start..front.close].split_inclusive('\n') {
        if let Some((name, value)) = line.trim_end().split_once(':') {
            if name == key {
                found = Some((offset, offset + line.len(), scalar(value)));
            }
        }
        offset += line.len();
    }
    found
}

fn value_of(text: &str, key: &str) -> Option<String> {
    let front = front_of(text)?;
    entry_of(text, &front, key).and_then(|(_, _, value)| value)
}

/// The note's text with an instance id added to its frontmatter. Only that
/// one line is added or filled in. Every other byte stays as it was.
fn with_instance_id(text: &str, id: &str) -> Result<String, String> {
    let front = front_of(text)
        .filter(|front| front.closed)
        .ok_or_else(|| String::from("the note has no closed frontmatter block"))?;
    let mut out = String::with_capacity(text.len() + 64);
    match entry_of(text, &front, INSTANCE_KEY) {
        Some((start, end, _)) => {
            let line = &text[start..end];
            let ending = &line[line.trim_end_matches(['\r', '\n']).len()..];
            out.push_str(&text[..start]);
            out.push_str(&format!("{INSTANCE_KEY}: {id}{ending}"));
            out.push_str(&text[end..]);
        }
        None => {
            out.push_str(&text[..front.close]);
            out.push_str(&format!("{INSTANCE_KEY}: {id}{}", front.newline));
            out.push_str(&text[front.close..]);
        }
    }
    Ok(out)
}

fn read_head(path: &Path) -> io::Result<String> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(FRONTMATTER_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Every note outside the template folders, with what its frontmatter says
/// about it. A canvas is left out: it is a drawing, not a node.
fn read_notes(root: &Path) -> Vec<Note> {
    walk(root, false)
        .into_iter()
        .filter_map(|path| {
            let head = read_head(&path).ok()?;
            if value_of(&head, CANVAS_KEY).as_deref() == Some("true") {
                return None;
            }
            Some(Note {
                type_id: value_of(&head, TYPE_KEY),
                instance_id: value_of(&head, INSTANCE_KEY),
                path,
            })
        })
        .collect()
}

fn stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn relative(root: &Path, path: &Path) -> String {
    text_of(path.strip_prefix(root).unwrap_or(path))
}

/// The nodes that exist in a vault, in title order. `type_filter` names a
/// node type the way `find_node_kind` accepts.
pub fn list_nodes(vault: &Path, type_filter: Option<&str>) -> Result<Vec<NodeEntry>, String> {
    let root = open_vault(vault)?;
    let schema = load_schema(&root)?;
    let only = type_filter
        .map(|wanted| find_node_kind(&schema.types, wanted).map(|kind| kind.id.clone()))
        .transpose()?;
    let mut nodes: Vec<NodeEntry> = read_notes(&root)
        .into_iter()
        .filter_map(|note| {
            let type_id = note.type_id?;
            if only.as_ref().is_some_and(|only| *only != type_id) {
                return None;
            }
            let kind = schema.types.node_types.iter().find(|k| k.id == type_id)?;
            Some(NodeEntry {
                id: note.instance_id,
                type_name: Some(kind.name.clone()),
                type_id,
                title: stem_of(&note.path),
                path: text_of(&note.path),
            })
        })
        .collect();
    nodes.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.path.cmp(&b.path)));
    Ok(nodes)
}

static TEMP_COUNT: AtomicU32 = AtomicU32::new(0);

/// A name for a file that is about to be moved into place. It starts with
/// a dot so the vault's own app does not show it while it exists.
fn temp_beside(path: &Path) -> PathBuf {
    let number = TEMP_COUNT.fetch_add(1, Ordering::SeqCst);
    let name = format!(".write-{}-{number}-{}.tmp", std::process::id(), now_ms());
    path.with_file_name(name)
}

fn write_temp(temp: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(temp)?;
    file.write_all(bytes)?;
    file.set_permissions(fs::Permissions::from_mode(mode))?;
    file.sync_all()
}

/// Replaces a file in one step, so a reader sees the old text or the new
/// text and never half of each. The file keeps its mode.
fn write_replacing(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // A linked file is written through the link, not over it.
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mode = fs::metadata(&target)
        .map(|metadata| metadata.permissions().mode() & 0o777)
        .unwrap_or(NOTE_MODE);
    let temp = temp_beside(&target);
    let done = write_temp(&temp, bytes, mode).and_then(|()| fs::rename(&temp, &target));
    done.map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("could not write {}: {error}", target.display())
    })
}

/// Writes a file that must not exist yet. If another program makes the
/// same file first, this fails and that file is left alone.
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let exists = || format!("{} already exists", path.display());
    let temp = temp_beside(path);
    write_temp(&temp, bytes, NOTE_MODE)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    // A hard link fails when the name is taken, where a rename would
    // replace the file that took it.
    let linked = fs::hard_link(&temp, path);
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(exists()),
        // Some file systems have no hard links. Creating the file directly
        // still refuses a name that is taken.
        Err(_) => write_temp(path, bytes, NOTE_MODE).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                exists()
            } else {
                format!("could not write {}: {error}", path.display())
            }
        }),
    }
}

/// A folder named in the settings, as a path inside the vault.
fn folder_in(root: &Path, folder: &str) -> Result<PathBuf, String> {
    let folder = folder.trim().trim_matches('/');
    let inside = Path::new(folder)
        .components()
        .all(|part| matches!(part, Component::Normal(_)));
    if !inside {
        return Err(format!(
            "the settings name a nodes folder outside the vault: {folder}"
        ));
    }
    Ok(root.join(folder))
}

fn is_on(root: &Path, plugin: &str) -> bool {
    read_capped(&root.join(CORE_PLUGINS_PATH), MAX_JSON_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get(plugin).and_then(Value::as_bool))
        .unwrap_or(false)
}

/// The text of a node type's template note. The plugin applies a template
/// only when the vault's Templates feature is on and names a folder.
fn template_text(root: &Path, kind: &NodeKind) -> Option<String> {
    let name = kind.template.as_deref()?;
    if !is_on(root, "templates") {
        return None;
    }
    let settings = read_capped(&root.join(TEMPLATES_SETTINGS_PATH), MAX_JSON_BYTES)
        .ok()
        .flatten()?;
    let settings: Value = serde_json::from_slice(&settings).ok()?;
    let folder = folder_in(root, &string_field(&settings, "folder")?).ok()?;
    let path = folder.join(format!("{name}{NOTE_SUFFIX}"));
    let bytes = read_capped(&path, MAX_NOTE_BYTES).ok().flatten()?;
    String::from_utf8(bytes).ok()
}

/// A template's frontmatter entries and its body. The entries leave out
/// the two ids: a new note states its own type, and an instance id copied
/// from the template would be shared by every note made from it.
fn split_template(text: &str) -> (String, String) {
    let Some(front) = front_of(text).filter(|front| front.closed) else {
        let body = text.strip_prefix('\u{feff}').unwrap_or(text);
        return (String::new(), body.to_string());
    };
    let mut entries = String::new();
    let mut dropping = false;
    for line in text[front.start..front.close].split_inclusive('\n') {
        let continues = line.starts_with([' ', '\t', '-', '#']) || line.trim().is_empty();
        if !continues {
            let key = line.split_once(':').map_or(line, |(key, _)| key).trim_end();
            dropping = key == TYPE_KEY || key == INSTANCE_KEY;
        }
        if !dropping {
            entries.push_str(line.trim_end_matches(['\r', '\n']));
            entries.push('\n');
        }
    }
    let after = &text[front.close..];
    let body = after.split_once('\n').map_or("", |(_, body)| body);
    (entries, body.to_string())
}

/// A frontmatter value that YAML reads back as the same text.
fn yaml_text(value: &str) -> String {
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        && !value.starts_with('-');
    if plain {
        value.to_string()
    } else {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

fn note_text(kind: &NodeKind, id: &str, template: Option<&str>, body: Option<&str>) -> String {
    let (entries, template_body) = template.map(split_template).unwrap_or_default();
    let mut text = format!("---\n{TYPE_KEY}: {}\n{entries}", yaml_text(&kind.id));
    text.push_str(&format!("{INSTANCE_KEY}: {id}\n---\n"));
    match body.map(str::trim_end).filter(|body| !body.is_empty()) {
        Some(body) => {
            text.push_str(body);
            text.push('\n');
        }
        None => text.push_str(&template_body),
    }
    text
}

/// Creates a node note. `type_name` is a node type's id, name, prefix or
/// tag. An existing note with the same name is never replaced.
pub fn create_node(
    vault: &Path,
    type_name: &str,
    text: &str,
    body: Option<&str>,
) -> Result<CreatedNode, String> {
    let root = open_vault(vault)?;
    let schema = load_schema(&root)?;
    let kind = find_node_kind(&schema.types, type_name)?;
    let title = title_for(kind, text)?;

    // The plugin looks the name up across the whole vault, because a link
    // to it must lead to one note.
    if let Some(taken) = walk(&root, true)
        .into_iter()
        .find(|path| same(&stem_of(path), &title))
    {
        return Err(format!(
            "a note named {title} already exists at {}",
            taken.display()
        ));
    }

    let folder = kind
        .folder
        .as_deref()
        .or(schema.nodes_folder.as_deref())
        .unwrap_or_default();
    let dir = folder_in(&root, folder)?;
    fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let path = dir.join(format!("{title}{NOTE_SUFFIX}"));

    let id = new_id();
    let template = template_text(&root, kind);
    let content = note_text(kind, &id, template.as_deref(), body);
    write_new(&path, content.as_bytes())?;
    Ok(CreatedNode {
        id,
        title,
        path: text_of(&path),
    })
}

fn list_paths(root: &Path, notes: &[&Note]) -> String {
    notes
        .iter()
        .map(|note| format!("  {}", relative(root, &note.path)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Finds the note a person means: an absolute path, a path from the vault
/// root, or a note's name, each with or without `.md`. A name that several
/// notes share is an error that lists them.
fn find_note<'a>(root: &Path, notes: &'a [Note], wanted: &str) -> Result<&'a Note, String> {
    let wanted = wanted.trim();
    let wanted = wanted
        .strip_prefix("[[")
        .and_then(|rest| rest.strip_suffix("]]"))
        .unwrap_or(wanted);
    if wanted.is_empty() {
        return Err(String::from("a note name is empty"));
    }
    let as_path = root.join(wanted);
    let with_suffix = PathBuf::from(format!("{}{NOTE_SUFFIX}", as_path.display()));
    if let Some(file) = [as_path, with_suffix].iter().find(|path| path.is_file()) {
        let real = fs::canonicalize(file).map_err(|error| format!("{wanted}: {error}"))?;
        return notes.iter().find(|note| note.path == real).ok_or_else(|| {
            format!(
                "{} is not a note in the vault at {}",
                real.display(),
                root.display()
            )
        });
    }
    let name = wanted.strip_suffix(NOTE_SUFFIX).unwrap_or(wanted);
    let exact: Vec<&Note> = notes
        .iter()
        .filter(|note| stem_of(&note.path) == name)
        .collect();
    let matches = if exact.is_empty() {
        notes
            .iter()
            .filter(|note| same(&stem_of(&note.path), name))
            .collect()
    } else {
        exact
    };
    match matches.as_slice() {
        [] => Err(format!(
            "no note named {name} in {}. `kd nodes` lists the nodes.",
            root.display()
        )),
        [only] => Ok(only),
        many => Err(format!(
            "{name} names {} notes. Pass one of these paths instead:\n{}",
            many.len(),
            list_paths(root, many)
        )),
    }
}

/// Holds the vault's write lock until dropped, so two writers on this
/// machine take turns. The lock file lives outside the vault.
fn lock_vault(root: &Path) -> Option<File> {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in root.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let path = std::env::temp_dir().join(format!("vault-write-{hash:016x}.lock"));
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .ok()?;
    file.lock().ok()?;
    Some(file)
}

/// The note's instance id. A note without one gets one written into its
/// frontmatter, as the plugin does the first time it needs it.
fn ensure_instance_id(note: &Note) -> Result<String, String> {
    let path = &note.path;
    let bytes =
        read_capped(path, MAX_NOTE_BYTES)?.ok_or_else(|| format!("{} is gone", path.display()))?;
    let text =
        String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text", path.display()))?;
    // Read again from the whole file: the note may have been given an id
    // since the vault was listed.
    if let Some(id) = value_of(&text, INSTANCE_KEY) {
        return Ok(id);
    }
    let id = new_id();
    let changed =
        with_instance_id(&text, &id).map_err(|error| format!("{}: {error}", path.display()))?;
    write_replacing(path, changed.as_bytes())?;
    Ok(id)
}

struct Ends<'a> {
    source: &'a str,
    destination: &'a str,
    type_id: &'a str,
}

fn empty_relations() -> Value {
    json!({ "version": RELATIONS_VERSION, "lastModified": 0, "relations": {} })
}

/// Adds one entry to the relations file's JSON and returns the new id.
/// Everything already in the file is kept as it was, known or not.
fn insert_relation(doc: &mut Value, ends: &Ends, now: u64) -> Result<String, String> {
    let top = doc
        .as_object_mut()
        .ok_or_else(|| format!("{RELATIONS_FILE} does not hold a JSON object"))?;
    match top.get("version") {
        None => {
            top.insert(String::from("version"), json!(RELATIONS_VERSION));
        }
        Some(version) if version.as_u64() == Some(RELATIONS_VERSION) => {}
        Some(version) => {
            return Err(format!(
                "{RELATIONS_FILE} is version {version}, and only version \
                 {RELATIONS_VERSION} is understood, so it was left alone"
            ));
        }
    }
    let relations = top
        .entry("relations")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| format!("{RELATIONS_FILE} has a `relations` entry that is not an object"))?;
    let field =
        |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
    for (key, entry) in relations.iter() {
        if field(entry, "type").as_deref() != Some(ends.type_id) {
            continue;
        }
        let (from, to) = (field(entry, "source"), field(entry, "destination"));
        let (from, to) = (from.as_deref(), to.as_deref());
        let existing = field(entry, "id").unwrap_or_else(|| key.clone());
        if from == Some(ends.source) && to == Some(ends.destination) {
            return Err(format!("that relation already exists (id {existing})"));
        }
        // The plugin treats the same relation type between the same two
        // notes as one relation, whichever way it points.
        if from == Some(ends.destination) && to == Some(ends.source) {
            return Err(format!(
                "that relation already exists in the other direction (id {existing})"
            ));
        }
    }
    let id = new_id();
    relations.insert(
        id.clone(),
        json!({
            "id": id,
            "type": ends.type_id,
            "source": ends.source,
            "destination": ends.destination,
            "created": now,
        }),
    );
    top.insert(String::from("lastModified"), json!(now));
    Ok(id)
}

/// Reads the relations file, adds one entry and writes it back. The file
/// is read here, just before it is written, so an entry another program
/// added a moment ago is kept.
fn append_relation(root: &Path, ends: &Ends) -> Result<String, String> {
    let path = root.join(RELATIONS_FILE);
    let mut doc = match read_capped(&path, MAX_JSON_BYTES)? {
        None => empty_relations(),
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "{RELATIONS_FILE} is not valid JSON (line {}, column {}), so it was left alone",
                error.line(),
                error.column()
            )
        })?,
    };
    let id = insert_relation(&mut doc, ends, now_ms())?;
    let text = serde_json::to_string_pretty(&doc)
        .map_err(|error| format!("could not write {RELATIONS_FILE}: {error}"))?;
    write_replacing(&path, text.as_bytes())?;
    Ok(id)
}

fn type_name<'a>(types: &'a VaultTypes, id: &'a str) -> &'a str {
    types
        .node_types
        .iter()
        .find(|kind| kind.id == id)
        .map_or(id, |kind| kind.name.as_str())
}

/// Why a relation between two node types is refused, with what the vault
/// does allow between them.
fn not_allowed(types: &VaultTypes, source: &str, relation: &RelationKind, to: &str) -> String {
    let (from_name, to_name) = (type_name(types, source), type_name(types, to));
    let between: Vec<&Triple> = types
        .allowed
        .iter()
        .filter(|triple| {
            (triple.source_id == source && triple.destination_id == to)
                || (triple.source_id == to && triple.destination_id == source)
        })
        .collect();
    let allowed = if between.is_empty() {
        format!("Nothing is allowed between {from_name} and {to_name}.")
    } else {
        format!(
            "Allowed between {from_name} and {to_name}:\n{}",
            between
                .iter()
                .map(|triple| format!("  {}", triple.sentence))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        "\"{from_name} {} {to_name}\" is not a relation this vault allows.\n{allowed}\n\
         Swap the two notes if the direction is wrong. Force (`--force`) adds it anyway.",
        relation.label
    )
}

fn node_type_of<'a>(root: &Path, note: &'a Note) -> Result<&'a str, String> {
    note.type_id.as_deref().ok_or_else(|| {
        format!(
            "{} is not a node: its frontmatter has no {TYPE_KEY}",
            relative(root, &note.path)
        )
    })
}

fn refuse_shared_id(root: &Path, notes: &[Note], note: &Note) -> Result<(), String> {
    let Some(id) = note.instance_id.as_deref() else {
        return Ok(());
    };
    let holders: Vec<&Note> = notes
        .iter()
        .filter(|other| other.instance_id.as_deref() == Some(id))
        .collect();
    if holders.len() < 2 {
        return Ok(());
    }
    Err(format!(
        "{} notes share the instance id {id}, so a relation to it could mean any of them:\n{}\n\
         Give each note its own {INSTANCE_KEY}, or force (`--force`) to add the relation anyway.",
        holders.len(),
        list_paths(root, &holders)
    ))
}

/// Adds a relation between two notes to the vault's relations file.
/// `source` and `destination` each name a note by path or by name, and
/// `relation` is a relation type's id or label. `force` adds a relation
/// the vault's settings do not allow.
pub fn add_relation(
    vault: &Path,
    source: &str,
    relation: &str,
    destination: &str,
    force: bool,
) -> Result<AddedRelation, String> {
    let root = open_vault(vault)?;
    let schema = load_schema(&root)?;
    let types = &schema.types;
    let kind = find_relation_kind(types, relation)?;
    let notes = read_notes(&root);
    let from = find_note(&root, &notes, source)?;
    let to = find_note(&root, &notes, destination)?;
    if from.path == to.path {
        return Err(String::from("a note cannot be related to itself"));
    }
    let (from_type, to_type) = (node_type_of(&root, from)?, node_type_of(&root, to)?);
    if !force {
        let allowed = types.allowed.iter().any(|triple| {
            triple.source_id == from_type
                && triple.relation_id == kind.id
                && triple.destination_id == to_type
        });
        if !allowed {
            return Err(not_allowed(types, from_type, kind, to_type));
        }
        refuse_shared_id(&root, &notes, from)?;
        refuse_shared_id(&root, &notes, to)?;
    }

    let _lock = lock_vault(&root);
    let source_id = ensure_instance_id(from)?;
    let destination_id = ensure_instance_id(to)?;
    let id = append_relation(
        &root,
        &Ends {
            source: &source_id,
            destination: &destination_id,
            type_id: &kind.id,
        },
    )?;
    Ok(AddedRelation {
        id,
        sentence: format!(
            "{} {} {}",
            stem_of(&from.path),
            kind.label,
            stem_of(&to.path)
        ),
    })
}

/// Where the skill file goes in a vault.
pub fn skill_destination(vault: &Path) -> PathBuf {
    vault.join(SKILL_PATH)
}

/// Copies the skill file into a vault. A file that is already there and
/// differs is kept unless `force` is set.
pub fn install_skill(vault: &Path, force: bool) -> Result<(PathBuf, SkillInstall), String> {
    let root = open_vault(vault)?;
    let path = skill_destination(&root);
    match fs::read(&path) {
        Ok(existing) if existing == SKILL_TEXT.as_bytes() => {
            return Ok((path, SkillInstall::Unchanged));
        }
        Ok(_) if !force => {
            return Err(format!(
                "{} exists and differs from the skill this tool ships. \
                 Pass --force to replace it.",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("{}: {error}", path.display())),
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    }
    write_replacing(&path, SKILL_TEXT.as_bytes())?;
    Ok((path, SkillInstall::Written))
}

fn resolve(path: &str) -> PathBuf {
    let home = std::env::var("HOME").ok();
    PathBuf::from(expand_home(path, home.as_deref()))
}

#[tauri::command(async)]
pub fn graph_vault_root(path: String) -> Option<String> {
    vault_root(&resolve(&path)).map(|root| text_of(&root))
}

#[tauri::command(async)]
pub fn graph_types(vault: String) -> Result<VaultTypes, String> {
    vault_types(&resolve(&vault))
}

#[tauri::command(async)]
pub fn graph_create_node(
    vault: String,
    type_id: String,
    text: String,
    body: Option<String>,
) -> Result<CreatedNode, String> {
    create_node(&resolve(&vault), &type_id, &text, body.as_deref())
}

#[tauri::command(async)]
pub fn graph_add_relation(
    vault: String,
    source: String,
    relation: String,
    destination: String,
    force: Option<bool>,
) -> Result<AddedRelation, String> {
    add_relation(
        &resolve(&vault),
        &source,
        &relation,
        &destination,
        force.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "correct-horse-battery-staple";
    const ACCOUNT: &str = "account-1745604720";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("write-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn write(root: &Path, name: &str, text: &str) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn read(path: impl AsRef<Path>) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn settings(nodes_folder: &str) -> String {
        json!({
            "nodeTypes": [
                {"id": "node_q", "name": "Question", "format": "QUE - {content}", "tag": "que-candidate"},
                {"id": "node_c", "name": "Claim", "format": "CLM - {content}", "tag": "#clm-candidate", "color": "#2E9E82"},
                {"id": "node_e", "name": "Evidence", "format": "EVD - {content}"},
                {"id": "node_h", "name": "Hypothesis", "format": "HYP- {content}"},
                {"id": "node_s", "name": "Source", "format": "@{content}", "folderPath": "Sources"},
                {"name": "no id, so it is left out"}
            ],
            "relationTypes": [
                {"id": "rel_s", "label": "supports", "complement": "is supported by", "color": "green"},
                {"id": "rel_o", "label": "opposes", "complement": "is opposed by"},
                {"id": "rel_i", "label": "informs", "complement": "is informed by"}
            ],
            "discourseRelations": [
                {"id": "t1", "sourceId": "node_e", "destinationId": "node_c", "relationshipTypeId": "rel_s"},
                {"id": "t2", "sourceId": "node_e", "destinationId": "node_c", "relationshipTypeId": "rel_o"},
                {"id": "t3", "sourceId": "node_e", "destinationId": "node_q", "relationshipTypeId": "rel_i"},
                {"id": "t4", "sourceId": "node_gone", "destinationId": "node_q", "relationshipTypeId": "rel_i"}
            ],
            "nodesFolderPath": nodes_folder,
            "spacePassword": SECRET,
            "accountLocalId": ACCOUNT,
            "spaceNames": {"space": SECRET}
        })
        .to_string()
    }

    fn vault(name: &str) -> PathBuf {
        let root = scratch(name);
        write(&root, SETTINGS_PATH, &settings("Graph"));
        root
    }

    fn types() -> VaultTypes {
        schema_from(settings("").as_bytes()).unwrap().types
    }

    fn note(type_id: &str, id: &str) -> String {
        format!("---\n{TYPE_KEY}: {type_id}\n{INSTANCE_KEY}: {id}\n---\nBody.\n")
    }

    fn relations(root: &Path) -> Value {
        serde_json::from_str(&read(root.join(RELATIONS_FILE))).unwrap()
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn the_vault_root_is_the_nearest_directory_with_the_marker() {
        let root = scratch("root");
        fs::create_dir_all(root.join("lab/.obsidian")).unwrap();
        write(&root, "lab/notes/deep/a.md", "x");

        let lab = root.join("lab");
        assert_eq!(vault_root(&lab), Some(lab.clone()));
        assert_eq!(vault_root(&lab.join("notes/deep")), Some(lab.clone()));
        assert_eq!(vault_root(&lab.join("notes/deep/a.md")), Some(lab.clone()));
        assert_eq!(vault_root(&lab.join("notes/deep/new.md")), Some(lab));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_node_type_is_found_by_id_name_prefix_or_tag() {
        let types = types();
        let id_of = |wanted: &str| find_node_kind(&types, wanted).map(|kind| kind.id.clone());
        for wanted in [
            "node_c",
            "claim",
            "CLAIM",
            "clm",
            "CLM",
            "clm-candidate",
            "#CLM-candidate",
        ] {
            assert_eq!(id_of(wanted), Ok(String::from("node_c")), "{wanted}");
        }
        assert_eq!(id_of("que-candidate"), Ok(String::from("node_q")));
        assert_eq!(id_of("hyp"), Ok(String::from("node_h")));
        assert_eq!(id_of("@"), Ok(String::from("node_s")));
        let missing = id_of("theorem").unwrap_err();
        assert!(missing.contains("no node type called theorem"), "{missing}");
        assert!(missing.contains("Question, Claim, Evidence"), "{missing}");
    }

    #[test]
    fn a_name_that_two_node_types_share_is_refused() {
        let mut types = types();
        types.node_types[1].name = String::from("question");
        let error = find_node_kind(&types, "Question").unwrap_err();
        assert!(error.contains("more than one node type"), "{error}");
        assert!(
            error.contains("node_q") && error.contains("node_c"),
            "{error}"
        );
    }

    #[test]
    fn a_relation_type_is_found_by_id_or_label() {
        let types = types();
        let id_of = |wanted: &str| find_relation_kind(&types, wanted).map(|kind| kind.id.clone());
        assert_eq!(id_of("rel_s"), Ok(String::from("rel_s")));
        assert_eq!(id_of("Supports"), Ok(String::from("rel_s")));
        let missing = id_of("proves").unwrap_err();
        assert!(missing.contains("supports, opposes, informs"), "{missing}");
    }

    #[test]
    fn allowed_relations_are_given_in_words() {
        let sentences: Vec<String> = types()
            .allowed
            .into_iter()
            .map(|triple| triple.sentence)
            .collect();
        assert_eq!(
            sentences,
            [
                "Evidence supports Claim",
                "Evidence opposes Claim",
                "Evidence informs Question"
            ]
        );
    }

    #[test]
    fn a_title_follows_the_format_and_is_safe_as_a_file_name() {
        let types = types();
        let title = |kind: &str, text: &str| title_for(find_node_kind(&types, kind).unwrap(), text);
        assert_eq!(
            title("claim", "Sleep loss reduces working memory."),
            Ok(String::from("CLM - Sleep loss reduces working memory."))
        );
        assert_eq!(
            title(
                "claim",
                "  a #tag, a [[link|alias]] and a ^block\n\n on  two\tlines "
            ),
            Ok(String::from(
                "CLM - a tag, a linkalias and a block on two lines"
            ))
        );
        assert_eq!(
            title("question", "Is it 10:30 and/or C:\\late?"),
            Ok(String::from("QUE - Is it 10-30 and-or C--late?"))
        );
        assert_eq!(title("source", "smith2020"), Ok(String::from("@smith2020")));
        let mut bare = types.node_types[0].clone();
        bare.format = String::from("{content}");
        assert_eq!(title_for(&bare, " ..hidden"), Ok(String::from("hidden")));
        assert_eq!(title("hyp", "x"), Ok(String::from("HYP- x")));
        assert_eq!(
            title("claim", " #|[] "),
            Err(String::from("the node text is empty"))
        );
    }

    #[test]
    fn a_long_title_is_cut_between_characters() {
        let types = types();
        let kind = find_node_kind(&types, "claim").unwrap();
        let title = title_for(kind, &"é".repeat(400)).unwrap();
        assert!(title.len() <= MAX_TITLE_BYTES, "{}", title.len());
        assert!(title.starts_with("CLM - éé"));
        assert_eq!(title.chars().filter(|c| *c == 'é').count(), 97);
    }

    #[test]
    fn a_format_without_a_content_placeholder_cannot_make_a_title() {
        let mut types = types();
        types.node_types[0].format = String::from("QUE - ");
        assert!(title_for(&types.node_types[0], "x")
            .unwrap_err()
            .contains("no {content}"));
        types.node_types[0].format = String::from("{content} - {Source}");
        assert!(title_for(&types.node_types[0], "x")
            .unwrap_err()
            .contains("other than {content}"));
        types.node_types[0].format = String::from("a/{content}");
        assert!(title_for(&types.node_types[0], "x")
            .unwrap_err()
            .contains("path separator"));
    }

    #[test]
    fn a_new_id_is_a_version_7_uuid_and_later_ids_sort_later() {
        let ids: Vec<String> = (0..2000).map(|_| new_id()).collect();
        for id in &ids {
            let bytes = id.as_bytes();
            assert_eq!(id.len(), 36, "{id}");
            for (at, byte) in bytes.iter().enumerate() {
                if [8, 13, 18, 23].contains(&at) {
                    assert_eq!(*byte, b'-', "{id}");
                } else {
                    assert!(matches!(byte, b'0'..=b'9' | b'a'..=b'f'), "{id}");
                }
            }
            assert_eq!(bytes[14], b'7', "{id}");
            assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'), "{id}");
        }
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
        // The first 48 bits are the time in milliseconds.
        let stamp = u64::from_str_radix(&ids[0].replace('-', "")[..12], 16).unwrap();
        assert!(now_ms().abs_diff(stamp) < 60_000);
    }

    #[test]
    fn a_node_is_written_as_the_plugin_writes_one() {
        let root = vault("create");
        let made = create_node(&root, "claim", "Sleep loss reduces working memory", None).unwrap();

        let path = root.join("Graph/CLM - Sleep loss reduces working memory.md");
        assert_eq!(made.path, text_of(&path));
        assert_eq!(made.title, "CLM - Sleep loss reduces working memory");
        assert_eq!(
            read(&path),
            format!(
                "---\nnodeTypeId: node_c\nnodeInstanceId: {}\n---\n",
                made.id
            )
        );
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644);
        assert_eq!(leftovers(&root.join("Graph")), Vec::<String>::new());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_node_takes_its_body_and_its_folder() {
        let root = scratch("folders");
        write(&root, SETTINGS_PATH, &settings(""));
        let claim = create_node(
            &root,
            "CLM",
            "At the root",
            Some("Line one.\n\nLine two.\n\n\n"),
        );
        let claim = claim.unwrap();
        assert_eq!(claim.path, text_of(&root.join("CLM - At the root.md")));
        assert_eq!(
            read(&claim.path),
            format!(
                "---\nnodeTypeId: node_c\nnodeInstanceId: {}\n---\nLine one.\n\nLine two.\n",
                claim.id
            )
        );
        // A node type's own folder comes before the vault's.
        write(&root, SETTINGS_PATH, &settings("Graph"));
        let source = create_node(&root, "source", "smith2020", None).unwrap();
        assert_eq!(source.path, text_of(&root.join("Sources/@smith2020.md")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_existing_note_is_never_replaced() {
        let root = vault("exists");
        write(&root, "old/clm - taken.md", "mine\n");
        let error = create_node(&root, "claim", "Taken", Some("new")).unwrap_err();
        assert_eq!(
            error,
            format!(
                "a note named CLM - Taken already exists at {}",
                root.join("old/clm - taken.md").display()
            )
        );
        assert_eq!(read(root.join("old/clm - taken.md")), "mine\n");
        assert!(!root.join("Graph/CLM - Taken.md").exists());

        let first = create_node(&root, "claim", "Once", None).unwrap();
        let before = read(&first.path);
        let again = create_node(&root, "claim", "Once", Some("other")).unwrap_err();
        assert!(again.contains(&first.path), "{again}");
        assert_eq!(read(&first.path), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_file_made_by_another_program_first_is_left_alone() {
        let root = scratch("race");
        let path = root.join("note.md");
        fs::write(&path, "theirs").unwrap();
        let error = write_new(&path, b"ours").unwrap_err();
        assert!(error.ends_with("already exists"), "{error}");
        assert_eq!(read(&path), "theirs");
        assert_eq!(leftovers(&root), Vec::<String>::new());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_nodes_folder_outside_the_vault_is_refused() {
        let root = scratch("escape");
        write(&root, SETTINGS_PATH, &settings("../elsewhere"));
        let error = create_node(&root, "claim", "x", None).unwrap_err();
        assert!(error.contains("outside the vault"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    fn with_templates(root: &Path) {
        let mut value: Value = serde_json::from_str(&settings("Graph")).unwrap();
        value["nodeTypes"][1]["template"] = json!("Claim");
        write(root, SETTINGS_PATH, &value.to_string());
        write(root, CORE_PLUGINS_PATH, r#"{"templates": true}"#);
        write(
            root,
            TEMPLATES_SETTINGS_PATH,
            r#"{"folder": "Meta/Templates"}"#,
        );
        write(
            root,
            "Meta/Templates/Claim.md",
            "---\nnodeTypeId: node_old\ntemplate: \"[[Claim]]\"\ntags:\n  - one\n- two\n\
             cssclasses: dg-clm\nnodeInstanceId: template-id\nconfidence:\n---\n# Summary\n\n# Notes\n",
        );
    }

    #[test]
    fn a_template_gives_a_node_its_entries_and_body_but_never_its_ids() {
        let root = vault("template");
        with_templates(&root);
        let made = create_node(&root, "claim", "From a template", None).unwrap();
        assert_eq!(
            read(&made.path),
            format!(
                "---\nnodeTypeId: node_c\ntemplate: \"[[Claim]]\"\ntags:\n  - one\n- two\n\
                 cssclasses: dg-clm\nconfidence:\nnodeInstanceId: {}\n---\n# Summary\n\n# Notes\n",
                made.id
            )
        );
        assert_ne!(made.id, "template-id");

        let own = create_node(&root, "claim", "With its own body", Some("Mine.")).unwrap();
        let text = read(&own.path);
        assert!(text.contains("cssclasses: dg-clm\n"), "{text}");
        assert!(text.ends_with("---\nMine.\n"), "{text}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_template_is_used_only_when_the_vault_has_templates_on() {
        let root = vault("template-off");
        with_templates(&root);
        write(&root, CORE_PLUGINS_PATH, r#"{"templates": false}"#);
        let made = create_node(&root, "claim", "Plain", None).unwrap();
        assert_eq!(
            read(&made.path),
            format!(
                "---\nnodeTypeId: node_c\nnodeInstanceId: {}\n---\n",
                made.id
            )
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_instance_id_is_added_without_disturbing_the_rest() {
        let odd = "---\n# a comment\nnodeTypeId:   node_c  \ntags:   [a,  b]\n\n\
                   aliases:\n    - \"x: y\"\n---\n\n# Body\n---\nnot frontmatter: 1\n";
        assert_eq!(
            with_instance_id(odd, "ID").unwrap(),
            "---\n# a comment\nnodeTypeId:   node_c  \ntags:   [a,  b]\n\n\
             aliases:\n    - \"x: y\"\nnodeInstanceId: ID\n---\n\n# Body\n---\nnot frontmatter: 1\n"
        );
        // An entry with no value is filled in where it stands.
        assert_eq!(
            with_instance_id("---\nnodeInstanceId:   \nnodeTypeId: t\n---\nBody", "ID").unwrap(),
            "---\nnodeInstanceId: ID\nnodeTypeId: t\n---\nBody"
        );
        // Windows line ends and a byte order mark are kept.
        assert_eq!(
            with_instance_id("\u{feff}---\r\nnodeTypeId: t\r\n---\r\nBody\r\n", "ID").unwrap(),
            "\u{feff}---\r\nnodeTypeId: t\r\nnodeInstanceId: ID\r\n---\r\nBody\r\n"
        );
        assert_eq!(
            with_instance_id("---\nnodeTypeId: t\n...\nBody", "ID").unwrap(),
            "---\nnodeTypeId: t\nnodeInstanceId: ID\n...\nBody"
        );
        assert!(with_instance_id("---\nnodeTypeId: t\n", "ID").is_err());
        assert!(with_instance_id("# No frontmatter\n", "ID").is_err());
    }

    #[test]
    fn frontmatter_values_are_read_as_the_graph_reader_reads_them() {
        let text = "---\nnodeTypeId: \"node_c\"\n nodeInstanceId: indented\nnodeInstanceId: 'id-1'\n---\nnodeTypeId: body\n";
        assert_eq!(value_of(text, TYPE_KEY).as_deref(), Some("node_c"));
        assert_eq!(value_of(text, INSTANCE_KEY).as_deref(), Some("id-1"));
        assert_eq!(value_of("nodeTypeId: x\n", TYPE_KEY), None);
        assert_eq!(value_of("---\nnodeTypeId:\n---\n", TYPE_KEY), None);
    }

    fn linked_vault(name: &str) -> PathBuf {
        let root = vault(name);
        write(&root, "Graph/EVD - birds fly.md", &note("node_e", "id-e"));
        write(
            &root,
            "Graph/CLM - birds have wings.md",
            &note("node_c", "id-c"),
        );
        write(&root, "Graph/QUE - why fly.md", &note("node_q", "id-q"));
        root
    }

    #[test]
    fn a_relation_is_added_and_the_file_is_made_when_absent() {
        let root = linked_vault("relate");
        let before = now_ms();
        let added = add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "CLM - birds have wings",
            false,
        )
        .unwrap();
        assert_eq!(
            added.sentence,
            "EVD - birds fly supports CLM - birds have wings"
        );

        let text = read(root.join(RELATIONS_FILE));
        assert!(
            text.starts_with("{\n  \"version\": 1,\n  \"lastModified\": "),
            "{text}"
        );
        let file = relations(&root);
        let entry = &file["relations"][&added.id];
        let keys: Vec<&String> = entry.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "type", "source", "destination", "created"]);
        assert_eq!(entry["id"], json!(added.id));
        assert_eq!(entry["type"], json!("rel_s"));
        assert_eq!(entry["source"], json!("id-e"));
        assert_eq!(entry["destination"], json!("id-c"));
        let created = entry["created"].as_u64().unwrap();
        assert!(created >= before && created <= now_ms());
        assert_eq!(file["lastModified"], json!(created));
        assert_eq!(leftovers(&root), Vec::<String>::new());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_note_is_named_by_path_or_by_title() {
        let root = linked_vault("names");
        let claim = root.join("Graph/CLM - birds have wings.md");
        let ways = [
            text_of(&claim),
            String::from("Graph/CLM - birds have wings.md"),
            String::from("Graph/CLM - birds have wings"),
            String::from("CLM - birds have wings.md"),
            String::from("CLM - birds have wings"),
            String::from("clm - Birds have wings"),
            String::from("[[CLM - birds have wings]]"),
        ];
        let notes = read_notes(&root);
        for way in ways {
            let found = find_note(&root, &notes, &way).map(|note| note.path.clone());
            assert_eq!(found, Ok(claim.clone()), "{way}");
        }
        let missing = find_note(&root, &notes, "CLM - nope").unwrap_err();
        assert!(missing.contains("no note named CLM - nope"), "{missing}");
        let outside = find_note(&root, &notes, &text_of(&root.join(SETTINGS_PATH))).unwrap_err();
        assert!(outside.contains("is not a note in the vault"), "{outside}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_title_that_several_notes_share_lists_them() {
        let root = linked_vault("ambiguous");
        write(
            &root,
            "Archive/CLM - birds have wings.md",
            &note("node_c", "id-c2"),
        );
        let error = add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "CLM - birds have wings",
            false,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "CLM - birds have wings names 2 notes. Pass one of these paths instead:\n  \
             Archive/CLM - birds have wings.md\n  Graph/CLM - birds have wings.md"
        );
        assert!(!root.join(RELATIONS_FILE).exists());
        // An exact name wins over one that differs in case.
        write(
            &root,
            "Archive/evd - BIRDS fly.md",
            &note("node_e", "id-e2"),
        );
        add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "Graph/CLM - birds have wings",
            false,
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_relation_the_vault_does_not_allow_is_refused_with_what_is() {
        let root = linked_vault("allowed");
        let error = add_relation(
            &root,
            "CLM - birds have wings",
            "supports",
            "EVD - birds fly",
            false,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "\"Claim supports Evidence\" is not a relation this vault allows.\n\
             Allowed between Claim and Evidence:\n  Evidence supports Claim\n  Evidence opposes Claim\n\
             Swap the two notes if the direction is wrong. Force (`--force`) adds it anyway."
        );
        let none = add_relation(
            &root,
            "CLM - birds have wings",
            "informs",
            "QUE - why fly",
            false,
        )
        .unwrap_err();
        assert!(
            none.contains("Nothing is allowed between Claim and Question."),
            "{none}"
        );
        assert!(!root.join(RELATIONS_FILE).exists());

        let forced = add_relation(
            &root,
            "CLM - birds have wings",
            "informs",
            "QUE - why fly",
            true,
        );
        let forced = forced.unwrap();
        assert_eq!(
            relations(&root)["relations"][&forced.id]["type"],
            json!("rel_i")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_same_relation_is_not_added_twice_in_either_direction() {
        let root = linked_vault("duplicate");
        let first = add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "CLM - birds have wings",
            false,
        )
        .unwrap();
        let text = read(root.join(RELATIONS_FILE));
        let again = add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "CLM - birds have wings",
            false,
        );
        assert_eq!(
            again,
            Err(format!("that relation already exists (id {})", first.id))
        );
        let reversed = add_relation(
            &root,
            "CLM - birds have wings",
            "supports",
            "EVD - birds fly",
            true,
        );
        assert_eq!(
            reversed,
            Err(format!(
                "that relation already exists in the other direction (id {})",
                first.id
            ))
        );
        assert_eq!(read(root.join(RELATIONS_FILE)), text);
        // Another relation type between the same two notes is a new relation.
        add_relation(
            &root,
            "EVD - birds fly",
            "opposes",
            "CLM - birds have wings",
            false,
        )
        .unwrap();
        assert_eq!(relations(&root)["relations"].as_object().unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_note_without_an_instance_id_gets_one_and_keeps_its_text() {
        let root = linked_vault("lazy");
        let path = root.join("Graph/EVD - no id.md");
        fs::write(
            &path,
            "---\n# kept\nnodeTypeId: node_e\ntags:  [a,b]\n---\n\nBody stays.\n",
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        let added = add_relation(
            &root,
            "EVD - no id",
            "supports",
            "CLM - birds have wings",
            false,
        );
        let added = added.unwrap();
        let source = relations(&root)["relations"][&added.id]["source"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(source.len(), 36);
        assert_eq!(
            read(&path),
            format!(
                "---\n# kept\nnodeTypeId: node_e\ntags:  [a,b]\nnodeInstanceId: {source}\n---\n\nBody stays.\n"
            )
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // The note that had an id is untouched.
        assert_eq!(
            read(root.join("Graph/CLM - birds have wings.md")),
            note("node_c", "id-c")
        );
        // The second relation uses the id written by the first.
        let next = add_relation(&root, "EVD - no id", "informs", "QUE - why fly", false).unwrap();
        assert_eq!(
            relations(&root)["relations"][&next.id]["source"],
            json!(source)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_note_that_is_not_a_node_cannot_be_related() {
        let root = linked_vault("plain");
        write(&root, "plain.md", "# Just a note\n");
        let error = add_relation(&root, "plain", "supports", "CLM - birds have wings", false);
        assert_eq!(
            error,
            Err(String::from(
                "plain.md is not a node: its frontmatter has no nodeTypeId"
            ))
        );
        let own = add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "Graph/EVD - birds fly.md",
            true,
        );
        assert_eq!(own, Err(String::from("a note cannot be related to itself")));
        assert_eq!(read(root.join("plain.md")), "# Just a note\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_that_share_an_instance_id_are_not_related_unless_forced() {
        let root = linked_vault("shared");
        write(&root, "Graph/CLM - a copy.md", &note("node_c", "id-c"));
        // A template may hold the same id. It is not a node, so it does not count.
        write(&root, "Templates/Evidence.md", &note("node_e", "id-e"));
        let error =
            add_relation(&root, "EVD - birds fly", "supports", "CLM - a copy", false).unwrap_err();
        assert!(
            error.starts_with("2 notes share the instance id id-c"),
            "{error}"
        );
        assert!(
            error.contains("  Graph/CLM - a copy.md\n  Graph/CLM - birds have wings.md"),
            "{error}"
        );
        assert!(!root.join(RELATIONS_FILE).exists());
        add_relation(&root, "EVD - birds fly", "supports", "CLM - a copy", true).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    const EXISTING: &str = r#"{
  "zeta": {"kept": [1, 2.5, null, true]},
  "version": 1,
  "lastModified": 5,
  "relations": {
    "r-b": {"id": "r-b", "type": "rel_o", "source": "id-x", "destination": "id-y",
            "created": 1775758396133, "author": "someone", "tentative": false,
            "publishedToGroupId": ["g1"], "future": {"deep": {"n": 12345678901234567890}}},
    "r-a": {"type": "rel_s", "source": "id-gone", "destination": "id-c", "weird": "é\n\"q\""},
    "not-an-entry": 7
  },
  "alpha": "last"
}"#;

    #[test]
    fn everything_already_in_the_relations_file_survives_a_write() {
        let root = linked_vault("roundtrip");
        fs::write(root.join(RELATIONS_FILE), EXISTING).unwrap();
        let added = add_relation(
            &root,
            "EVD - birds fly",
            "supports",
            "CLM - birds have wings",
            false,
        )
        .unwrap();

        let before: Value = serde_json::from_str(EXISTING).unwrap();
        let after = relations(&root);
        let top: Vec<&String> = after.as_object().unwrap().keys().collect();
        assert_eq!(
            top,
            ["zeta", "version", "lastModified", "relations", "alpha"]
        );
        assert_eq!(after["zeta"], before["zeta"]);
        assert_eq!(after["alpha"], before["alpha"]);
        assert_eq!(after["version"], json!(1));
        assert!(after["lastModified"].as_u64().unwrap() > 5);
        let entries: Vec<&String> = after["relations"].as_object().unwrap().keys().collect();
        assert_eq!(entries, ["r-b", "r-a", "not-an-entry", added.id.as_str()]);
        for key in ["r-b", "r-a", "not-an-entry"] {
            assert_eq!(after["relations"][key], before["relations"][key], "{key}");
        }
        let kept: Vec<&String> = after["relations"]["r-b"]
            .as_object()
            .unwrap()
            .keys()
            .collect();
        assert_eq!(
            kept,
            [
                "id",
                "type",
                "source",
                "destination",
                "created",
                "author",
                "tentative",
                "publishedToGroupId",
                "future"
            ]
        );
        let text = read(root.join(RELATIONS_FILE));
        assert!(text.contains("12345678901234567890"), "{text}");
        assert!(!text.ends_with('\n'));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_relations_file_that_cannot_be_understood_is_left_alone() {
        let root = linked_vault("broken");
        let relate = || {
            add_relation(
                &root,
                "EVD - birds fly",
                "supports",
                "CLM - birds have wings",
                false,
            )
        };
        let cases = [
            (
                "{\"version\": 1, \"relations\": {",
                "is not valid JSON (line 1, column 29), so it was left alone",
            ),
            ("[]", "does not hold a JSON object"),
            ("{\"version\": 2, \"relations\": {}}", "is version 2"),
            (
                "{\"version\": 1, \"relations\": []}",
                "`relations` entry that is not an object",
            ),
        ];
        for (text, expected) in cases {
            fs::write(root.join(RELATIONS_FILE), text).unwrap();
            let error = relate().unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert_eq!(read(root.join(RELATIONS_FILE)), text);
        }
        // A file with no version is one the plugin would not read. It gets one.
        fs::write(root.join(RELATIONS_FILE), "{}").unwrap();
        relate().unwrap();
        assert_eq!(relations(&root)["version"], json!(1));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writers_at_the_same_time_all_keep_their_entries() {
        let root = vault("parallel");
        write(&root, "Graph/CLM - hub.md", &note("node_c", "id-hub"));
        for n in 0..8 {
            write(
                &root,
                &format!("Graph/EVD - e{n}.md"),
                &note("node_e", &format!("id-e{n}")),
            );
        }
        let workers: Vec<_> = (0..8)
            .map(|n| {
                let root = root.clone();
                std::thread::spawn(move || {
                    add_relation(
                        &root,
                        &format!("EVD - e{n}"),
                        "supports",
                        "CLM - hub",
                        false,
                    )
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap().unwrap();
        }
        assert_eq!(relations(&root)["relations"].as_object().unwrap().len(), 8);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_vault_without_the_plugin_settings_says_so() {
        let root = scratch("no-settings");
        write(&root, "CLM - a.md", &note("node_c", "id-a"));
        let expected = "has no Discourse Graphs settings";
        assert!(vault_types(&root).unwrap_err().contains(expected));
        assert!(create_node(&root, "claim", "x", None)
            .unwrap_err()
            .contains(expected));
        assert!(list_nodes(&root, None).unwrap_err().contains(expected));
        let relate = add_relation(&root, "CLM - a", "supports", "CLM - a", false);
        assert!(relate.unwrap_err().contains(expected));
        assert!(!root.join(RELATIONS_FILE).exists());
        assert!(vault_types(&root.join("missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn account_details_in_the_settings_never_leave() {
        let root = linked_vault("secrets");
        let schema = load_schema(&root).unwrap();
        let made = create_node(&root, "claim", "x", None).unwrap();
        let added = add_relation(&root, "EVD - birds fly", "supports", "CLM - x", false).unwrap();
        let refused =
            add_relation(&root, "CLM - x", "opposes", "QUE - why fly", false).unwrap_err();
        let nodes = list_nodes(&root, None).unwrap();
        let mut seen = vec![
            format!("{schema:?}"),
            format!("{made:?}{added:?}{nodes:?}"),
            serde_json::to_string(&schema.types).unwrap(),
            serde_json::to_string(&nodes).unwrap(),
            refused,
            read(&made.path),
            read(root.join(RELATIONS_FILE)),
        ];
        // Broken settings must not be quoted back in the error.
        let broken = settings("Graph").replace("\"spaceNames\"", "spaceNames");
        write(&root, SETTINGS_PATH, &broken);
        seen.push(vault_types(&root).unwrap_err());
        seen.push(create_node(&root, "claim", "y", None).unwrap_err());
        for text in seen {
            assert!(!text.contains(SECRET), "{text}");
            assert!(!text.contains(ACCOUNT), "{text}");
            assert!(!text.contains("spacePassword"), "{text}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_types_on_the_wire_use_camel_case_and_hide_file_details() {
        let value = serde_json::to_value(types()).unwrap();
        assert_eq!(
            value["nodeTypes"][1],
            json!({"id": "node_c", "name": "Claim", "format": "CLM - {content}",
                   "prefix": "CLM", "tag": "#clm-candidate", "color": "#2E9E82"})
        );
        assert_eq!(
            value["allowed"][0],
            json!({"sourceId": "node_e", "relationId": "rel_s", "destinationId": "node_c",
                   "sentence": "Evidence supports Claim"})
        );
        assert_eq!(
            value["relationTypes"][0]["complement"],
            json!("is supported by")
        );
    }

    #[test]
    fn nodes_are_listed_by_title_and_filtered_by_type() {
        let root = linked_vault("list");
        write(&root, "plain.md", "# no frontmatter\n");
        write(&root, "old.md", &note("node_retired", "id-old"));
        write(&root, "Templates/Claim.md", &note("node_c", "id-t"));
        write(
            &root,
            "board.md",
            "---\nnodeTypeId: node_c\ntldr-dg: true\n---\n",
        );
        write(&root, "CLM - no id.md", "---\nnodeTypeId: node_c\n---\n");
        let titles = |filter: Option<&str>| -> Vec<String> {
            let nodes = list_nodes(&root, filter).unwrap();
            nodes.into_iter().map(|node| node.title).collect()
        };
        assert_eq!(
            titles(None),
            [
                "CLM - birds have wings",
                "CLM - no id",
                "EVD - birds fly",
                "QUE - why fly"
            ]
        );
        assert_eq!(
            titles(Some("clm")),
            ["CLM - birds have wings", "CLM - no id"]
        );
        assert!(list_nodes(&root, Some("nope")).is_err());
        let nodes = list_nodes(&root, Some("claim")).unwrap();
        assert_eq!(nodes[0].id.as_deref(), Some("id-c"));
        assert_eq!(nodes[0].type_name.as_deref(), Some("Claim"));
        assert_eq!(nodes[1].id, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_graph_reader_shows_what_was_written() {
        let root = vault("end-to-end");
        let evidence =
            create_node(&root, "evidence", "Swifts sleep on the wing", Some("Seen.")).unwrap();
        let claim = create_node(&root, "claim", "Some birds never land", None).unwrap();
        let added = add_relation(&root, &evidence.title, "supports", &claim.path, false).unwrap();

        let graph = crate::graph::read_graph(&text_of(&root)).unwrap();
        let graph = serde_json::to_value(graph).unwrap();
        assert_eq!(graph["warnings"], json!([]));
        assert_eq!(graph["incomplete"], json!(false));
        assert_eq!(graph["skippedRelations"], json!(0));
        assert_eq!(
            graph["nodes"],
            json!([
                {"id": claim.id, "typeId": "node_c", "title": "CLM - Some birds never land",
                 "path": claim.path},
                {"id": evidence.id, "typeId": "node_e", "title": "EVD - Swifts sleep on the wing",
                 "path": evidence.path}
            ])
        );
        assert_eq!(
            graph["relations"],
            json!([{"id": added.id, "typeId": "rel_s", "source": evidence.id,
                    "destination": claim.id, "ambiguous": false, "tentative": null}])
        );
        // The reader's change mark moves when a node is added.
        let mark = crate::graph::fingerprint(&text_of(&root)).unwrap();
        create_node(&root, "question", "Do swifts ever land", None).unwrap();
        assert_ne!(crate::graph::fingerprint(&text_of(&root)).unwrap(), mark);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_skill_is_installed_once_and_a_changed_copy_is_kept() {
        let root = vault("skill");
        let path = root.join(".claude/skills/discourse-graph/SKILL.md");
        assert_eq!(
            install_skill(&root, false),
            Ok((path.clone(), SkillInstall::Written))
        );
        assert_eq!(read(&path), SKILL_TEXT);
        assert_eq!(
            install_skill(&root, false),
            Ok((path.clone(), SkillInstall::Unchanged))
        );

        fs::write(&path, "my own notes").unwrap();
        let error = install_skill(&root, false).unwrap_err();
        assert!(error.contains("exists and differs"), "{error}");
        assert_eq!(read(&path), "my own notes");
        assert_eq!(
            install_skill(&root, true),
            Ok((path.clone(), SkillInstall::Written))
        );
        assert_eq!(read(&path), SKILL_TEXT);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_shipped_skill_is_short_and_names_itself() {
        assert!(SKILL_TEXT.starts_with("---\nname: discourse-graph\ndescription: "));
        assert!(
            SKILL_TEXT.lines().count() < 80,
            "{}",
            SKILL_TEXT.lines().count()
        );
        for rule in [
            "kd types",
            "kd node",
            "kd relate",
            "relations.json",
            ".obsidian",
        ] {
            assert!(SKILL_TEXT.contains(rule), "{rule}");
        }
        assert!(!SKILL_TEXT.contains('\u{2014}'));
    }
}
