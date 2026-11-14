import { z } from 'zod';

import { LayoutError, parseLayout } from './layout/layout';
import type { Workspace } from './workspace/model';
import { parseWorkspace } from './workspace/persist';
import { defaultDraft } from './workspace/reducer';
import type { TabDraft } from './workspace/reducer';

const layoutFileSchema = z.object({ path: z.string(), text: z.string() });

const layoutEntrySchema = z.object({
  layout: layoutFileSchema.nullable(),
  layoutError: z.string().nullable(),
});

type LayoutEntry = z.infer<typeof layoutEntrySchema>;

const startupSchema = z.object({
  layout: layoutFileSchema.nullable(),
  layoutError: z.string().nullable(),
  // Every layout asked for, in tab order. An older shell leaves it out.
  layouts: z.array(layoutEntrySchema).optional(),
  saved: z.string().nullable().optional(),
  persist: z.boolean().optional(),
  debug: z.boolean(),
});

export interface Session {
  layout: TabDraft;
  /** The tabs after the first, when several layouts were asked for. */
  extraTabs: TabDraft[];
  /** Why a requested layout was not used. Null when all is well. */
  problem: string | null;
  /** The workspace this window had last time. Takes the place of `layout`. */
  saved: Workspace | null;
  /** Whether to save the workspace as it changes. */
  persist: boolean;
  debug: boolean;
}

/**
/** Each layout that parses becomes a tab. Each that does not becomes a problem. */
function readEntries(entries: readonly LayoutEntry[]): { drafts: TabDraft[]; problems: string[] } {
  const drafts: TabDraft[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.layoutError !== null) {
      problems.push(entry.layoutError);
    } else if (entry.layout !== null) {
      try {
        drafts.push(parseLayout(entry.layout.text));
      } catch (error) {
        if (!(error instanceof LayoutError)) {
          throw error;
        }
        problems.push(`${entry.layout.path}: ${error.message}`);
      }
    }
  }
  return { drafts, problems };
}

/**
 * Turns the Rust `startup` reply into what the window shows. A layout that
 * cannot be read or parsed never leaves a blank window: the default layout
 * opens and the problem is shown above it. When several layouts were asked
 * for, each one that loads is a tab and each one that does not is named.
 */
export function toSession(reply: unknown): Session {
  const parsed = startupSchema.safeParse(reply);
  if (!parsed.success) {
    return {
      layout: defaultDraft(),
      extraTabs: [],
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
  const listed = parsed.data.layouts ?? [];
  const { drafts, problems } = readEntries(listed.length > 0 ? listed : [{ layout, layoutError }]);
  const [first, ...extraTabs] = drafts;
  return {
    layout: first ?? defaultDraft(),
    extraTabs,
    problem: problems.length === 0 ? null : problems.join('; '),
    saved,
    persist,
    debug,
  };
}
