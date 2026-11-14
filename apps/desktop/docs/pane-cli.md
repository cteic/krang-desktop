# kd: drive the app from inside a pane

`kd` is a command-line tool for programs that run in a terminal pane. A shell
script, or a coding agent, uses it to open a file beside itself, open a web
page, or set its own pane's title and badge.

`kd` is the app binary under another name, so it always matches the app's
version. It sends one request to the running app over a Unix socket and exits.
The vault commands further down are the exception: they work on files and
send nothing to the app.

## Commands

| Command                               | What it does                                        | Example                                   |
| ------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `kd view <path> [--down]`             | Opens a file in an editor, or a directory in files  | `kd view src/main.rs`                     |
| `kd web <url-or-path> [--down]`       | Opens a web pane                                    | `kd web http://localhost:3000`            |
| `kd term [dir] [-- command...]`       | Opens a terminal, and types a first command into it | `kd term api -- pnpm dev`                 |
| `kd chat [--agent claude\|codex] [dir]` | Opens a chat pane                                   | `kd chat --agent codex`                   |
| `kd graph [dir]`                      | Opens a graph of a Discourse Graphs vault           | `kd graph ~/notes/lab`                    |
| `kd title <text>`, `kd title --clear` | Sets or clears this pane's title                    | `kd title "api tests"`                    |
| `kd badge <text> [--color <#rrggbb>]` | Sets this pane's badge                              | `kd badge "needs you" --color "#ff8800"`  |
| `kd badge --clear`                    | Clears this pane's badge                            | `kd badge --clear`                        |
| `kd layout <name-or-path>`            | Opens a layout file as a new tab                    | `kd layout review`                        |
| `kd panes`                            | Prints this window's tabs and panes as JSON         | `kd panes`                                |

`kd --help` lists the commands. `kd <command> --help` explains one.

Details that matter:

- New panes open beside the calling pane. `--down` opens them below it.
- Relative paths are taken from the directory `kd` runs in.
- `kd web` treats an argument containing `://` as a URL. Anything else must be
  a file on disk, such as `dist/index.html`. Write `http://localhost:3000`,
  not `localhost:3000`.
- `kd term -- 'pnpm test && pnpm build'` types the one argument as written, so
  it can hold shell syntax. With several arguments, `kd` quotes each one.
- `kd layout review` looks for `review.toml` in the app's layout directories.
  An argument containing `/` or ending in `.toml` is a path.
- `kd graph` opens the vault in the given directory, or in the directory `kd`
  runs in. The vault is an Obsidian vault that uses the Discourse Graphs
  plugin.
- Put `--` before text that starts with a dash: `kd title -- --draft`.

Exit codes: `0` done, `1` failed (the reason is on stderr), `2` the command
line was wrong.

`kd panes` prints:

```json
{
  "tabs": [
    {
      "id": "t2",
      "title": "shell",
      "active": true,
      "panes": [{ "id": "p1", "title": "terminal", "type": "terminal", "focused": true }]
    }
  ]
}
```

`focused` is true for the one pane that holds the keyboard in the window.

## Vault commands: nodes and relations

These commands create files in an Obsidian vault that uses the Discourse
Graphs plugin. They are plain file operations. They work in any terminal,
with or without the app running, and they need none of the environment
variables below.

| Command                                             | What it does                                                 |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `kd types [--json]`                                 | Lists node types, relation types and the allowed relations   |
| `kd nodes [--type <type>] [--json]`                 | Lists the titles of the nodes that exist                     |
| `kd node <type> <text...> [--body <text>]`          | Creates a node note and prints its path                      |
| `kd node <type> <text...> --body-file <path>`       | The same, with the note's text read from a file, or `-` for stdin |
| `kd relate <source> <relation> <destination>`       | Adds a relation between two nodes                            |
| `kd skill install [--force]`, `kd skill path`       | Copies the discourse-graph skill into the vault, or prints where it goes |

Every command takes `--vault <dir>`. Without it, the vault is the nearest
directory at or above the current one that holds `.obsidian`.

```sh
$ kd node claim "Sleep loss reduces working memory"
/notes/lab/DiscourseGraph/CLM - Sleep loss reduces working memory.md
$ kd relate "EVD - Reaction times rose 12 percent" supports "CLM - Sleep loss reduces working memory"
EVD - Reaction times rose 12 percent supports CLM - Sleep loss reduces working memory
relation 019a8f3e-7c1a-7d52-9b0e-3f6a1c2d4e5f
```

Details that matter:

- The app reads and writes vault files in the plugin's format. The plugin
  itself is not modified, and nothing inside `.obsidian` is written.
- `<type>` is a node type's name, its prefix, its tag or its id: `claim`,
  `CLM` or `clm-candidate`. Case does not matter.
- The text becomes the note's title in the type's naming pattern, so
  `kd node claim "Birds fly"` makes `CLM - Birds fly.md`. The characters
  `# ^ [ ] |` are dropped because they break links. Each `/`, `\` and `:`
  becomes a dash. A long title is cut at 200 bytes.
- A new note goes in the node type's folder, or else the vault's nodes
  folder, or else the vault root. If the node type has a template and the
  vault's Templates feature is on, the note gets the template's frontmatter
  and body. `--body` replaces the template's body.
- `kd node` never replaces a note. If any note in the vault has the title, it
  fails and names that note.
- `<source>` and `<destination>` each name a note: a path, or the note's
  title with or without `.md`. A title that several notes share is an error
  that lists their paths.
- `<relation>` is a relation type's label or id, such as `supports`. The
  direction matters: `kd types` prints each allowed relation as a sentence,
  such as `Evidence supports Claim`.
- `kd relate` refuses a relation the vault's settings do not allow, and says
  what is allowed between the two node types. `--force` adds it anyway.
- `kd relate` refuses a relation that already exists between the two notes
  with the same type, in either direction, as the plugin does.
- A node note with no `nodeInstanceId` gets one added to its frontmatter the
  first time it is related. No other byte of the note changes.
- `relations.json` is read again just before it is written, and replaced in
  one step. Entries and fields the tool does not know are kept.

### The discourse-graph skill

`apps/desktop/skills/discourse-graph/SKILL.md` teaches Claude Code to build a
graph with these commands: read the source, propose questions, claims and
evidence with the sentences they come from, create and link them, and link
each new node from its source note. `kd skill install` copies it to
`<vault>/.claude/skills/discourse-graph/SKILL.md`, where Claude Code finds it
when it runs in the vault. It keeps a copy you have edited unless you pass
`--force`.

## Environment variables

The app sets these in every pane's shell.

| Variable          | Value                                         |
| ----------------- | --------------------------------------------- |
| `DESKTOP_SOCKET`  | Path of the socket the app listens on         |
| `DESKTOP_CLI`     | Full path of the `kd` tool                    |
| `DESKTOP_WINDOW`  | Label of the pane's window, such as `window-1` |
| `DESKTOP_PANE_ID` | Id of the pane, such as `p3`                  |

`kd` reads the socket, window and pane variables to know where to send a
request and which pane is calling. Outside the app, a command that drives a
pane exits 1 with
`kd only works inside a pane of the app (DESKTOP_SOCKET is not set)`.

## If `kd` is not found: use `DESKTOP_CLI`

The app puts the tool's directory first on the pane's `PATH`. A shell profile
can undo that. A `.zshrc` that assigns `PATH` from scratch drops the directory,
and then the shell answers `command not found: kd`.

`DESKTOP_CLI` always holds the full path. Use it in scripts and hooks:

```sh
"$DESKTOP_CLI" badge "done"
```

To get the short name back in an interactive shell, add this to `.zshrc`:

```sh
[ -n "$DESKTOP_CLI" ] && alias kd="$DESKTOP_CLI"
```

## Example: a badge when Claude Code needs you

Claude Code runs hooks, which are shell commands, at set points in a session.
This snippet sets a badge on the pane when the agent asks for attention, and
clears it when you send the next prompt. Put it in `~/.claude/settings.json`,
or in a project's `.claude/settings.json`.

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -z \"$DESKTOP_CLI\" ] || \"$DESKTOP_CLI\" badge \"needs you\" --color \"#ff8800\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -z \"$DESKTOP_CLI\" ] || \"$DESKTOP_CLI\" badge --clear"
          }
        ]
      }
    ]
  }
}
```

The `[ -z "$DESKTOP_CLI" ] ||` guard makes the hook do nothing when Claude
Code runs outside the app.

This snippet is untested: nobody has run it inside the app yet. The event names
`Notification` and `UserPromptSubmit` are present in the installed Claude Code
binary. Check the hook format against the Claude Code hooks documentation
before relying on it.
