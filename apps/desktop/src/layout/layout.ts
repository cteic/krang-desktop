import { parse } from 'smol-toml';
import { z } from 'zod';

/**
 * A layout file describes one window: a tree of splits whose leaves are
 * terminal panes. The format is the tab-config TOML the cockpit templates
 * already use, so those files load unchanged.
 *
 * `split = "vertical"` puts children side by side, divided by a vertical
 * line. `split = "horizontal"` stacks them.
 */

export interface TerminalNode {
  kind: 'terminal';
  id: string;
  directory: string | null;
  focused: boolean;
  commands: string[];
}

export interface SplitNode {
  kind: 'split';
  id: string;
  direction: 'row' | 'column';
  children: PaneTree[];
}

export type PaneTree = TerminalNode | SplitNode;

export interface Layout {
  name: string;
  title: string;
  color: string | null;
  root: PaneTree;
}

export class LayoutError extends Error {
  override name = 'LayoutError';
}

const paneSchema = z.object({
  id: z.string().min(1),
  split: z.enum(['vertical', 'horizontal']).optional(),
  children: z.array(z.string().min(1)).min(1).optional(),
  type: z.literal('terminal').optional(),
  directory: z.string().min(1).optional(),
  is_focused: z.boolean().optional(),
  commands: z.array(z.string()).optional(),
});

const fileSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
  panes: z.array(paneSchema).min(1),
});

type PaneEntry = z.infer<typeof paneSchema>;

export function parseLayout(text: string): Layout {
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

  return {
    name: file.name,
    title: file.title ?? file.name,
    color: file.color ?? null,
    root: buildNode(rootEntry, byId, new Set<string>()),
  };
}

function buildNode(entry: PaneEntry, byId: Map<string, PaneEntry>, path: Set<string>): PaneTree {
  if (path.has(entry.id)) {
    throw new LayoutError(`pane "${entry.id}" contains itself`);
  }

  const isSplit = entry.split !== undefined || entry.children !== undefined;
  if (!isSplit) {
    return {
      kind: 'terminal',
      id: entry.id,
      directory: entry.directory ?? null,
      focused: entry.is_focused ?? false,
      commands: entry.commands ?? [],
    };
  }

  if (entry.split === undefined || entry.children === undefined) {
    throw new LayoutError(`pane "${entry.id}" needs both "split" and "children" to be a split`);
  }
  if (entry.type !== undefined || entry.directory !== undefined || entry.commands !== undefined) {
    throw new LayoutError(`pane "${entry.id}" is a split, so it cannot also be a terminal`);
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
  };
}

/** The layout used when no file is given: one shell in the home directory. */
export function defaultLayout(): Layout {
  return {
    name: 'default',
    title: 'shell',
    color: null,
    root: { kind: 'terminal', id: 'shell', directory: null, focused: true, commands: [] },
  };
}

export function terminalsOf(tree: PaneTree): TerminalNode[] {
  if (tree.kind === 'terminal') {
    return [tree];
  }
  return tree.children.flatMap(terminalsOf);
}

/**
 * The pane that takes keyboard focus when the window opens: the first one
 * marked focused, or the first terminal when none is marked.
 */
export function focusedPaneId(tree: PaneTree): string | null {
  const terminals = terminalsOf(tree);
  const marked = terminals.find((terminal) => terminal.focused);
  return marked?.id ?? terminals[0]?.id ?? null;
}
