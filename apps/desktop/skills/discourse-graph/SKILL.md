---
name: discourse-graph
description: Turn notes or source material in an Obsidian vault into a discourse graph of questions, claims and evidence, using the kd command-line tool. Use when asked to extract claims, map an argument, build or extend a discourse graph, or link evidence to claims in a vault that uses the Discourse Graphs plugin.
---

# Discourse graph

## What a discourse graph is

1. A discourse graph breaks writing into small notes called nodes.
2. Each node holds one idea and has a type, such as question, claim or evidence.
3. A question asks what is unknown. A claim answers it. Evidence is an observation from a source.
4. Typed relations join nodes: evidence supports or opposes a claim, a claim addresses a question.
5. A reader can then follow any claim back to the observations and sources under it.

## Tools

`kd` creates the files in the format the Discourse Graphs plugin uses. It works
in any terminal, with or without the app running.

| Command                                       | What it does                                                        |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `kd types`                                    | Lists this vault's node types, relation types and allowed relations |
| `kd nodes [--type <type>]`                    | Lists the titles of the nodes that exist                            |
| `kd node <type> <text...> [--body <text>]`    | Creates a node and prints its path                                  |
| `kd relate <source> <relation> <destination>` | Links two nodes                                                     |

Run them from inside the vault, or add `--vault <dir>`. Run `kd types` first,
every time. Vaults differ, so never assume a type or a relation exists.

## Procedure

1. Run `kd types` and `kd nodes`. Note the type names and the "Allowed
   relations" list. Only those sentences can be linked.
2. Read the source material in full. Note the path of each source note.
3. Propose a short list, at most ten items, before you create anything. For
   each item give its type, its title, and the exact sentence it comes from,
   quoted word for word, with the source note's name. Wait for approval if a
   person is present. In a chat pane, end your turn after the list with the
   question "Create these?" so the person can answer.
4. Check `kd nodes` for a node that already says the same thing. Reuse it
   instead of creating a second one.
5. Create each new node. Quote the text so the shell keeps it whole:
   `kd node claim "Sleep loss reduces working memory" --body "Source: [[Lab meeting 3 March]]"`
   Pass the text without the type prefix. `kd` adds it and prints the path.
6. Link the nodes. Name each node by its full title or its path:
   `kd relate "EVD - Reaction times rose 12 percent after one night awake" supports "CLM - Sleep loss reduces working memory"`
   The direction matters. Read the line aloud as a sentence and check it
   against the allowed relations.
7. In each source note, add a `[[wikilink]]` to every new node, next to the
   sentence the node came from. The link text is the node's title, which is
   its file name without `.md`. Change nothing else in the source note.
8. Print a summary table with one row per node: type, title, source note,
   and its relations. List anything you skipped and say why.

## Rules

- One idea per node. Split a sentence that makes two claims into two nodes.
- A title is a full sentence that a reader understands alone. Write "Sleep
  loss reduces working memory", not "Memory effects".
- Evidence must cite its source. Put a `[[wikilink]]` to the source note in
  the body of every evidence node.
- Never invent evidence. If the source does not state it, do not create it.
- Never edit `relations.json` by hand. Use `kd relate`.
- Never touch anything inside `.obsidian`.
- If `kd` refuses a relation, read its message. It lists what is allowed
  between those two types. Do not reach for `--force` to get past it.
- If `kd` says a title is ambiguous, pass the note's path instead.
