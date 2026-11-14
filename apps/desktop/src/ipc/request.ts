import { z } from 'zod';

/**
 * A request from the command-line tool run inside a pane. The Rust shell
 * checks the shape once and forwards it. It is checked again here because
 * the page is where it gets acted on.
 */

/** The event the Rust shell emits to the window a request names. */
export const REQUEST_EVENT = 'ipc-request';

const directionSchema = z.enum(['row', 'column']);

const commandSchema = z.discriminatedUnion('name', [
  z.object({
    name: z.literal('view'),
    path: z.string().min(1),
    kind: z.enum(['file', 'directory']),
    direction: directionSchema,
  }),
  z.object({
    name: z.literal('web'),
    target: z.union([z.object({ url: z.string().min(1) }), z.object({ path: z.string().min(1) })]),
    direction: directionSchema,
  }),
  z.object({
    name: z.literal('term'),
    directory: z.string().min(1),
    command: z.string().nullable(),
  }),
  z.object({
    name: z.literal('chat'),
    agent: z.string().min(1).nullable(),
    directory: z.string().min(1),
  }),
  z.object({
    name: z.literal('title'),
    title: z.string().nullable(),
  }),
  z.object({
    name: z.literal('badge'),
    badge: z.object({ text: z.string(), color: z.string().nullable() }).nullable(),
  }),
  z.object({
    name: z.literal('layout'),
    path: z.string().min(1),
    text: z.string(),
  }),
  z.object({ name: z.literal('panes') }),
]);

export const requestSchema = z.object({
  /** Names the connection that is waiting for this request's answer. */
  requestId: z.string().min(1),
  /** The pane the tool was run in. */
  pane: z.string().min(1),
  command: commandSchema,
});

export type IpcCommand = z.infer<typeof commandSchema>;
export type IpcRequest = z.infer<typeof requestSchema>;

const requestIdSchema = z.object({ requestId: z.string().min(1) });

/** The id to answer under, even when the rest of the payload is unusable. */
export function requestIdOf(payload: unknown): string | null {
  const result = requestIdSchema.safeParse(payload);
  return result.success ? result.data.requestId : null;
}
