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
});
