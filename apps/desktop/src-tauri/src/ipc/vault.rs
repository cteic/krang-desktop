//! The tool's commands that work on a vault's files. They run in the tool
//! itself and never talk to the app, so they work in any terminal.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use super::args::{Body, VaultAction, VaultCommand};
use crate::graph_write::{self, NodeEntry, SkillInstall, VaultTypes};

const NOTE_SUFFIX: &str = ".md";

fn absolute(cwd: &Path, path: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in cwd.join(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The vault a command works on: the one named, or the nearest directory
/// at or above the current one that holds `.obsidian`.
fn vault_for(named: Option<&str>, cwd: &Path) -> Result<PathBuf, String> {
    match named {
        Some(dir) => {
            let path = absolute(cwd, dir);
            if path.is_dir() {
                Ok(path)
            } else {
                Err(format!("{} is not a directory", path.display()))
            }
        }
        None => graph_write::vault_root(cwd).ok_or_else(|| {
            format!(
                "no vault found: no directory at or above {} holds .obsidian. \
                 Run this inside a vault, or pass --vault <dir>.",
                cwd.display()
            )
        }),
    }
}

/// A note named by a path from the current directory becomes its full
/// path. Anything else is passed on, to be read as a path from the vault
/// root or as a note's name.
fn note_argument(cwd: &Path, word: &str) -> String {
    let path = absolute(cwd, word);
    let with_suffix = PathBuf::from(format!("{}{NOTE_SUFFIX}", path.display()));
    [path, with_suffix]
        .iter()
        .find(|path| path.is_file())
        .map_or_else(|| word.to_string(), |path| path.display().to_string())
}

fn body_text(body: &Body, cwd: &Path, stdin: &mut dyn Read) -> Result<String, String> {
    match body {
        Body::Text(text) => Ok(text.clone()),
        Body::File(path) if path == "-" => {
            let mut text = String::new();
            stdin
                .read_to_string(&mut text)
                .map_err(|error| format!("could not read the body from stdin: {error}"))?;
            Ok(text)
        }
        Body::File(path) => {
            let path = absolute(cwd, path);
            fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))
        }
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| format!("could not print JSON: {error}"))
}

fn column(rows: &[String]) -> usize {
    rows.iter()
        .map(|row| row.chars().count())
        .max()
        .unwrap_or(0)
}

fn types_text(types: &VaultTypes) -> String {
    let names: Vec<String> = types.node_types.iter().map(|k| k.name.clone()).collect();
    let prefixes: Vec<String> = types.node_types.iter().map(|k| k.prefix.clone()).collect();
    let (name_width, prefix_width) = (column(&names), column(&prefixes));
    let mut lines = vec![String::from("Node types (name, prefix, tag):")];
    for kind in &types.node_types {
        let tag = kind
            .tag
            .as_deref()
            .map(|tag| format!("#{}", tag.trim_start_matches('#')))
            .unwrap_or_default();
        let line = format!(
            "  {:name_width$}  {:prefix_width$}  {tag}",
            kind.name, kind.prefix
        );
        lines.push(line.trim_end().to_string());
    }
    lines.push(String::new());
    lines.push(String::from(
        "Relation types (label, and the label read backwards):",
    ));
    for kind in &types.relation_types {
        lines.push(format!("  {} ({})", kind.label, kind.complement));
    }
    lines.push(String::new());
    lines.push(String::from(
        "Allowed relations (kd relate <source> <relation> <destination>):",
    ));
    for triple in &types.allowed {
        lines.push(format!("  {}", triple.sentence));
    }
    if types.allowed.is_empty() {
        lines.push(String::from("  none"));
    }
    lines.join("\n")
}

fn nodes_text(nodes: &[NodeEntry]) -> String {
    nodes
        .iter()
        .map(|node| node.title.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Runs one vault command. Returns what to print.
pub fn run(
    command: &VaultCommand,
    cwd: Option<&Path>,
    stdin: &mut dyn Read,
) -> Result<String, String> {
    let cwd = cwd.ok_or_else(|| String::from("could not read the current directory"))?;
    let vault = vault_for(command.vault.as_deref(), cwd)?;
    match &command.action {
        VaultAction::Node {
            type_name,
            text,
            body,
        } => {
            let body = body
                .as_ref()
                .map(|body| body_text(body, cwd, stdin))
                .transpose()?;
            graph_write::create_node(&vault, type_name, text, body.as_deref()).map(|node| node.path)
        }
        VaultAction::Relate {
            source,
            relation,
            destination,
            force,
        } => graph_write::add_relation(
            &vault,
            &note_argument(cwd, source),
            relation,
            &note_argument(cwd, destination),
            *force,
        )
        .map(|added| format!("{}\nrelation {}", added.sentence, added.id)),
        VaultAction::Types { json } => {
            let types = graph_write::vault_types(&vault)?;
            if *json {
                to_json(&types)
            } else {
                Ok(types_text(&types))
            }
        }
        VaultAction::Nodes { type_name, json } => {
            let nodes = graph_write::list_nodes(&vault, type_name.as_deref())?;
            if *json {
                to_json(&nodes)
            } else {
                Ok(nodes_text(&nodes))
            }
        }
        VaultAction::SkillInstall { force } => {
            let (path, outcome) = graph_write::install_skill(&vault, *force)?;
            Ok(match outcome {
                SkillInstall::Written => format!("installed {}", path.display()),
                SkillInstall::Unchanged => format!("already up to date: {}", path.display()),
            })
        }
        VaultAction::SkillPath => Ok(graph_write::skill_destination(&vault).display().to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::args::{parse_args, Command};
    use crate::ipc::socket::test_support::temp_dir;
    use serde_json::{json, Value};

    const SETTINGS: &str = ".obsidian/plugins/discourse-graphs/data.json";

    fn fixture(tag: &str) -> PathBuf {
        let root = fs::canonicalize(temp_dir(tag)).unwrap();
        let settings = json!({
            "nodeTypes": [
                {"id": "node_c", "name": "Claim", "format": "CLM - {content}", "tag": "clm-candidate"},
                {"id": "node_e", "name": "Evidence", "format": "EVD - {content}"}
            ],
            "relationTypes": [
                {"id": "rel_s", "label": "supports", "complement": "is supported by"}
            ],
            "discourseRelations": [
                {"sourceId": "node_e", "destinationId": "node_c", "relationshipTypeId": "rel_s"}
            ],
            "nodesFolderPath": "Graph",
            "spacePassword": "hunter2-do-not-print"
        });
        fs::create_dir_all(root.join(".obsidian/plugins/discourse-graphs")).unwrap();
        fs::write(root.join(SETTINGS), settings.to_string()).unwrap();
        fs::create_dir_all(root.join("Daily")).unwrap();
        root
    }

    fn kd(cwd: &Path, line: &[&str], stdin: &str) -> Result<String, String> {
        let words: Vec<String> = line.iter().map(|word| (*word).to_string()).collect();
        let Ok(Command::Vault(command)) = parse_args(&words) else {
            panic!("{line:?} is not a vault command");
        };
        run(&command, Some(cwd), &mut stdin.as_bytes())
    }

    #[test]
    fn nodes_and_a_relation_are_made_from_inside_the_vault() {
        let root = fixture("vault-cli");
        let daily = root.join("Daily");

        let claim = kd(&daily, &["node", "claim", "Birds", "have", "wings"], "").unwrap();
        assert_eq!(
            claim,
            root.join("Graph/CLM - Birds have wings.md")
                .display()
                .to_string()
        );
        let evidence = kd(
            &daily,
            &["node", "evidence", "A wing was seen", "--body-file", "-"],
            "From stdin.\n",
        )
        .unwrap();
        assert!(fs::read_to_string(&evidence)
            .unwrap()
            .ends_with("---\nFrom stdin.\n"));
        fs::write(daily.join("body.txt"), "From a file.").unwrap();
        let other = kd(
            &daily,
            &["node", "EVD", "Feathers", "--body-file", "body.txt"],
            "",
        )
        .unwrap();
        assert!(fs::read_to_string(other)
            .unwrap()
            .ends_with("---\nFrom a file.\n"));

        // A note is named by title, or by a path from the current directory.
        let related = kd(
            &daily,
            &[
                "relate",
                "../Graph/EVD - A wing was seen",
                "supports",
                "CLM - Birds have wings",
            ],
            "",
        )
        .unwrap();
        let (sentence, id) = related.split_once("\nrelation ").unwrap();
        assert_eq!(
            sentence,
            "EVD - A wing was seen supports CLM - Birds have wings"
        );
        let relations: Value =
            serde_json::from_str(&fs::read_to_string(root.join("relations.json")).unwrap())
                .unwrap();
        assert_eq!(relations["relations"][id]["type"], json!("rel_s"));

        assert_eq!(
            kd(&daily, &["nodes"], "").unwrap(),
            "CLM - Birds have wings\nEVD - A wing was seen\nEVD - Feathers"
        );
        assert_eq!(
            kd(&daily, &["nodes", "--type", "claim"], "").unwrap(),
            "CLM - Birds have wings"
        );
        let listed: Value =
            serde_json::from_str(&kd(&daily, &["nodes", "--json"], "").unwrap()).unwrap();
        assert_eq!(listed[0]["typeName"], json!("Claim"));
        assert_eq!(listed[0]["path"], json!(claim));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn types_are_printed_in_words_or_as_json() {
        let root = fixture("vault-types");
        let text = kd(&root, &["types"], "").unwrap();
        assert_eq!(
            text,
            "Node types (name, prefix, tag):\n  Claim     CLM  #clm-candidate\n  Evidence  EVD\n\n\
             Relation types (label, and the label read backwards):\n  supports (is supported by)\n\n\
             Allowed relations (kd relate <source> <relation> <destination>):\n  Evidence supports Claim"
        );
        let json_text = kd(&root, &["types", "--json"], "").unwrap();
        let value: Value = serde_json::from_str(&json_text).unwrap();
        assert_eq!(
            value["allowed"][0]["sentence"],
            json!("Evidence supports Claim")
        );
        assert!(!format!("{text}{json_text}").contains("hunter2"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_vault_is_named_or_found_above_the_current_directory() {
        let root = fixture("vault-find");
        let outside = fs::canonicalize(temp_dir("vault-outside")).unwrap();

        let error = kd(&outside, &["types"], "").unwrap_err();
        assert!(error.starts_with("no vault found"), "{error}");
        assert!(error.contains("--vault <dir>"), "{error}");
        let vault = root.display().to_string();
        assert!(kd(&outside, &["types", "--vault", &vault], "").is_ok());
        let missing = kd(&outside, &["types", "--vault", "nope"], "").unwrap_err();
        assert!(missing.ends_with("is not a directory"), "{missing}");

        let refused = kd(&root, &["node", "theorem", "x"], "").unwrap_err();
        assert!(refused.contains("no node type called theorem"), "{refused}");
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn the_skill_is_installed_into_the_vault() {
        let root = fixture("vault-skill");
        let path = root.join(".claude/skills/discourse-graph/SKILL.md");
        assert_eq!(
            kd(&root, &["skill", "path"], "").unwrap(),
            path.display().to_string()
        );
        assert!(!path.exists());
        assert_eq!(
            kd(&root.join("Daily"), &["skill", "install"], "").unwrap(),
            format!("installed {}", path.display())
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), graph_write::SKILL_TEXT);
        assert!(kd(&root, &["skill", "install"], "")
            .unwrap()
            .starts_with("already up to date"));
        fs::write(&path, "edited").unwrap();
        assert!(kd(&root, &["skill", "install"], "")
            .unwrap_err()
            .contains("--force"));
        assert!(kd(&root, &["skill", "install", "--force"], "").is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
