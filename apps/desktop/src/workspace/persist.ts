import { z } from 'zod';

import { EDITOR_MODES, leavesOf } from './model';
import type { PaneContent, PaneTree, Tab, Workspace } from './model';

/**
 * Saving and restoring a window's workspace between runs.
 *
 * What comes back is the arrangement, not the processes: a restored terminal
 * is a new shell in the same directory. Its startup commands are dropped on
 * save, so reopening the app never reruns them unasked.
 */

const VERSION = 1;

const contentSchema: z.ZodType<PaneContent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('terminal'),
    directory: z.string().nullable(),
    commands: z.array(z.string()),
  }),
  z.object({ type: z.literal('files'), directory: z.string().nullable() }),
  z.object({
    type: z.literal('editor'),
    path: z.string().nullable(),
    mode: z.enum(EDITOR_MODES).optional(),
  }),
  z.object({ type: z.literal('web'), url: z.string() }),
  z.object({
    type: z.literal('chat'),
    agent: z.string().nullable(),
    directory: z.string().nullable(),
  }),
  z.object({
    type: z.literal('graph'),
    directory: z.string().nullable(),
    view: z.string().nullable(),
  }),
]);

const leafSchema = z.object({
  kind: z.literal('leaf'),
  id: z.string().regex(/^p\d+$/),
  title: z.string().nullable(),
  badge: z.object({ text: z.string(), color: z.string().nullable() }).nullable(),
  content: contentSchema,
});

const treeSchema: z.ZodType<PaneTree> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({
      kind: z.literal('split'),
      id: z.string().regex(/^s\d+$/),
      direction: z.enum(['row', 'column']),
      children: z.array(treeSchema).min(2),
      shares: z.array(z.number().positive()),
    }),
  ]),
);

const tabSchema = z.object({
  id: z.string().regex(/^t\d+$/),
  title: z.string(),
  color: z.string().nullable(),
  root: treeSchema,
  focusedId: z.string(),
  magnifiedId: z.string().nullable(),
});

const savedSchema = z.object({
  version: z.literal(VERSION),
  workspace: z.object({
    tabs: z.array(tabSchema).min(1),
    activeTabId: z.string(),
    nextId: z.number().int().positive(),
  }),
});

function withoutRuntimeState(tree: PaneTree): PaneTree {
  if (tree.kind === 'split') {
    return { ...tree, children: tree.children.map(withoutRuntimeState) };
  }
  const content =
    tree.content.type === 'terminal' ? { ...tree.content, commands: [] } : tree.content;
  // A badge reports something that happened in the last run. It is stale now.
  return { ...tree, badge: null, content };
}

export function serializeWorkspace(workspace: Workspace): string {
  const tabs = workspace.tabs.map((tab) => ({
    ...tab,
    magnifiedId: null,
    root: withoutRuntimeState(tab.root),
  }));
  return JSON.stringify({ version: VERSION, workspace: { ...workspace, tabs } });
}

function allIds(tree: PaneTree): string[] {
  if (tree.kind === 'leaf') {
    return [tree.id];
  }
  return [tree.id, ...tree.children.flatMap(allIds)];
}

function numberOf(id: string): number {
  return Number(id.slice(1));
}

function splitsAreConsistent(tree: PaneTree): boolean {
  if (tree.kind === 'leaf') {
    return true;
  }
  return tree.shares.length === tree.children.length && tree.children.every(splitsAreConsistent);
}

function repairTab(tab: Tab): Tab {
  const leaves = leavesOf(tab.root);
  const focused = leaves.find((leaf) => leaf.id === tab.focusedId) ?? leaves[0];
  return { ...tab, focusedId: focused?.id ?? tab.focusedId, magnifiedId: null };
}

/**
 * Reads a saved workspace. Returns null for anything that is not a sound
 * one: wrong version, wrong shape, repeated ids, or an id counter that could
 * hand out an id already in use. The caller then starts fresh.
 */
export function parseWorkspace(text: string): Workspace | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = savedSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const saved = parsed.data.workspace;

  if (!saved.tabs.every((tab) => splitsAreConsistent(tab.root))) {
    return null;
  }
  const ids = saved.tabs.flatMap((tab) => [tab.id, ...allIds(tab.root)]);
  if (new Set(ids).size !== ids.length) {
    return null;
  }
  if (ids.some((id) => numberOf(id) >= saved.nextId)) {
    return null;
  }

  // Applied on load as well as on save: a saved file edited by hand must not
  // be able to run commands when the app opens.
  const tabs = saved.tabs.map((tab) => repairTab({ ...tab, root: withoutRuntimeState(tab.root) }));
  const activeTabId = tabs.find((tab) => tab.id === saved.activeTabId)?.id ?? tabs[0]?.id;
  if (activeTabId === undefined) {
    return null;
  }
  return { tabs, activeTabId, nextId: saved.nextId };
}
