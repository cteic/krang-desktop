/**
 * What an agent's output line means, in terms the transcript understands.
 * Each agent has its own JSON event format. An adapter turns one line of it
 * into zero or more of these.
 */
export type AgentEvent =
  | { type: 'session'; id: string }
  /** A piece of the message being written. */
  | { type: 'text-delta'; text: string }
  /** A whole message. It may repeat text already sent as deltas. */
  | { type: 'text'; text: string }
  /** A tool call. `id` is the agent's own id for it, when it gives one. */
  | { type: 'tool'; id: string | null; name: string; summary: string }
  /** An output line that could not be read, kept as it came. */
  | { type: 'note'; text: string }
  | { type: 'done'; costUsd: number | null }
  /** What a run cost, from a run that ends without `done`. */
  | { type: 'cost'; costUsd: number }
  | { type: 'error'; message: string };

const SUMMARY_LIMIT = 120;

/** Squeezes text onto one line and cuts it to a length a note can show. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_LIMIT) {
    return flat;
  }
  return `${flat.slice(0, SUMMARY_LIMIT - 1)}…`;
}

/**
 * Parses one output line as JSON. A blank line gives null. A line that is
 * not JSON gives a `note` event, so nothing the agent printed is lost.
 */
export function parseJsonLine(line: string): { value: unknown } | { note: AgentEvent } | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return { value };
  } catch {
    return { note: { type: 'note', text: trimmed } };
  }
}
