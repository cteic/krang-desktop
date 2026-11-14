import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';

/**
 * What the editor asks of a notes vault that uses the Discourse Graphs
 * plugin's file format. Every reply is checked before it is used.
 */

const nodeTypeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** The naming pattern for notes of this type, such as `CLM - {content}`. */
  format: z.string(),
  color: z.string().nullable().optional(),
  /** The tag that marks text as a candidate for this type. Not every type has one. */
  tag: z.string().nullable().optional(),
});

export type NodeType = z.infer<typeof nodeTypeSchema>;

const graphSchema = z.object({ nodeTypes: z.array(nodeTypeSchema) });

const createdNodeSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  path: z.string().min(1),
});

export type CreatedNode = z.infer<typeof createdNodeSchema>;

export interface NewNode {
  vault: string;
  typeId: string;
  /** What the note is about. The vault's naming pattern turns it into a title. */
  text: string;
  body: string;
}

/**
 * The vault a file belongs to, or null when it is in none. A shell that
 * cannot answer is treated the same as a file outside any vault.
 */
export async function vaultRootOf(path: string): Promise<string | null> {
  try {
    const reply: unknown = await invoke('graph_vault_root', { path });
    return typeof reply === 'string' && reply !== '' ? reply : null;
  } catch {
    return null;
  }
}

export async function readNodeTypes(vault: string): Promise<NodeType[]> {
  const reply: unknown = await invoke('graph_read', { path: vault });
  return graphSchema.parse(reply).nodeTypes;
}

/** Creates a note of the given type. Rejects with the core's own message. */
export async function createNode(node: NewNode): Promise<CreatedNode> {
  const reply: unknown = await invoke('graph_create_node', {
    vault: node.vault,
    typeId: node.typeId,
    text: node.text,
    body: node.body,
  });
  return createdNodeSchema.parse(reply);
}
