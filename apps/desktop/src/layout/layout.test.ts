import { describe, expect, it } from 'vitest';

import { defaultLayout, focusedPaneId, LayoutError, parseLayout, terminalsOf } from './layout';

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

    expect(layout.name).toBe('krang');
    expect(layout.title).toBe('personal · krang');
    expect(layout.color).toBe('blue');
    expect(layout.root).toEqual({
      kind: 'split',
      id: 'root',
      direction: 'row',
      children: [
        {
          kind: 'split',
          id: 'left',
          direction: 'column',
          children: [
            {
              kind: 'terminal',
              id: 'shell',
              directory: '/tmp/project',
              focused: true,
              commands: ['banner shell'],
            },
            {
              kind: 'terminal',
              id: 'state',
              directory: '/tmp/project',
              focused: false,
              commands: ['banner state', 'git status -sb'],
            },
          ],
        },
        {
          kind: 'terminal',
          id: 'agent',
          directory: '/tmp/project',
          focused: false,
          commands: ['agent exec'],
        },
      ],
    });
  });

  it('accepts a single terminal with no splits', () => {
    const layout = parseLayout('name = "one"\n[[panes]]\nid = "only"\n');
    expect(layout.title).toBe('one');
    expect(layout.root).toEqual({
      kind: 'terminal',
      id: 'only',
      directory: null,
      focused: false,
      commands: [],
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
    expectLayoutError(text, 'cannot also be a terminal');
  });

  it('rejects children without a split direction', () => {
    expectLayoutError(
      'name = "x"\n[[panes]]\nid = "root"\nchildren = ["a"]\n[[panes]]\nid = "a"\n',
      'needs both "split" and "children"',
    );
  });
});

describe('focusedPaneId', () => {
  it('picks the pane marked focused', () => {
    expect(focusedPaneId(parseLayout(PROJECT_COCKPIT).root)).toBe('shell');
  });

  it('falls back to the first terminal', () => {
    const layout = parseLayout(
      'name = "x"\n[[panes]]\nid = "root"\nsplit = "vertical"\nchildren = ["a", "b"]\n[[panes]]\nid = "a"\n[[panes]]\nid = "b"\n',
    );
    expect(focusedPaneId(layout.root)).toBe('a');
  });
});

describe('terminalsOf', () => {
  it('lists leaves in reading order', () => {
    const ids = terminalsOf(parseLayout(PROJECT_COCKPIT).root).map((terminal) => terminal.id);
    expect(ids).toEqual(['shell', 'state', 'agent']);
  });
});

describe('defaultLayout', () => {
  it('is one focused shell', () => {
    const layout = defaultLayout();
    expect(terminalsOf(layout.root)).toHaveLength(1);
    expect(focusedPaneId(layout.root)).toBe('shell');
  });
});
