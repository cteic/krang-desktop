import { describe, expect, it } from 'vitest';

import { leavesOf } from './workspace/model';
import { toSession } from './startup';
import { serializeWorkspace } from './workspace/persist';
import { createWorkspace, defaultDraft } from './workspace/reducer';

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
});
