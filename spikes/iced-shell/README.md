# Krang Shell: a native spike on iced

A native version of the Krang Desktop shell, written in Rust on
[iced](https://github.com/iced-rs/iced) 0.14, to find out whether moving off
Tauri and React is worth it. It has the shell (tabs, tiling panes, session
restore, layout files) and four panes: terminal, chat, web and a Markdown
editor over a vault. It is a spike: macOS is the target, and the results are
in [RESULTS.md](RESULTS.md).

## Build and run on macOS

You need Rust 1.90 or later (`rustup default stable`).

```sh
cd spikes/iced-shell
cargo run --release
```

Open a layout file, as the current app does:

```sh
cargo run --release -- --layout ../../apps/desktop/examples/demo.toml
```

Build an app bundle, which the Dock and the app switcher need:

```sh
scripts/bundle-macos.sh
open "target/release/Krang Shell.app"
```

### Open a window without taking the keyboard

```sh
KRANG_QUIET=1 "target/release/Krang Shell.app/Contents/MacOS/krang-shell"
```

With `KRANG_QUIET=1` the app does not activate itself at launch, so the app
you are typing in keeps the keyboard; the window opens behind it. Click the
window to use it. This is a six-line patch to the vendored `iced_winit`, see
[vendor/README.md](vendor/README.md). `open -a` activates an app on its own,
so start the binary inside the bundle directly as above.

### Chat without an account

The chat pane runs the `claude` or `codex` command it finds on the PATH.
To try it without either, point it at the fake agent:

```sh
KRANG_CLAUDE_BIN=$PWD/scripts/fake-agent KRANG_CODEX_BIN=$PWD/scripts/fake-agent cargo run --release
```

The fake agent streams a Markdown reply with a tool call, cost and tokens. A
message containing `slow` streams for ten seconds (try Stop), `error` fails
with an error result, and `crash` exits with a message on standard error.

### Where things are kept

The workspace (tabs, panes, each pane's directory, note, URL and chat
transcript) is saved to `~/Library/Application Support/ie.cteic.krang-shell/
workspace.json` as it changes and when the window closes, and comes back at
the next start. `--fresh` starts empty. `KRANG_STATE_DIR` moves the file,
which the tests use. A window opened with `--layout` does not save, as in
the current app.

A new editor pane opens the folder in `KRANG_VAULT`, or else the folder the
app was started in.

## Shortcuts

Cmd is the Super key on Linux.

| Keys                     | Action                                         |
| ------------------------ | ---------------------------------------------- |
| Cmd+T                    | New tab                                        |
| Cmd+D, Cmd+Shift+D       | Split right, split down (a new terminal)       |
| Cmd+K or Cmd+Shift+P     | Command palette: add a pane of any kind        |
| Cmd+Shift+Enter          | Magnify the pane, or restore it                |
| Cmd+] and Cmd+[          | Next and previous pane                         |
| Cmd+Shift+] and Cmd+Shift+[ | Next and previous tab                       |
| Cmd+1 to Cmd+9           | Go to a tab                                    |
| Cmd+W, Cmd+Shift+W       | Close the pane, close the tab                  |
| Escape                   | Close the palette, switcher, find or completion |
| Shift+Enter in a terminal | A new line without sending, for agent prompts |
| Cmd+C, Cmd+V in a terminal | Copy the selection, paste                    |
| Cmd+O                    | Editor: open a note by name                    |
| Cmd+F, Cmd+Shift+F       | Editor: find in the note, search the vault     |
| Cmd+E                    | Editor: edit, split, preview                   |
| Cmd+Z, Cmd+Shift+Z       | Editor: undo, redo                             |
| Cmd+S                    | Editor: save now (it also saves on a pause)    |
| Cmd+Enter                | Editor: follow the wikilink at the cursor      |
| Cmd+L, Cmd+R             | Web: go to the address bar, reload             |

Drag a pane's title bar onto another pane to move it. Drag a divider to
resize. The same shortcuts work while a web page has the keyboard.

## Layout files

The same TOML the current app reads. One file is one tab.

```toml
title = "my project"

[[panes]]
id = "root"
split = "vertical"          # side by side; "horizontal" stacks
children = ["shell", "notes"]
sizes = [2, 1]              # optional relative sizes

[[panes]]
id = "shell"                # no type means a terminal
directory = "~/src/project"
is_focused = true
commands = ["git status -sb"]

[[panes]]
id = "notes"
type = "editor"
path = "~/src/project/README.md"
mode = "split"              # edit, split or preview
```

| Type       | Fields                                      | In this spike                       |
| ---------- | ------------------------------------------- | ----------------------------------- |
| `terminal` | `directory`, `commands`                     | as in the app                       |
| `editor`   | `path`, `mode`                              | the vault is the nearest folder above with `.obsidian`, or the note's folder |
| `web`      | `url` (URL, `localhost:3000` or a path)     | as in the app                       |
| `chat`     | `agent`, `directory`, `mode`                | as in the app                       |
| `files`    | `directory`                                 | opens the folder as a vault in an editor pane |
| `graph`    | `directory`                                 | the same; there is no graph pane    |

Every pane also takes `title` and `is_focused`.

## Checks and benchmarks

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
./bench.sh                  # Linux: prints the table in RESULTS.md
```

`KRANG_SELFTEST` runs a scripted scenario with no keyboard or person and
prints `name value` lines; `src/app/selftest.rs` lists them.
`scripts/make-test-vault.py <dir>` writes the 5,000-note test vault.

## Layout of the code

```text
src/term      terminal: pty session, event queue, snapshot, widget, key encoding
src/chat      agent stream adapters, transcript, process runner
src/vault     vault index, wikilinks, tags, frontmatter, search, fuzzy match
src/web       address handling, the localfile scheme, the web view host
src/shell     layout files and the saved workspace
src/app       the window, panes, palette, shortcuts and the self-test
vendor        iced_winit with the quiet-launch patch
```
