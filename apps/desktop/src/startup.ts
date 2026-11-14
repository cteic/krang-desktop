import { z } from 'zod';

import { LayoutError, parseLayout } from './layout/layout';
import type { Workspace } from './workspace/model';
import { parseWorkspace } from './workspace/persist';
import { defaultDraft } from './workspace/reducer';
import type { TabDraft } from './workspace/reducer';

const startupSchema = z.object({
  layout: z.object({ path: z.string(), text: z.string() }).nullable(),
  layoutError: z.string().nullable(),
  saved: z.string().nullable().optional(),
  persist: z.boolean().optional(),
  debug: z.boolean(),
});

export interface Session {
  layout: TabDraft;
  /** Why the requested layout was not used. Null when all is well. */
  problem: string | null;
  /** The workspace this window had last time. Takes the place of `layout`. */
  saved: Workspace | null;
  /** Whether to save the workspace as it changes. */
  persist: boolean;
  debug: boolean;
}

/**
 * Turns the Rust `startup` reply into what the window shows. A layout that
 * cannot be read or parsed never leaves a blank window: the default layout
 * opens and the problem is shown above it.
 */
export function toSession(reply: unknown): Session {
  const parsed = startupSchema.safeParse(reply);
  if (!parsed.success) {
    return {
      layout: defaultDraft(),
      problem: 'The app shell sent a startup reply this window does not understand.',
      saved: null,
      persist: false,
      debug: false,
    };
  }
  const { layout, layoutError, debug } = parsed.data;
  const persist = parsed.data.persist ?? false;
  const savedText = parsed.data.saved ?? null;
  // Saved state that no longer parses is ignored, not an error: the window
  // opens fresh and the next change overwrites it.
  const saved = savedText === null ? null : parseWorkspace(savedText);
  if (layoutError !== null) {
    return { layout: defaultDraft(), problem: layoutError, saved, persist, debug };
  }
  if (layout === null) {
    return { layout: defaultDraft(), problem: null, saved, persist, debug };
  }
  try {
    return { layout: parseLayout(layout.text), problem: null, saved, persist, debug };
  } catch (error) {
    if (error instanceof LayoutError) {
      return {
        layout: defaultDraft(),
        problem: `${layout.path}: ${error.message}`,
        saved,
        persist,
        debug,
      };
    }
    throw error;
  }
}
