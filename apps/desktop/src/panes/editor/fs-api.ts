import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

import { expandHome, isHomePath } from './paths';

const textFileSchema = z.object({ path: z.string(), text: z.string() });

export type TextFile = z.infer<typeof textFileSchema>;

export async function readTextFile(path: string): Promise<TextFile> {
  const reply: unknown = await invoke('fs_read_text', { path });
  return textFileSchema.parse(reply);
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await invoke('fs_write_text', { path, text });
}

export async function homeDirectory(): Promise<string> {
  const reply: unknown = await invoke('fs_home');
  return z.string().parse(reply);
}

/** Makes a `~` path absolute. Any other path comes back unchanged. */
export async function resolvePath(path: string): Promise<string> {
  if (!isHomePath(path)) {
    return path;
  }
  return expandHome(path, await homeDirectory());
}

/** The core rejects with a plain string. Anything else is shown as best it can be. */
export function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * True when a read failed because nothing is at the path. The core reports
 * the system's own message, so this matches its wording and error number.
 */
export function isMissingFileError(message: string): boolean {
  return /No such file or directory|\(os error 2\)/.test(message);
}

export interface LoadedFile {
  kind: 'loaded';
  resolvedPath: string;
  text: string;
}

export interface MissingFile {
  kind: 'missing';
  resolvedPath: string;
}

export interface FailedLoad {
  kind: 'failed';
  message: string;
}

export type LoadResult = LoadedFile | MissingFile | FailedLoad;

/** Reads a file for the editor. A file that does not exist yet is not an error. */
export async function loadFile(path: string): Promise<LoadResult> {
  let resolvedPath = path;
  try {
    resolvedPath = await resolvePath(path);
    const file = await readTextFile(resolvedPath);
    return { kind: 'loaded', resolvedPath: file.path, text: file.text };
  } catch (error) {
    const message = errorText(error);
    if (isMissingFileError(message)) {
      return { kind: 'missing', resolvedPath };
    }
    return { kind: 'failed', message };
  }
}
