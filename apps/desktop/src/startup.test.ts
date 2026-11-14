import { describe, expect, it } from 'vitest';

import { leavesOf } from './workspace/model';
import { toSession } from './startup';
import { serializeWorkspace } from './workspace/persist';
import { createWorkspace, createWorkspaceWithTabs, defaultDraft } from './workspace/reducer';

const TWO_PANES =
  'name = "two"\n[[panes]]\nid = "root"\nsplit = "vertical"\nchildren = ["a", "b"]\n[[panes]]\nid = "a"\n[[panes]]\nid = "b"\n';

describe('toSession', () => {
  it('uses the layout file when it parses', () => {
    const session = toSession({
      layout: { path: '/tmp/two.toml', text: TWO_PANES },
      layoutError: null,
      debug: false,
    });
    expect(session.problem).toBeNull();
    expect(leavesOf(session.layout.root).map((pane) => pane.id)).toEqual(['a', 'b']);
  });

  it('opens the default layout when no file was given', () => {
    const session = toSession({ layout: null, layoutError: null, debug: true });
    expect(session.problem).toBeNull();
    expect(session.debug).toBe(true);
    expect(session.layout.title).toBe('shell');
  });

  it('opens the default layout and names the file when the layout is invalid', () => {
    const session = toSession({
      layout: { path: '/tmp/bad.toml', text: 'name = "x"\npanes = []\n' },
      layoutError: null,
      debug: false,
    });
    expect(session.layout.title).toBe('shell');
    expect(session.problem).toContain('/tmp/bad.toml');
  });

  it('passes on a read error from the shell', () => {
    const session = toSession({
      layout: null,
      layoutError: 'could not read /nope.toml: No such file or directory',
      debug: false,
    });
    expect(session.layout.title).toBe('shell');
    expect(session.problem).toContain('/nope.toml');
  });

  it('survives a reply of the wrong shape', () => {
    const session = toSession({ nonsense: true });
    expect(session.layout.title).toBe('shell');
    expect(session.problem).not.toBeNull();
  });

  it('restores a saved workspace and says whether to keep saving', () => {
    const saved = serializeWorkspace(createWorkspace(defaultDraft()));
    const session = toSession({
      layout: null,
      layoutError: null,
      saved,
      persist: true,
      debug: false,
    });
    expect(session.persist).toBe(true);
    expect(session.saved?.tabs).toHaveLength(1);
  });

  it('ignores saved state that does not parse', () => {
    const session = toSession({
      layout: null,
      layoutError: null,
      saved: '{"version":99}',
      persist: true,
      debug: false,
    });
    expect(session.saved).toBeNull();
    expect(session.persist).toBe(true);
    expect(session.problem).toBeNull();
  });

  it('treats a reply without the save fields as not saving', () => {
    const session = toSession({ layout: null, layoutError: null, debug: false });
    expect(session.saved).toBeNull();
    expect(session.persist).toBe(false);
  });

  const ONE_PANE = 'name = "one"\ntitle = "One"\n[[panes]]\nid = "only"\n';

  it('makes a tab of each layout when several were asked for', () => {
    const session = toSession({
      layout: { path: '/tmp/two.toml', text: TWO_PANES },
      layoutError: null,
      layouts: [
        { layout: { path: '/tmp/two.toml', text: TWO_PANES }, layoutError: null },
        { layout: { path: '/tmp/one.toml', text: ONE_PANE }, layoutError: null },
      ],
      debug: false,
    });
    expect(session.problem).toBeNull();
    expect(session.layout.title).toBe('two');
    expect(session.extraTabs.map((tab) => tab.title)).toEqual(['One']);

    const workspace = createWorkspaceWithTabs([session.layout, ...session.extraTabs]);
    expect(workspace.tabs.map((tab) => tab.title)).toEqual(['two', 'One']);
    expect(workspace.activeTabId).toBe(workspace.tabs[0]?.id);
  });

  it('opens the layouts that load and names each one that does not', () => {
    const session = toSession({
      layout: null,
      layoutError: 'no layout named "gone" in /layouts',
      layouts: [
        { layout: null, layoutError: 'no layout named "gone" in /layouts' },
        { layout: { path: '/tmp/bad.toml', text: 'name = "x"\npanes = []\n' }, layoutError: null },
        { layout: { path: '/tmp/one.toml', text: ONE_PANE }, layoutError: null },
        { layout: { path: '/tmp/two.toml', text: TWO_PANES }, layoutError: null },
      ],
      debug: false,
    });
    expect(session.layout.title).toBe('One');
    expect(session.extraTabs.map((tab) => tab.title)).toEqual(['two']);
    expect(session.problem).toContain('no layout named "gone"');
    expect(session.problem).toContain('/tmp/bad.toml');
  });

  it('opens the default layout when none of several loads', () => {
    const session = toSession({
      layout: null,
      layoutError: 'first is missing',
      layouts: [
        { layout: null, layoutError: 'first is missing' },
        { layout: null, layoutError: 'second is missing' },
      ],
      debug: false,
    });
    expect(session.layout.title).toBe('shell');
    expect(session.extraTabs).toEqual([]);
    expect(session.problem).toBe('first is missing; second is missing');
  });

  it('still reads the single layout when the list is left out or empty', () => {
    const session = toSession({
      layout: { path: '/tmp/one.toml', text: ONE_PANE },
      layoutError: null,
      layouts: [],
      debug: false,
    });
    expect(session.layout.title).toBe('One');
    expect(session.extraTabs).toEqual([]);
  });
});
