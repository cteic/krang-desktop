import { describe, expect, it } from 'vitest';

import { terminalsOf } from './layout/layout';
import { toSession } from './startup';

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
    expect(terminalsOf(session.layout.root).map((pane) => pane.id)).toEqual(['a', 'b']);
  });

  it('opens the default layout when no file was given', () => {
    const session = toSession({ layout: null, layoutError: null, debug: true });
    expect(session.problem).toBeNull();
    expect(session.debug).toBe(true);
    expect(session.layout.name).toBe('default');
  });

  it('opens the default layout and names the file when the layout is invalid', () => {
    const session = toSession({
      layout: { path: '/tmp/bad.toml', text: 'name = "x"\npanes = []\n' },
      layoutError: null,
      debug: false,
    });
    expect(session.layout.name).toBe('default');
    expect(session.problem).toContain('/tmp/bad.toml');
  });

  it('passes on a read error from the shell', () => {
    const session = toSession({
      layout: null,
      layoutError: 'could not read /nope.toml: No such file or directory',
      debug: false,
    });
    expect(session.layout.name).toBe('default');
    expect(session.problem).toContain('/nope.toml');
  });

  it('survives a reply of the wrong shape', () => {
    const session = toSession({ nonsense: true });
    expect(session.layout.name).toBe('default');
    expect(session.problem).not.toBeNull();
  });
});
