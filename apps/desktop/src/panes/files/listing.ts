import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

const entrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
  size: z.number().nonnegative(),
  modifiedMs: z.number().nonnegative(),
});

const listingSchema = z.object({
  path: z.string().min(1),
  parent: z.string().nullable(),
  entries: z.array(entrySchema),
});

const homeSchema = z.string().min(1);

export type FileEntry = z.infer<typeof entrySchema>;

export type Listing = z.infer<typeof listingSchema>;

/** Checks an `fs_list` reply. Throws when the shape is not the one expected. */
export function parseListing(reply: unknown): Listing {
  const result = listingSchema.safeParse(reply);
  if (!result.success) {
    throw new Error('The directory listing came back in a shape this pane does not understand.');
  }
  return result.data;
}

/** Checks an `fs_home` reply. Throws when it is not a path. */
export function parseHome(reply: unknown): string {
  const result = homeSchema.safeParse(reply);
  if (!result.success) {
    throw new Error('The home directory came back in a shape this pane does not understand.');
  }
  return result.data;
}

/** Lists a directory. Null means the home directory. */
export async function fetchListing(directory: string | null): Promise<Listing> {
  const path = directory ?? parseHome(await invoke('fs_home'));
  return parseListing(await invoke('fs_list', { path }));
}

/** The text to show for a failed command. The Rust side rejects with a string. */
export function errorText(reason: unknown): string {
  if (typeof reason === 'string') {
    return reason;
  }
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}
