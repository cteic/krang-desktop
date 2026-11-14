import { z } from 'zod';

import { LayoutError, parseLayout } from './layout/layout';
import { defaultDraft } from './workspace/reducer';
import type { TabDraft } from './workspace/reducer';

const startupSchema = z.object({
  layout: z.object({ path: z.string(), text: z.string() }).nullable(),
  layoutError: z.string().nullable(),
  debug: z.boolean(),
});

export interface Session {
  layout: TabDraft;
  /** Why the requested layout was not used. Null when all is well. */
  problem: string | null;
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
      debug: false,
    };
  }
  const { layout, layoutError, debug } = parsed.data;
  if (layoutError !== null) {
    return { layout: defaultDraft(), problem: layoutError, debug };
  }
  if (layout === null) {
    return { layout: defaultDraft(), problem: null, debug };
  }
  try {
    return { layout: parseLayout(layout.text), problem: null, debug };
  } catch (error) {
    if (error instanceof LayoutError) {
      return { layout: defaultDraft(), problem: `${layout.path}: ${error.message}`, debug };
    }
    throw error;
  }
}
