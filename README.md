# Krang Desktop

One desktop app for a working day: terminals, a file browser, a Markdown
editor, web pages, a chat with command-line agents and a graph of a notes
vault, side by side in tiling panes.

Built with Tauri 2 (a Rust core) and React. macOS only for now.

## What it does

| Pane     | What you get                                                               |
| -------- | -------------------------------------------------------------------------- |
| Terminal | A real shell on a pseudo-terminal, drawn by xterm.js on the GPU            |
| Files    | A keyboard-first file list. Enter opens a file in an editor pane beside it |
| Editor   | CodeMirror, with a live Markdown preview, wikilinks and save               |
| Web      | A page from a URL, a dev server or an HTML file on disk                    |
| Chat     | A chat window over Claude Code or Codex, using the login each already has  |
| Graph    | The questions, claims and evidence of a Discourse Graphs vault, as a graph |

Panes live in tabs, tabs live in windows. Split, resize, magnify and close
panes while you work. A plain window reopens with the tabs and panes you left.

## Run it

You need Node 24, pnpm 11.5.2 and Rust 1.90 or later.

```sh
pnpm install
pnpm --filter @krang-desktop/desktop tauri dev
```

Build an app bundle:

```sh
pnpm --filter @krang-desktop/desktop tauri build --debug
open "apps/desktop/src-tauri/target/debug/bundle/macos/Krang Desktop.app"
```

## Layout files

A layout file describes one tab: a tree of splits whose leaves are panes.

```toml
name = "project"
title = "my project"
color = "blue"

[[panes]]
id = "root"
split = "vertical"          # side by side; "horizontal" stacks
children = ["shell", "notes"]

[[panes]]
id = "shell"                # no type means a terminal
directory = "~/src/project"
is_focused = true
commands = ["git status -sb"]

[[panes]]
id = "notes"
type = "editor"             # terminal, files, editor, web, chat or graph
path = "~/src/project/README.md"
```

| Pane type  | Fields                                                          |
| ---------- | --------------------------------------------------------------- |
| `terminal` | `directory`, `commands` (typed into the shell once it is ready) |
| `files`    | `directory`                                                     |
| `editor`   | `path`, `mode` (`edit`, `split` or `preview`, for Markdown)     |
| `web`      | `url` (a URL, `localhost:3000`, or a path to an HTML file)      |
| `chat`     | `agent` (`claude` or `codex`), `directory`                      |
| `graph`    | `directory` (the vault), `view` (`all` or a canvas file name)   |

Every pane also takes `title` and `is_focused`. A split takes `sizes`, one
relative size per child: `sizes = [1, 2]` gives the second child two thirds.

A full example is in `apps/desktop/examples/demo.toml`. A tour of the graph
pane is in `apps/desktop/examples/lab.toml` and `board.toml`.

### Opening a layout

| How         | Example                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| By link     | `open "krang-desktop://layout/demo"`                                      |
| By path     | `"Krang Desktop.app/Contents/MacOS/desktop" --layout ~/layouts/demo.toml` |
| From a pane | `kd layout demo`                                                          |

A link names a layout by its file name without `.toml`. The app looks in
`~/Library/Application Support/ie.cteic.krang-desktop/layouts/` first, then in
`~/.warp/tab_configs/`, whose files use the same format.

A link opens a new window. If the app is already running, it opens there.

A link can name up to six layouts joined by `+`, and each opens as a tab of one window.
The demo is `open "krang-desktop://layout/lab+board"`; on the command line, repeat `--layout`.

## The graph pane

The graph pane reads an Obsidian vault that uses the open-source Discourse
Graphs plugin. The pane itself never writes to the vault.

- **All nodes** shows every note that has a configured `nodeTypeId` in its
  frontmatter, joined by the relations in the vault's `relations.json`.
- Each canvas file is its own view, drawn with the positions saved in the
  canvas. A canvas with several pages gets a page list.
- Click a node to highlight what it relates to. Double-click it, or press
  Enter, to open its note in an editor pane beside the graph.
- Click a node type in the legend to hide or show it.
- Drag to pan, scroll or pinch to zoom, and press F to fit the graph again.
- The pane checks the vault every few seconds and redraws when a note or a
  relation changes on disk.

Notes in a `Templates` folder are left out. A dashed line is a relation the
vault marks as not tentative. A dotted line is a relation whose end names an
instance id that several notes share, so it may point at the wrong note.

## Writing to a vault

`kd` creates graph nodes and relations from any terminal, with or without the
app running. A coding agent can use it to turn notes into a graph, and an open
graph pane shows each new node within a few seconds.

```sh
kd types                                   # node types and allowed relations
kd node claim "Sleep loss reduces working memory"
kd node evidence "Reaction times rose 12 percent after one night awake"
kd relate "EVD - Reaction times rose 12 percent after one night awake" \
  supports "CLM - Sleep loss reduces working memory"
kd skill install                           # teach Claude Code the procedure
```

The app reads and writes vault files in the plugin's format: a node is a
Markdown note with `nodeTypeId` and `nodeInstanceId` in its frontmatter, and a
relation is an entry in the vault's `relations.json`. The plugin itself is not
modified, and nothing inside `.obsidian` is written. The commands are
described in `apps/desktop/docs/pane-cli.md`.

## Shortcuts

| Keys                        | Action                                        |
| --------------------------- | --------------------------------------------- |
| Cmd+N                       | New window                                    |
| Cmd+T                       | New tab                                       |
| Cmd+D                       | Split right                                   |
| Cmd+Shift+D                 | Split down                                    |
| Cmd+Shift+Enter             | Magnify the pane, or restore it               |
| Cmd+] and Cmd+[             | Next and previous pane                        |
| Cmd+Shift+] and Cmd+Shift+[ | Next and previous tab                         |
| Cmd+W                       | Close the pane                                |
| Cmd+Shift+W                 | Close the tab                                 |
| Cmd+Option+W                | Close the window                              |
| Shift+Enter in a terminal   | A new line without sending, for agent prompts |

## Driving the app from a pane

A shell inside a pane has a small tool, `kd`, on its path. It opens panes
beside the one it runs in and sets that pane's title or badge. See
`apps/desktop/docs/pane-cli.md`.

## Repository layout

```text
apps/desktop          the app: React UI in src, Rust core in src-tauri
apps/cli              a command-line tool, not built yet
packages/core         domain logic, not built yet
packages/db           storage, not built yet
packages/ui           shared components, not built yet
packages/*-config     shared TypeScript, ESLint and Prettier settings
```

## Checks

```sh
pnpm check                                  # format, lint, typecheck, tests
cd apps/desktop/src-tauri && cargo test     # Rust tests
cd apps/desktop/src-tauri && cargo clippy --all-targets -- -D warnings
```

## Licence

AGPL-3.0-only. See [LICENSE](LICENSE).
