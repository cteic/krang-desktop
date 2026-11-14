import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

/**
 * What the Rust side reads out of a notes vault that uses the Discourse
 * Graphs plugin for Obsidian. The reply is checked here before any of it is
 * drawn.
 */

const nodeTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  format: z.string(),
  color: z.string().nullable(),
  /** The tag, without its `#`, that marks a line as a candidate for this type. */
  tag: z.string().nullable().default(null),
});

const allowedRelationSchema = z.object({
  sourceTypeId: z.string(),
  destinationTypeId: z.string(),
  relationTypeId: z.string(),
});

const candidateSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  text: z.string(),
  typeId: z.string(),
});

const issueSchema = z.object({
  kind: z.string(),
  text: z.string(),
  path: z.string().nullable(),
});

const relationTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  complement: z.string(),
  color: z.string().nullable(),
});

const nodeSchema = z.object({
  id: z.string().min(1),
  typeId: z.string(),
  title: z.string(),
  path: z.string().min(1),
});

const relationSchema = z.object({
  id: z.string().min(1),
  typeId: z.string(),
  source: z.string().min(1),
  destination: z.string().min(1),
  ambiguous: z.boolean(),
  tentative: z.boolean().nullable(),
});

const canvasPageSchema = z.object({ id: z.string().min(1), name: z.string() });

const canvasNodeSchema = z.object({
  id: z.string().min(1),
  pageId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** The canvas size step of the box's text: `s`, `m`, `l` or `xl`. */
  size: z.string().default('s'),
  title: z.string(),
  typeId: z.string(),
  path: z.string().nullable(),
});

const canvasRelationSchema = z.object({
  id: z.string().min(1),
  pageId: z.string(),
  typeId: z.string(),
  label: z.string(),
  source: z.string().min(1),
  destination: z.string().min(1),
});

const canvasTextSchema = z.object({
  id: z.string().min(1),
  pageId: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  size: z.string(),
  scale: z.number().positive(),
  text: z.string(),
});

const canvasSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  pages: z.array(canvasPageSchema),
  nodes: z.array(canvasNodeSchema),
  relations: z.array(canvasRelationSchema),
  texts: z.array(canvasTextSchema),
  unboundRelations: z.number().int().nonnegative(),
  otherShapes: z.number().int().nonnegative(),
});

const graphSchema = z.object({
  directory: z.string().min(1),
  message: z.string().nullable(),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
  incomplete: z.boolean(),
  nodeTypes: z.array(nodeTypeSchema),
  relationTypes: z.array(relationTypeSchema),
  allowedRelations: z.array(allowedRelationSchema).default([]),
  nodes: z.array(nodeSchema),
  relations: z.array(relationSchema),
  skippedRelations: z.number().int().nonnegative(),
  repeatedIds: z.number().int().nonnegative(),
  canvases: z.array(canvasSchema),
  candidates: z.array(candidateSchema).default([]),
  issues: z.array(issueSchema).default([]),
});

const fingerprintSchema = z.string().min(1);

export type NodeType = z.infer<typeof nodeTypeSchema>;
export type RelationType = z.infer<typeof relationTypeSchema>;
export type AllowedRelation = z.infer<typeof allowedRelationSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type VaultIssue = z.infer<typeof issueSchema>;
export type GraphNode = z.infer<typeof nodeSchema>;
export type GraphRelation = z.infer<typeof relationSchema>;
export type CanvasPage = z.infer<typeof canvasPageSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasRelation = z.infer<typeof canvasRelationSchema>;
export type CanvasText = z.infer<typeof canvasTextSchema>;
export type Canvas = z.infer<typeof canvasSchema>;
export type VaultGraph = z.infer<typeof graphSchema>;

/** Checks a `graph_read` reply. Throws when the shape is not the one expected. */
export function parseGraph(reply: unknown): VaultGraph {
  const result = graphSchema.safeParse(reply);
  if (!result.success) {
    throw new Error('The graph came back in a shape this pane does not understand.');
  }
  return result.data;
}

/** Checks a `graph_fingerprint` reply. Throws when it is not a fingerprint. */
export function parseFingerprint(reply: unknown): string {
  const result = fingerprintSchema.safeParse(reply);
  if (!result.success) {
    throw new Error('The vault fingerprint came back in a shape this pane does not understand.');
  }
  return result.data;
}

/** Reads the whole graph of a vault. */
export async function fetchGraph(directory: string): Promise<VaultGraph> {
  return parseGraph(await invoke('graph_read', { path: directory }));
}

/**
 * A short text that changes when the vault's notes or relations change.
 * Cheap, so the pane asks for it every few seconds.
 */
export async function fetchFingerprint(directory: string): Promise<string> {
  return parseFingerprint(await invoke('graph_fingerprint', { path: directory }));
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
