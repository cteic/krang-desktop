import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { leavesOf } from '../workspace/model';

import { LayoutError, parseLayout } from './layout';

const PROJECT_COCKPIT = `
name = "krang"
title = "personal · krang"
color = "blue"

[[panes]]
id = "root"
split = "vertical"
children = ["left", "agent"]

[[panes]]
id = "left"
split = "horizontal"
children = ["shell", "state"]

[[panes]]
id = "shell"
type = "terminal"
directory = "/tmp/project"
is_focused = true
commands = ["banner shell"]

[[panes]]
id = "state"
type = "terminal"
directory = "/tmp/project"
commands = ["banner state", "git status -sb"]

[[panes]]
id = "agent"
type = "terminal"
directory = "/tmp/project"
commands = ["agent exec"]
`;

function expectLayoutError(text: string, fragment: string) {
  expect(() => parseLayout(text)).toThrow(LayoutError);
  expect(() => parseLayout(text)).toThrow(fragment);
}

describe('parseLayout', () => {
  it('builds the tree of an existing cockpit tab config', () => {
    const layout = parseLayout(PROJECT_COCKPIT);

    expect(layout.title).toBe('personal · krang');
    expect(layout.color).toBe('blue');
    expect(layout.focusedId).toBe('shell');
    expect(layout.root).toEqual({
      kind: 'split',
      id: 'root',
      direction: 'row',
      shares: [0.5, 0.5],
      children: [
        {
          kind: 'split',
          id: 'left',
          direction: 'column',
          shares: [0.5, 0.5],
          children: [
            {
              kind: 'leaf',
              id: 'shell',
              title: 'shell',
              badge: null,
              content: { type: 'terminal', directory: '/tmp/project', commands: ['banner shell'] },
            },
            {
              kind: 'leaf',
              id: 'state',
              title: 'state',
              badge: null,
              content: {
                type: 'terminal',
                directory: '/tmp/project',
                commands: ['banner state', 'git status -sb'],
              },
            },
          ],
        },
        {
          kind: 'leaf',
          id: 'agent',
          title: 'agent',
          badge: null,
          content: { type: 'terminal', directory: '/tmp/project', commands: ['agent exec'] },
        },
      ],
    });
  });

  it('reads the other pane types', () => {
    const layout = parseLayout(`
name = "mixed"
[[panes]]
id = "root"
split = "vertical"
children = ["files", "notes", "board", "ask"]
[[panes]]
id = "files"
type = "files"
directory = "~/krang"
[[panes]]
id = "notes"
type = "editor"
path = "~/krang/README.md"
title = "readme"
[[panes]]
id = "board"
type = "web"
url = "http://127.0.0.1:4747"
[[panes]]
id = "ask"
type = "chat"
agent = "claude"
`);
    const leaves = leavesOf(layout.root);

    expect(leaves.map((leaf) => leaf.content)).toEqual([
      { type: 'files', directory: '~/krang' },
      { type: 'editor', path: '~/krang/README.md' },
      { type: 'web', url: 'http://127.0.0.1:4747' },
      { type: 'chat', agent: 'claude', directory: null },
    ]);
    expect(leaves.map((leaf) => leaf.title)).toEqual(['files', 'readme', 'board', 'ask']);
    expect(layout.root.kind === 'split' ? layout.root.shares : []).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
  });

  it('reads a graph pane and the view it opens on', () => {
    const layout = parseLayout(`
name = "lab"
[[panes]]
id = "root"
split = "vertical"
children = ["everything", "named", "canvas", "bare"]
[[panes]]
id = "everything"
type = "graph"
directory = "~/vault"
[[panes]]
id = "named"
type = "graph"
directory = "~/vault"
view = "all"
[[panes]]
id = "canvas"
type = "graph"
directory = "~/vault"
view = "Overview.md"
[[panes]]
id = "bare"
type = "graph"
`);

    expect(leavesOf(layout.root).map((leaf) => leaf.content)).toEqual([
      { type: 'graph', directory: '~/vault', view: null },
      { type: 'graph', directory: '~/vault', view: null },
      { type: 'graph', directory: '~/vault', view: 'Overview.md' },
      { type: 'graph', directory: null, view: null },
    ]);
  });

  it('reads the example tour of the graph pane', () => {
    const text = readFileSync(new URL('../../examples/lab.toml', import.meta.url), 'utf8');
    const layout = parseLayout(text);
    const leaves = leavesOf(layout.root);

    expect(leaves.map((leaf) => leaf.content.type)).toEqual([
      'files',
      'terminal',
      'editor',
      'graph',
      'chat',
    ]);
    // Every pane has a title a person wrote, not its id.
    expect(leaves.every((leaf) => leaf.title !== null && leaf.title !== leaf.id)).toBe(true);
    expect(layout.focusedId).toBe('graph');
    const graph = leaves.find((leaf) => leaf.content.type === 'graph');
    expect(graph?.content).toMatchObject({ type: 'graph', view: null });
    // The graph's column is as wide as the other two together.
    expect(layout.root.kind === 'split' ? layout.root.shares : []).toEqual([0.2, 0.3, 0.5]);
  });

  it('rejects a split that also names a graph view', () => {
    expectLayoutError(
      'name = "x"\n[[panes]]\nid = "r"\nsplit = "vertical"\nchildren = ["a"]\nview = "all"\n[[panes]]\nid = "a"\n',
      'cannot also hold content',
    );
  });

  it('rejects a web pane with no url', () => {
    expectLayoutError('name = "x"\n[[panes]]\nid = "w"\ntype = "web"\n', 'needs a "url"');
  });

  it('rejects an unknown pane type', () => {
    expectLayoutError('name = "x"\n[[panes]]\nid = "w"\ntype = "hologram"\n', 'expected shape');
  });

  it('accepts a single terminal with no splits', () => {
    const layout = parseLayout('name = "one"\n[[panes]]\nid = "only"\n');
    expect(layout.title).toBe('one');
    expect(layout.focusedId).toBeNull();
    expect(layout.root).toEqual({
      kind: 'leaf',
      id: 'only',
      title: 'only',
      badge: null,
      content: { type: 'terminal', directory: null, commands: [] },
    });
  });

  it('rejects text that is not TOML', () => {
    expectLayoutError('name = ', 'not valid TOML');
  });

  it('rejects a file with no panes', () => {
    expectLayoutError('name = "empty"\npanes = []\n', 'expected shape');
  });

  it('rejects a child that is not defined', () => {
    expectLayoutError(
      'name = "x"\n[[panes]]\nid = "root"\nsplit = "vertical"\nchildren = ["ghost"]\n',
      'child "ghost", which is not defined',
    );
  });

  it('rejects two panes with one id', () => {
    expectLayoutError('name = "x"\n[[panes]]\nid = "a"\n[[panes]]\nid = "a"\n', 'used twice');
  });

  it('rejects two roots', () => {
    expectLayoutError(
      'name = "x"\n[[panes]]\nid = "a"\n[[panes]]\nid = "b"\n',
      'more than one root',
    );
  });

  it('rejects a pane with two parents', () => {
    const text = `
name = "x"
[[panes]]
id = "root"
split = "vertical"
children = ["a", "b"]
[[panes]]
id = "a"
split = "horizontal"
children = ["leaf"]
[[panes]]
id = "b"
split = "horizontal"
children = ["leaf"]
[[panes]]
id = "leaf"
`;
    expectLayoutError(text, 'child of more than one split');
  });

  it('rejects a cycle, which leaves no root', () => {
    const text = `
name = "x"
[[panes]]
id = "a"
split = "vertical"
children = ["b"]
[[panes]]
id = "b"
split = "vertical"
children = ["a"]
`;
    expectLayoutError(text, 'no root pane');
  });

  it('rejects a split that also sets terminal fields', () => {
    const text =
      'name = "x"\n[[panes]]\nid = "root"\nsplit = "vertical"\nchildren = ["a"]\ncommands = ["ls"]\n[[panes]]\nid = "a"\n';
    expectLayoutError(text, 'cannot also hold content');
  });

  it('rejects children without a split direction', () => {
    expectLayoutError(
      'name = "x"\n[[panes]]\nid = "root"\nchildren = ["a"]\n[[panes]]\nid = "a"\n',
      'needs both "split" and "children"',
    );
  });

  const COLUMNS = `
name = "cols"
[[panes]]
id = "root"
split = "vertical"
children = ["a", "b", "c"]
SIZES
[[panes]]
id = "a"
[[panes]]
id = "b"
type = "editor"
path = "/tmp/a.md"
MODE
[[panes]]
id = "c"
`;

  function columns(sizes: string, mode = ''): string {
    return COLUMNS.replace('SIZES', sizes).replace('MODE', mode);
  }

  it('gives the children of a split the relative sizes it lists', () => {
    const root = parseLayout(columns('sizes = [2, 3, 5]')).root;
    expect(root.kind === 'split' ? root.shares : null).toEqual([0.2, 0.3, 0.5]);
  });

  it('accepts sizes that are not whole numbers', () => {
    const root = parseLayout(columns('sizes = [0.5, 0.5, 1.0]')).root;
    expect(root.kind === 'split' ? root.shares : null).toEqual([0.25, 0.25, 0.5]);
  });

  it('refuses sizes that do not match the children or are not positive', () => {
    expectLayoutError(columns('sizes = [1, 2]'), '2 sizes for 3 children');
    expectLayoutError(columns('sizes = [1, 0, 2]'), 'not a positive number');
    expectLayoutError(columns('sizes = [1, -1, 2]'), 'not a positive number');
    expectLayoutError(columns('sizes = [1, "2", 3]'), 'expected shape');
    expectLayoutError(columns('', 'sizes = [1]'), 'only a split takes');
  });

  it('reads the mode an editor pane opens in', () => {
    const leaves = leavesOf(parseLayout(columns('', 'mode = "preview"')).root);
    expect(leaves[1]?.content).toEqual({ type: 'editor', path: '/tmp/a.md', mode: 'preview' });
    expect(leavesOf(parseLayout(columns('')).root)[1]?.content).toEqual({
      type: 'editor',
      path: '/tmp/a.md',
    });
  });

  it('refuses a mode that is not edit, split or preview, and a mode on a split', () => {
    expectLayoutError(
      columns('', 'mode = "reading"'),
      'pane "b" has mode "reading", and an editor pane takes one of "edit", "split", "preview"',
    );
    expectLayoutError(columns('', 'mode = "read-only"'), 'an editor pane takes one of');
    expectLayoutError(columns('', 'mode = 3'), 'expected shape');
    expectLayoutError(columns('mode = "edit"'), 'cannot also hold content');
  });

  function chat(mode: string): string {
    return `name = "x"\n[[panes]]\nid = "c"\ntype = "chat"\nagent = "claude"\ndirectory = "~/v"\n${mode}\n`;
  }

  it('reads the mode a chat pane starts in, and leaves it out when not given', () => {
    const base = { type: 'chat', agent: 'claude', directory: '~/v' };
    expect(leavesOf(parseLayout(chat('mode = "edit"')).root)[0]?.content).toEqual({
      ...base,
      mode: 'edit',
    });
    expect(leavesOf(parseLayout(chat('mode = "read-only"')).root)[0]?.content).toEqual({
      ...base,
      mode: 'read-only',
    });
    expect(leavesOf(parseLayout(chat('')).root)[0]?.content).toEqual(base);
  });

  it('refuses a chat mode that is not read-only or edit', () => {
    expectLayoutError(
      chat('mode = "preview"'),
      'pane "c" has mode "preview", and a chat pane takes one of "read-only", "edit"',
    );
    expectLayoutError(chat('mode = "bypassPermissions"'), 'a chat pane takes one of');
    expectLayoutError(chat('mode = ""'), 'expected shape');
  });

  it('parses the example layouts', () => {
    for (const name of ['lab', 'board', 'demo']) {
      const text = readFileSync(new URL(`../../examples/${name}.toml`, import.meta.url), 'utf8');
      expect(() => parseLayout(text)).not.toThrow();
    }
  });

  it('lays out the research example as a narrow column, a note and a wide column', () => {
    const text = readFileSync(new URL('../../examples/lab.toml', import.meta.url), 'utf8');
    const layout = parseLayout(text);
    expect(layout.title).toBe('Research');
    expect(layout.root.kind === 'split' ? layout.root.shares : null).toEqual([0.2, 0.3, 0.5]);
    expect(leavesOf(layout.root).map((leaf) => leaf.content.type)).toEqual([
      'files',
      'terminal',
      'editor',
      'graph',
      'chat',
    ]);
  });

  it('points the research example at the demo vault, with a chat that can edit it', () => {
    const text = readFileSync(new URL('../../examples/lab.toml', import.meta.url), 'utf8');
    const [files, shell, note, graph, chat] = leavesOf(parseLayout(text).root);
    expect(files?.content).toEqual({ type: 'files', directory: '~/discourse-demo' });
    expect(shell?.title).toBe('Shell');
    expect(shell?.content).toEqual({
      type: 'terminal',
      directory: '~/discourse-demo',
      commands: [],
    });
    expect(note?.content).toEqual({
      type: 'editor',
      path: '~/discourse-demo/Lab notebook - starter trial.md',
      mode: 'preview',
    });
    expect(graph?.content).toEqual({ type: 'graph', directory: '~/discourse-demo', view: null });
    expect(chat?.content).toEqual({
      type: 'chat',
      agent: 'claude',
      directory: '~/discourse-demo',
      mode: 'edit',
    });
    const column = parseLayout(text).root;
    const right = column.kind === 'split' ? column.children[2] : undefined;
    expect(right?.kind === 'split' ? right.shares : null).toEqual([2 / 3, 1 / 3]);
  });

  it('lays out the board example around a saved canvas', () => {
    const text = readFileSync(new URL('../../examples/board.toml', import.meta.url), 'utf8');
    const layout = parseLayout(text);
    expect(layout.title).toBe('Lab board');
    const leaves = leavesOf(layout.root);
    expect(leaves[0]?.content).toMatchObject({
      type: 'graph',
      view: 'Canvas - QUE - Matthew Effect',
    });
    expect(leaves[1]?.content).toMatchObject({ type: 'editor', mode: 'preview' });
    expect(leaves[2]?.content.type).toBe('files');
  });
});
