import { parse } from 'smol-toml';
import { z } from 'zod';

import type { PaneContent, PaneTree } from '../workspace/model';
import type { TabDraft } from '../workspace/reducer';
import { CHAT_MODES, EDITOR_MODES } from '../workspace/model';
import { equalShares, sharesFromSizes } from '../workspace/split-sizes';

/**
 * A layout file describes one tab: a tree of splits whose leaves are panes.
 * The format is the tab-config TOML the cockpit templates already use, so
 * those files load unchanged. A pane with no `type` is a terminal.
 *
 * `split = "vertical"` puts children side by side, divided by a vertical
 * line. `split = "horizontal"` stacks them.
 *
 * Two keys go beyond that format, and a reader that does not know them
 * ignores them: `sizes` on a split gives its children relative sizes, and
 * `mode` says how an editor pane opens, or what a chat pane's agent may do.
 */

export class LayoutError extends Error {
  override name = 'LayoutError';
}

const paneSchema = z.object({
  id: z.string().min(1),
  split: z.enum(['vertical', 'horizontal']).optional(),
  children: z.array(z.string().min(1)).min(1).optional(),
  type: z.enum(['terminal', 'files', 'editor', 'web', 'chat', 'graph']).optional(),
  title: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
  is_focused: z.boolean().optional(),
  commands: z.array(z.string()).optional(),
  path: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  view: z.string().min(1).optional(),
  mode: z.string().min(1).optional(),
  sizes: z.array(z.number()).optional(),
});

const fileSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
  panes: z.array(paneSchema).min(1),
});

type PaneEntry = z.infer<typeof paneSchema>;

const LEAF_ONLY_FIELDS = [
  'type',
  'directory',
  'commands',
  'path',
  'url',
  'agent',
  'view',
  'mode',
] as const;

export function parseLayout(text: string): TabDraft {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new LayoutError(
      `not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : `${issue.path.join('.')}: ${issue.message}`;
    throw new LayoutError(`layout does not match the expected shape. ${where}`);
  }
  const file = result.data;

  const byId = new Map<string, PaneEntry>();
  for (const pane of file.panes) {
    if (byId.has(pane.id)) {
      throw new LayoutError(`pane id "${pane.id}" is used twice`);
    }
    byId.set(pane.id, pane);
  }

  const referenced = new Set<string>();
  for (const pane of file.panes) {
    for (const child of pane.children ?? []) {
      if (!byId.has(child)) {
        throw new LayoutError(`pane "${pane.id}" lists child "${child}", which is not defined`);
      }
      if (referenced.has(child)) {
        throw new LayoutError(`pane "${child}" is the child of more than one split`);
      }
      referenced.add(child);
    }
  }

  const roots = file.panes.filter((pane) => !referenced.has(pane.id));
  const rootEntry = roots[0];
  if (rootEntry === undefined) {
    throw new LayoutError('no root pane: every pane is the child of another');
  }
  if (roots.length > 1) {
    const names = roots.map((pane) => `"${pane.id}"`).join(', ');
    throw new LayoutError(`more than one root pane: ${names}. Exactly one pane may have no parent`);
  }

  const focused = file.panes.find(
    (pane) => pane.is_focused === true && pane.children === undefined,
  );

  return {
    title: file.title ?? file.name,
    color: file.color ?? null,
    root: buildNode(rootEntry, byId, new Set<string>()),
    focusedId: focused?.id ?? null,
  };
}

function contentOf(entry: PaneEntry): PaneContent {
  const type = entry.type ?? 'terminal';
  switch (type) {
    case 'terminal':
      return { type, directory: entry.directory ?? null, commands: entry.commands ?? [] };
    case 'files':
      return { type, directory: entry.directory ?? null };
    case 'editor': {
      const mode = modeOf(entry, EDITOR_MODES, 'an editor');
      return mode === undefined
        ? { type, path: entry.path ?? null }
        : { type, path: entry.path ?? null, mode };
    }
    case 'web':
      if (entry.url === undefined) {
        throw new LayoutError(`pane "${entry.id}" is a web pane, so it needs a "url"`);
      }
      return { type, url: entry.url };
    case 'chat': {
      const mode = modeOf(entry, CHAT_MODES, 'a chat');
      const chat = { type, agent: entry.agent ?? null, directory: entry.directory ?? null };
      return mode === undefined ? chat : { ...chat, mode };
    }
    case 'graph':
      return {
        type,
        directory: entry.directory ?? null,
        // "all" is the view a graph pane opens on, so it needs no name.
        view: entry.view === undefined || entry.view === 'all' ? null : entry.view,
      };
  }
}

/** A pane's `mode`, checked against the modes its type has. */
function modeOf<Mode extends string>(
  entry: PaneEntry,
  modes: readonly Mode[],
  kind: string,
): Mode | undefined {
  if (entry.mode === undefined) {
    return undefined;
  }
  const mode = modes.find((known) => known === entry.mode);
  if (mode === undefined) {
    const known = modes.map((each) => `"${each}"`).join(', ');
    throw new LayoutError(
      `pane "${entry.id}" has mode "${entry.mode}", and ${kind} pane takes one of ${known}`,
    );
  }
  return mode;
}

function buildNode(entry: PaneEntry, byId: Map<string, PaneEntry>, path: Set<string>): PaneTree {
  if (path.has(entry.id)) {
    throw new LayoutError(`pane "${entry.id}" contains itself`);
  }

  const isSplit = entry.split !== undefined || entry.children !== undefined;
  if (!isSplit) {
    if (entry.sizes !== undefined) {
      throw new LayoutError(`pane "${entry.id}" has "sizes", which only a split takes`);
    }
    return {
      kind: 'leaf',
      id: entry.id,
      // A layout's pane id is the best name it has for the pane.
      title: entry.title ?? entry.id,
      badge: null,
      content: contentOf(entry),
    };
  }

  if (entry.split === undefined || entry.children === undefined) {
    throw new LayoutError(`pane "${entry.id}" needs both "split" and "children" to be a split`);
  }
  if (LEAF_ONLY_FIELDS.some((field) => entry[field] !== undefined)) {
    throw new LayoutError(`pane "${entry.id}" is a split, so it cannot also hold content`);
  }

  const nextPath = new Set(path).add(entry.id);
  const children: PaneTree[] = [];
  for (const childId of entry.children) {
    const child = byId.get(childId);
    if (child === undefined) {
      throw new LayoutError(`pane "${entry.id}" lists child "${childId}", which is not defined`);
    }
    children.push(buildNode(child, byId, nextPath));
  }

  return {
    kind: 'split',
    id: entry.id,
    direction: entry.split === 'vertical' ? 'row' : 'column',
    children,
    shares: sharesOf(entry, children.length),
  };
}

/** A split's shares: its `sizes` when it gives them, equal otherwise. */
function sharesOf(entry: PaneEntry, count: number): number[] {
  if (entry.sizes === undefined) {
    return equalShares(count);
  }
  if (entry.sizes.length !== count) {
    throw new LayoutError(
      `pane "${entry.id}" has ${String(entry.sizes.length)} sizes for ${String(count)} children. Give one size per child`,
    );
  }
  const shares = sharesFromSizes(entry.sizes);
  if (shares === null) {
    throw new LayoutError(`pane "${entry.id}" has a size that is not a positive number`);
  }
  return shares;
}
