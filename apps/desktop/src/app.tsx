import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';

import { accentFor } from './accent';
import { focusedPaneId } from './layout/layout';
import { PaneView } from './pane-view';
import { toSession } from './startup';
import type { Session } from './startup';

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('startup')
      .then((reply) => {
        if (cancelled) {
          return;
        }
        const next = toSession(reply);
        setSession(next);
        getCurrentWindow()
          .setTitle(next.layout.title)
          .catch((error: unknown) => {
            console.error('[app] set title', error);
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSession(toSession({ layout: null, layoutError: String(error), debug: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (session === null) {
    return null;
  }

  return (
    <div className="window">
      {session.problem === null ? null : (
        <div className="problem" role="alert">
          Layout not loaded. {session.problem}
        </div>
      )}
      <div className="window-body">
        <PaneView
          node={session.layout.root}
          layoutTitle={session.layout.title}
          accent={accentFor(session.layout.color)}
          focusedId={focusedPaneId(session.layout.root)}
          debug={session.debug}
        />
      </div>
    </div>
  );
}
