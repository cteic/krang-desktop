# kd: drive the app from inside a pane

`kd` is a command-line tool for programs that run in a terminal pane. A shell
script, or a coding agent, uses it to open a file beside itself, open a web
page, or set its own pane's title and badge.

`kd` is the app binary under another name, so it always matches the app's
version. It sends one request to the running app over a Unix socket and exits.

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

## Environment variables

The app sets these in every pane's shell.

| Variable          | Value                                         |
| ----------------- | --------------------------------------------- |
| `DESKTOP_SOCKET`  | Path of the socket the app listens on         |
| `DESKTOP_CLI`     | Full path of the `kd` tool                    |
| `DESKTOP_WINDOW`  | Label of the pane's window, such as `window-1` |
| `DESKTOP_PANE_ID` | Id of the pane, such as `p3`                  |

`kd` reads the socket, window and pane variables to know where to send a
request and which pane is calling. Outside the app it exits 1 with
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
