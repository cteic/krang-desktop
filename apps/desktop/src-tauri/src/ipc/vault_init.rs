//! Makes a new, small vault for a discourse graph: the settings file the
//! Discourse Graphs plugin for Obsidian reads, a note that says what the
//! vault is, and the skill that teaches an agent to fill it.
//!
//! The settings are written here, in the plugin's format, with ids made at
//! the moment of writing. They hold node types, relation types and allowed
//! relations, and nothing about an account.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::graph_write;
use crate::vault_guard;

const SETTINGS_PATH: &str = ".obsidian/plugins/discourse-graphs/data.json";
const NODES_FOLDER: &str = "Discourse Graph";
const START_NOTE: &str = "Start here.md";
const START_TEXT: &str = include_str!("../../../examples/demo-vault/Start here.md");
const EXAMPLE_NOTE: &str = "Lab notebook - starter trial.md";
const EXAMPLE_TEXT: &str =
    include_str!("../../../examples/demo-vault/Lab notebook - starter trial.md");
/// Files a file manager leaves behind. A directory holding only these
/// still counts as empty.
const IGNORED_FILES: [&str; 1] = [".DS_Store"];

/// The plugin makes an id from a prefix and 21 characters drawn from
/// these 64.
const ID_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const ID_LENGTH: usize = 21;
const RANDOM_SOURCE: &str = "/dev/urandom";

/// One node type: its name, its naming pattern, its colour and its tag.
const NODE_TYPES: [(&str, &str, &str, &str); 7] = [
    ("Question", "QUE - {content}", "#99890e", "que-candidate"),
    ("Claim", "CLM - {content}", "#7DA13E", "clm-candidate"),
    ("Evidence", "EVD - {content}", "#DB134A", "evd-candidate"),
    ("Hypothesis", "HYP - {content}", "#8E5BD9", "hyp-candidate"),
    ("Result", "RES - {content}", "#E07B1A", "res-candidate"),
    ("Experiment", "EXP - {content}", "#2A8FBD", "exp-candidate"),
    ("Source", "@{content}", "#9E9E9E", "src-candidate"),
];

/// One relation type: its label, the label read backwards, and its colour,
/// which is one of the plugin's colour names.
const RELATION_TYPES: [(&str, &str, &str); 6] = [
    ("supports", "is supported by", "green"),
    ("opposes", "is opposed by", "red"),
    ("informs", "is informed by", "grey"),
    ("addresses", "is addressed by", "blue"),
    ("produces", "is produced by", "orange"),
    ("motivates", "is motivated by", "violet"),
];

/// The relations the vault allows, each as source, relation, destination.
const ALLOWED: [(&str, &str, &str); 16] = [
    ("Evidence", "supports", "Claim"),
    ("Evidence", "opposes", "Claim"),
    ("Evidence", "supports", "Hypothesis"),
    ("Evidence", "opposes", "Hypothesis"),
    ("Result", "supports", "Claim"),
    ("Result", "opposes", "Claim"),
    ("Result", "supports", "Hypothesis"),
    ("Result", "opposes", "Hypothesis"),
    ("Claim", "addresses", "Question"),
    ("Claim", "informs", "Question"),
    ("Evidence", "informs", "Question"),
    ("Claim", "informs", "Claim"),
    ("Question", "motivates", "Hypothesis"),
    ("Hypothesis", "motivates", "Experiment"),
    ("Experiment", "produces", "Result"),
    ("Source", "produces", "Evidence"),
];

#[derive(Serialize)]
struct NodeTypeEntry {
    id: String,
    name: &'static str,
    format: &'static str,
    color: &'static str,
    tag: &'static str,
    created: u64,
    modified: u64,
}

#[derive(Serialize)]
struct RelationTypeEntry {
    id: String,
    label: &'static str,
    complement: &'static str,
    color: &'static str,
    created: u64,
    modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AllowedEntry {
    id: String,
    source_id: String,
    destination_id: String,
    relationship_type_id: String,
    created: u64,
    modified: u64,
}

/// The settings file. The fields and their order follow the plugin's own
/// defaults, less the ones that belong to an account or to syncing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    node_types: Vec<NodeTypeEntry>,
    relation_types: Vec<RelationTypeEntry>,
    discourse_relations: Vec<AllowedEntry>,
    show_ids_in_frontmatter: bool,
    nodes_folder_path: &'static str,
    canvas_folder_path: &'static str,
    canvas_attachments_folder_path: &'static str,
    node_tag_hotkey: &'static str,
    show_help_menu_status_bar_icon: bool,
    show_discourse_context_overlay: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|age| u64::try_from(age.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// A new id of the kind the plugin makes, such as `node_` and 21 random
/// characters.
fn new_id(prefix: &str, random: &mut dyn Read) -> Result<String, String> {
    let mut bytes = [0_u8; ID_LENGTH];
    random
        .read_exact(&mut bytes)
        .map_err(|error| format!("could not read {RANDOM_SOURCE} to make an id: {error}"))?;
    // 64 divides 256, so every character is equally likely.
    let tail: String = bytes
        .iter()
        .map(|byte| char::from(ID_ALPHABET[usize::from(byte % 64)]))
        .collect();
    Ok(format!("{prefix}_{tail}"))
}

fn id_named<'a>(ids: &'a [(&'static str, String)], name: &str) -> Result<&'a str, String> {
    ids.iter()
        .find(|(known, _)| *known == name)
        .map(|(_, id)| id.as_str())
        .ok_or_else(|| format!("the built-in settings name {name}, which is not defined"))
}

/// The text of a new vault's settings file, with fresh ids.
fn settings_text(now: u64, random: &mut dyn Read) -> Result<String, String> {
    let mut node_ids = Vec::new();
    let mut node_types = Vec::new();
    for (name, format, color, tag) in NODE_TYPES {
        let id = new_id("node", random)?;
        node_ids.push((name, id.clone()));
        node_types.push(NodeTypeEntry {
            id,
            name,
            format,
            color,
            tag,
            created: now,
            modified: now,
        });
    }
    let mut relation_ids = Vec::new();
    let mut relation_types = Vec::new();
    for (label, complement, color) in RELATION_TYPES {
        let id = new_id("relation", random)?;
        relation_ids.push((label, id.clone()));
        relation_types.push(RelationTypeEntry {
            id,
            label,
            complement,
            color,
            created: now,
            modified: now,
        });
    }
    let mut discourse_relations = Vec::new();
    for (source, relation, destination) in ALLOWED {
        discourse_relations.push(AllowedEntry {
            id: new_id("rel3", random)?,
            source_id: id_named(&node_ids, source)?.to_string(),
            destination_id: id_named(&node_ids, destination)?.to_string(),
            relationship_type_id: id_named(&relation_ids, relation)?.to_string(),
            created: now,
            modified: now,
        });
    }
    let settings = SettingsFile {
        node_types,
        relation_types,
        discourse_relations,
        show_ids_in_frontmatter: false,
        nodes_folder_path: NODES_FOLDER,
        canvas_folder_path: "",
        canvas_attachments_folder_path: "attachments",
        node_tag_hotkey: "\\",
        show_help_menu_status_bar_icon: false,
        show_discourse_context_overlay: true,
    };
    serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("could not build the settings: {error}"))
}

fn is_empty(dir: &Path) -> Result<bool, String> {
    let entries = fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", dir.display()))?;
        let name = entry.file_name();
        if !IGNORED_FILES.iter().any(|ignored| name == *ignored) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Writes a file that must not exist yet, at a path inside the vault at
/// `root`. `Ok(false)` means a file of that name was already there and was
/// left alone. Nothing is written through a link.
fn write_new(root: &Path, path: &Path, text: &str) -> Result<bool, String> {
    let failed = |error: io::Error| format!("could not write {}: {error}", path.display());
    let real = vault_guard::file_inside(root, path)?;
    if let Some(dir) = real.parent() {
        vault_guard::create_dir_inside(root, dir)?;
    }
    match vault_guard::create_new(&real) {
        Ok(mut file) => {
            file.write_all(text.as_bytes()).map_err(failed)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(failed(error)),
    }
}

fn report(written: bool, path: &Path) -> String {
    if written {
        format!("created {}", path.display())
    } else {
        format!("kept    {} (it was already there)", path.display())
    }
}

/// The directory as one word of a shell command.
fn shell_word(dir: &Path) -> String {
    let text = dir.display().to_string();
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c));
    if plain {
        text
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

fn settings_exist(settings: &Path) -> String {
    format!(
        "{} already exists, and this command never replaces a vault's settings. \
         Nothing was written.",
        settings.display()
    )
}

/// Makes the vault in `dir`, which is created when missing. A directory
/// that holds anything is refused unless `force` is set, and then every
/// file already in it is kept. Returns what to print.
pub fn init(dir: &Path, example: bool, force: bool) -> Result<String, String> {
    if dir.exists() {
        if !dir.is_dir() {
            return Err(format!("{} is not a directory", dir.display()));
        }
        if !force && !is_empty(dir)? {
            return Err(format!(
                "{} is not empty. Pass --force to add the vault's files beside what is there.",
                dir.display()
            ));
        }
    }
    let settings = dir.join(SETTINGS_PATH);
    if fs::symlink_metadata(&settings).is_ok() {
        return Err(settings_exist(&settings));
    }
    let mut notes = vec![(START_NOTE, START_TEXT)];
    if example {
        notes.push((EXAMPLE_NOTE, EXAMPLE_TEXT));
    }
    // The directory may hold links when `--force` adds to what is there.
    // Every file is checked before the first is written, so a refusal
    // leaves nothing behind but the directory.
    fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    let root = fs::canonicalize(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    vault_guard::file_inside(&root, &root.join(SETTINGS_PATH))?;
    for (name, _) in &notes {
        vault_guard::file_inside(&root, &root.join(name))?;
    }
    vault_guard::file_inside(&root, &graph_write::skill_destination(&root))?;

    let mut random =
        File::open(RANDOM_SOURCE).map_err(|error| format!("{RANDOM_SOURCE}: {error}"))?;
    let text = settings_text(now_ms(), &mut random)?;
    if !write_new(&root, &root.join(SETTINGS_PATH), &text)? {
        return Err(settings_exist(&settings));
    }

    let mut lines = vec![report(true, &settings)];
    for (name, text) in notes {
        let written = write_new(&root, &root.join(name), text)?;
        lines.push(report(written, &dir.join(name)));
    }
    let skill = graph_write::skill_destination(dir);
    if skill.exists() {
        lines.push(report(false, &skill));
    } else {
        graph_write::install_skill(dir, false)?;
        lines.push(report(true, &skill));
    }

    lines.push(String::new());
    lines.push(format!("Next: cd {} && kd types", shell_word(dir)));
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::socket::test_support::temp_dir;
    use serde_json::{json, Value};
    use std::collections::HashSet;

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn strings<'a>(entries: &'a Value, key: &str) -> Vec<&'a str> {
        entries
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry[key].as_str().unwrap())
            .collect()
    }

    fn is_plugin_id(id: &str, prefix: &str) -> bool {
        id.strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('_'))
            .is_some_and(|tail| {
                tail.len() == ID_LENGTH && tail.bytes().all(|byte| ID_ALPHABET.contains(&byte))
            })
    }

    #[test]
    fn an_id_has_the_plugins_shape() {
        let mut zeros: &[u8] = &[0; ID_LENGTH];
        assert_eq!(
            new_id("node", &mut zeros).unwrap(),
            "node_AAAAAAAAAAAAAAAAAAAAA"
        );
        let mut all: &[u8] = &[
            0, 25, 26, 51, 52, 61, 62, 63, 64, 255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
        ];
        assert_eq!(
            new_id("rel3", &mut all).unwrap(),
            "rel3_AZaz09_-A-BCDEFGHIJKL"
        );
        let mut short: &[u8] = &[1, 2, 3];
        assert!(new_id("node", &mut short)
            .unwrap_err()
            .starts_with("could not read /dev/urandom"));
    }

    #[test]
    fn the_settings_hold_the_types_in_the_plugins_format_and_no_account() {
        let dir = temp_dir("init-settings").join("vault");
        init(&dir, false, false).unwrap();
        let settings = read_json(&dir.join(SETTINGS_PATH));

        let top: Vec<&str> = settings
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut sorted = top.clone();
        sorted.sort_unstable();
        assert_eq!(
            sorted,
            [
                "canvasAttachmentsFolderPath",
                "canvasFolderPath",
                "discourseRelations",
                "nodeTagHotkey",
                "nodeTypes",
                "nodesFolderPath",
                "relationTypes",
                "showDiscourseContextOverlay",
                "showHelpMenuStatusBarIcon",
                "showIdsInFrontmatter",
            ]
        );
        assert_eq!(settings["nodesFolderPath"], json!("Discourse Graph"));

        let nodes = &settings["nodeTypes"];
        assert_eq!(
            strings(nodes, "name"),
            [
                "Question",
                "Claim",
                "Evidence",
                "Hypothesis",
                "Result",
                "Experiment",
                "Source"
            ]
        );
        assert_eq!(nodes[1]["format"], json!("CLM - {content}"));
        assert_eq!(nodes[1]["tag"], json!("clm-candidate"));
        assert_eq!(nodes[6]["format"], json!("@{content}"));
        for node in nodes.as_array().unwrap() {
            assert!(is_plugin_id(node["id"].as_str().unwrap(), "node"), "{node}");
            let color = node["color"].as_str().unwrap();
            assert!(
                color.len() == 7
                    && color.starts_with('#')
                    && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()),
                "{color}"
            );
            assert!(node["created"].as_u64().unwrap() > 1_700_000_000_000);
            assert_eq!(node["created"], node["modified"]);
        }

        let relations = &settings["relationTypes"];
        assert_eq!(
            strings(relations, "label"),
            [
                "supports",
                "opposes",
                "informs",
                "addresses",
                "produces",
                "motivates"
            ]
        );
        assert_eq!(relations[3]["complement"], json!("is addressed by"));
        // The plugin names a relation's colour, from this list.
        let names = [
            "black",
            "grey",
            "light-violet",
            "violet",
            "blue",
            "light-blue",
            "yellow",
            "orange",
            "green",
            "light-green",
            "light-red",
            "red",
            "white",
        ];
        for relation in relations.as_array().unwrap() {
            assert!(is_plugin_id(relation["id"].as_str().unwrap(), "relation"));
            assert!(names.contains(&relation["color"].as_str().unwrap()));
        }

        let node_ids: HashSet<&str> = strings(nodes, "id").into_iter().collect();
        let relation_ids: HashSet<&str> = strings(relations, "id").into_iter().collect();
        let allowed = settings["discourseRelations"].as_array().unwrap();
        assert_eq!(allowed.len(), ALLOWED.len());
        let mut every_id: HashSet<&str> = node_ids.union(&relation_ids).copied().collect();
        for triple in allowed {
            let id = triple["id"].as_str().unwrap();
            assert!(is_plugin_id(id, "rel3"), "{id}");
            assert!(every_id.insert(id), "{id} is used twice");
            assert!(node_ids.contains(triple["sourceId"].as_str().unwrap()));
            assert!(node_ids.contains(triple["destinationId"].as_str().unwrap()));
            assert!(relation_ids.contains(triple["relationshipTypeId"].as_str().unwrap()));
        }
        assert_eq!(every_id.len(), 7 + 6 + 16);

        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn two_vaults_get_different_ids() {
        let base = temp_dir("init-ids");
        init(&base.join("a"), false, false).unwrap();
        init(&base.join("b"), false, false).unwrap();
        let ids = |name: &str| {
            let settings = read_json(&base.join(name).join(SETTINGS_PATH));
            strings(&settings["nodeTypes"], "id").join(",")
        };
        assert_ne!(ids("a"), ids("b"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_allowed_relations_read_as_sentences() {
        let dir = temp_dir("init-allowed").join("vault");
        init(&dir, false, false).unwrap();
        let types = graph_write::vault_types(&dir).unwrap();
        let sentences: Vec<&str> = types
            .allowed
            .iter()
            .map(|triple| triple.sentence.as_str())
            .collect();
        assert_eq!(
            sentences,
            [
                "Evidence supports Claim",
                "Evidence opposes Claim",
                "Evidence supports Hypothesis",
                "Evidence opposes Hypothesis",
                "Result supports Claim",
                "Result opposes Claim",
                "Result supports Hypothesis",
                "Result opposes Hypothesis",
                "Claim addresses Question",
                "Claim informs Question",
                "Evidence informs Question",
                "Claim informs Claim",
                "Question motivates Hypothesis",
                "Hypothesis motivates Experiment",
                "Experiment produces Result",
                "Source produces Evidence",
            ]
        );
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_plain_vault_gets_three_files_and_no_relations_file() {
        let base = temp_dir("init-plain");
        let dir = base.join("new/vault");
        let printed = init(&dir, false, false).unwrap();
        let skill = dir.join(".claude/skills/discourse-graph/SKILL.md");
        assert_eq!(
            printed,
            format!(
                "created {}\ncreated {}\ncreated {}\n\nNext: cd {} && kd types",
                dir.join(SETTINGS_PATH).display(),
                dir.join(START_NOTE).display(),
                skill.display(),
                dir.display()
            )
        );
        assert_eq!(fs::read_to_string(skill).unwrap(), graph_write::SKILL_TEXT);
        let start = fs::read_to_string(dir.join(START_NOTE)).unwrap();
        assert_eq!(start.lines().filter(|line| !line.is_empty()).count(), 6);
        for way in ["From a terminal", "With an agent", "From the editor"] {
            assert!(start.contains(way), "{way}");
        }
        assert!(!dir.join("relations.json").exists());
        assert!(!dir.join(EXAMPLE_NOTE).exists());
        assert_eq!(graph_write::vault_root(&dir), Some(dir.clone()));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_example_note_is_added_on_request() {
        let dir = temp_dir("init-example");
        // A file manager's own file does not make a directory count as used.
        fs::write(dir.join(".DS_Store"), "x").unwrap();
        let printed = init(&dir, true, false).unwrap();
        assert!(printed.contains(&format!("created {}", dir.join(EXAMPLE_NOTE).display())));
        let note = fs::read_to_string(dir.join(EXAMPLE_NOTE)).unwrap();
        assert!(note.starts_with("# Lab notebook: starter trial (example data)"));
        assert!(note.contains("invented example"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_directory_in_use_is_refused_unless_forced_and_its_files_are_kept() {
        let dir = temp_dir("init-used");
        fs::write(dir.join(START_NOTE), "mine").unwrap();
        fs::write(dir.join("notes.md"), "also mine").unwrap();

        let refused = init(&dir, true, false).unwrap_err();
        assert!(refused.ends_with(
            "is not empty. Pass --force to add the vault's files beside what is there."
        ));
        assert!(!dir.join(".obsidian").exists());

        let printed = init(&dir, true, true).unwrap();
        assert!(printed.contains(&format!(
            "kept    {} (it was already there)",
            dir.join(START_NOTE).display()
        )));
        assert_eq!(fs::read_to_string(dir.join(START_NOTE)).unwrap(), "mine");
        assert_eq!(
            fs::read_to_string(dir.join("notes.md")).unwrap(),
            "also mine"
        );
        assert!(dir.join(SETTINGS_PATH).is_file());
        assert!(dir.join(EXAMPLE_NOTE).is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn existing_settings_are_never_replaced_even_when_forced() {
        let dir = temp_dir("init-settings-kept");
        let settings = dir.join(SETTINGS_PATH);
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{\"mine\":true}").unwrap();

        for force in [false, true] {
            let error = init(&dir, true, force).unwrap_err();
            if force {
                assert_eq!(error, settings_exist(&settings));
                assert!(error.contains("never replaces"), "{error}");
            }
            assert_eq!(fs::read_to_string(&settings).unwrap(), "{\"mine\":true}");
            assert!(!dir.join(START_NOTE).exists());
            assert!(!dir.join(".claude").exists());
        }

        let file = temp_dir("init-file").join("plain.txt");
        fs::write(&file, "x").unwrap();
        assert!(init(&file, false, true)
            .unwrap_err()
            .ends_with("is not a directory"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_forced_init_writes_nothing_through_a_link() {
        let base = fs::canonicalize(temp_dir("init-link")).unwrap();
        let (dir, far) = (base.join("vault"), base.join("far"));
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&far).unwrap();
        let names = |dir: &Path| {
            let mut names: Vec<String> = fs::read_dir(dir)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };

        // A linked settings folder or skill folder that leaves the vault.
        for name in [".obsidian", ".claude"] {
            std::os::unix::fs::symlink(&far, dir.join(name)).unwrap();
            let error = init(&dir, true, true).unwrap_err();
            assert!(error.contains("outside the vault"), "{name}: {error}");
            assert_eq!(names(&far), Vec::<String>::new(), "{name}");
            assert_eq!(names(&dir), [name], "{name}");
            fs::remove_file(dir.join(name)).unwrap();
        }

        // A note that is a link is refused before anything is written.
        fs::write(far.join("theirs.md"), "theirs").unwrap();
        std::os::unix::fs::symlink(far.join("theirs.md"), dir.join(START_NOTE)).unwrap();
        let error = init(&dir, true, true).unwrap_err();
        assert!(error.contains("symbolic link"), "{error}");
        assert_eq!(fs::read_to_string(far.join("theirs.md")).unwrap(), "theirs");
        assert_eq!(names(&dir), [START_NOTE]);

        // The vault's own directory may be reached through a link.
        fs::remove_file(dir.join(START_NOTE)).unwrap();
        std::os::unix::fs::symlink(&dir, base.join("alias")).unwrap();
        let printed = init(&base.join("alias"), false, true).unwrap();
        assert!(
            printed.starts_with(&format!(
                "created {}",
                base.join("alias").join(SETTINGS_PATH).display()
            )),
            "{printed}"
        );
        assert!(dir.join(SETTINGS_PATH).is_file());
        assert!(dir.join(START_NOTE).is_file());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_directory_with_a_space_is_quoted_in_the_next_command() {
        assert_eq!(shell_word(Path::new("/a/b-c_d.e")), "/a/b-c_d.e");
        assert_eq!(shell_word(Path::new("/a/my vault")), "'/a/my vault'");
        assert_eq!(shell_word(Path::new("/a/it's")), "'/a/it'\\''s'");
    }

    #[test]
    fn the_reader_sees_an_empty_graph_with_its_types_and_no_complaint() {
        let dir = temp_dir("init-read");
        init(&dir, true, false).unwrap();
        let graph = crate::graph::read_graph(&dir.display().to_string()).unwrap();
        let graph = serde_json::to_value(graph).unwrap();
        assert_eq!(graph["message"], Value::Null);
        assert_eq!(graph["warnings"], json!([]));
        assert_eq!(graph["incomplete"], json!(false));
        assert_eq!(graph["nodes"], json!([]));
        assert_eq!(graph["relations"], json!([]));
        assert_eq!(graph["canvases"], json!([]));
        assert_eq!(graph["nodeTypes"].as_array().unwrap().len(), 7);
        assert_eq!(graph["nodeTypes"][0]["name"], json!("Question"));
        assert_eq!(graph["nodeTypes"][0]["color"], json!("#99890e"));
        assert_eq!(graph["relationTypes"].as_array().unwrap().len(), 6);
        assert_eq!(graph["relationTypes"][5]["label"], json!("motivates"));
        fs::remove_dir_all(dir).unwrap();
    }
}
