import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef } from 'react';

const SNAPSHOT_MS = 1000;

/**
 * While debug snapshots are on, writes this pane's text to the debug
 * directory once a second, as `<name>.txt`. It lets a test run read back
 * what a pane shows without anyone looking at the screen. Off by default.
 */
export function useDebugSnapshot(name: string, enabled: boolean, getText: () => string) {
  const getTextRef = useRef(getText);
  getTextRef.current = getText;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setInterval(() => {
      invoke('debug_snapshot', { id: name, text: getTextRef.current() }).catch((error: unknown) => {
        console.error('[debug-snapshot]', error);
      });
    }, SNAPSHOT_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [name, enabled]);
}
