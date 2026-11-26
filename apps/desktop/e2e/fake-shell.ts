import type { Page } from '@playwright/test';

/**
 * Stands in for the Rust shell, so the real window code runs in a plain
 * browser. Tauri's JavaScript API talks to Rust through
 * `window.__TAURI_INTERNALS__`, and this fills that in before the page loads.
 *
 * Each command answers from `replies` by name. Every other command gets null
 * and is recorded, so a test can see what the window asked for.
 */
export interface FakeShell {
  /** Command name to reply. A string reply is sent as it is. */
  replies: Record<string, unknown>;
}

declare global {
  interface Window {
    __fakeCalls: { command: string; args: unknown }[];
  }
}

export async function installFakeShell(page: Page, shell: FakeShell): Promise<void> {
  await page.addInitScript((replies: Record<string, unknown>) => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    let nextId = 1;
    window.__fakeCalls = [];
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: 'window-1' },
          currentWebview: { windowLabel: 'window-1', label: 'window-1' },
        },
        transformCallback(callback: (payload: unknown) => void) {
          const id = nextId;
          nextId += 1;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        invoke(command: string, args: unknown) {
          window.__fakeCalls.push({ command, args });
          return Promise.resolve(command in replies ? replies[command] : null);
        },
        convertFileSrc(path: string) {
          return path;
        },
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener() {
          // Nothing listens for real, so there is nothing to remove.
        },
      },
    });
  }, shell.replies);
}

/** The commands the window has sent so far, in order. */
export async function fakeCalls(page: Page): Promise<{ command: string; args: unknown }[]> {
  return page.evaluate(() => window.__fakeCalls);
}
