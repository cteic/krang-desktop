import { invoke } from '@tauri-apps/api/core';

let cached: Promise<string> | null = null;

async function fetchHome(): Promise<string> {
  const home: unknown = await invoke('fs_home');
  if (typeof home !== 'string' || !home.startsWith('/')) {
    throw new Error('fs_home did not return an absolute path');
  }
  return home;
}

/**
 * The home folder, for expanding `~` paths. Asked for once and shared by
 * every web pane. A failure is not kept, so the next call asks again.
 */
export function loadHome(): Promise<string> {
  cached ??= fetchHome().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}
