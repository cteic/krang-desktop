import { z } from 'zod';

import { type AgentEvent, oneLine, parseJsonLine } from './agent-event';
import {
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_DENIED_TOOLS,
  CLAUDE_PERMISSION_MODES,
  CLAUDE_UNTRUSTED_SETTING_SOURCES,
} from './modes';
import type { RunRequest } from './run-request';

const typedSchema = z.object({ type: z.string() });

const initSchema = z.object({ subtype: z.literal('init'), session_id: z.string() });

const streamSchema = z.object({
  event: z.object({
    type: z.string(),
    delta: z.object({ type: z.string(), text: z.string().optional() }).optional(),
    content_block: z
      .object({ type: z.string(), id: z.string().optional(), name: z.string().optional() })
      .optional(),
  }),
});

const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});

const assistantSchema = z.object({
  message: z.object({ content: z.array(z.unknown()) }),
});

const resultSchema = z.object({
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  errors: z.array(z.string()).optional(),
});

const inputSchema = z.record(z.string(), z.unknown());

/** The input fields that say most about a tool call, most telling first. */
const SUMMARY_KEYS = [
  'file_path',
  'path',
  'notebook_path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

/**
 * The arguments for one message. The prompt goes on standard input. The
 * working directory is the process's own, so it is not an argument.
 */
export function claudeArgs({ mode, sessionId, trusted }: RunRequest): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    CLAUDE_PERMISSION_MODES[mode],
  ];
  if (!trusted) {
    // Print mode skips the workspace trust question, so this stands in for
    // it: the directory's own settings stay out until the person says yes.
    args.push('--setting-sources', CLAUDE_UNTRUSTED_SETTING_SOURCES);
  }
  args.push('--disallowedTools', ...CLAUDE_DENIED_TOOLS);
  const allowed = CLAUDE_ALLOWED_TOOLS[mode];
  if (allowed.length > 0) {
    // The flag takes every word up to the next flag, so it goes after the
    // others and before `--resume`.
    args.push('--allowedTools', ...allowed);
  }
  if (sessionId !== null) {
    args.push('--resume', sessionId);
  }
  return args;
}

/** One line that says what a tool was asked to do, such as a file path. */
export function summariseToolInput(input: unknown): string {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return typeof input === 'string' ? oneLine(input) : '';
  }
  const record = parsed.data;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return oneLine(value);
    }
  }
  const firstText = Object.values(record).find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  if (typeof firstText === 'string') {
    return oneLine(firstText);
  }
  return Object.keys(record).length === 0 ? '' : oneLine(JSON.stringify(record));
}

function streamEvents(value: unknown): AgentEvent[] {
  const parsed = streamSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const { type, delta, content_block: block } = parsed.data.event;
  if (type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text !== undefined) {
    return delta.text === '' ? [] : [{ type: 'text-delta', text: delta.text }];
  }
  if (type === 'content_block_start' && block?.type === 'tool_use' && block.name !== undefined) {
    return [{ type: 'tool', id: block.id ?? null, name: block.name, summary: '' }];
  }
  return [];
}

function assistantEvents(value: unknown): AgentEvent[] {
  const parsed = assistantSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const events: AgentEvent[] = [];
  for (const raw of parsed.data.message.content) {
    const block = blockSchema.safeParse(raw);
    if (!block.success) {
      continue;
    }
    const { type, text, id, name, input } = block.data;
    if (type === 'text' && text !== undefined && text !== '') {
      events.push({ type: 'text', text });
    }
    if (type === 'tool_use' && name !== undefined) {
      events.push({ type: 'tool', id: id ?? null, name, summary: summariseToolInput(input) });
    }
  }
  return events;
}

function resultEvents(value: unknown): AgentEvent[] {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  const { subtype, is_error: isError, result, session_id: sessionId, errors } = parsed.data;
  const events: AgentEvent[] = [];
  if (sessionId !== undefined) {
    events.push({ type: 'session', id: sessionId });
  }
  const failed = isError === true || (subtype !== undefined && subtype !== 'success');
  if (failed) {
    if (parsed.data.total_cost_usd !== undefined) {
      events.push({ type: 'cost', costUsd: parsed.data.total_cost_usd });
    }
    const detail = errors !== undefined && errors.length > 0 ? errors.join('\n') : result;
    const message = detail !== undefined && detail !== '' ? detail : (subtype ?? 'The run failed');
    events.push({ type: 'error', message });
  } else {
    events.push({ type: 'done', costUsd: parsed.data.total_cost_usd ?? null });
  }
  return events;
}

/**
 * Reads one line of `--output-format stream-json`. An event type this does
 * not know, or a known one with an unexpected shape, gives no events.
 */
export function parseClaudeLine(line: string): AgentEvent[] {
  const json = parseJsonLine(line);
  if (json === null) {
    return [];
  }
  if ('note' in json) {
    return [json.note];
  }
  const typed = typedSchema.safeParse(json.value);
  if (!typed.success) {
    return [];
  }
  switch (typed.data.type) {
    case 'system': {
      const init = initSchema.safeParse(json.value);
      return init.success ? [{ type: 'session', id: init.data.session_id }] : [];
    }
    case 'stream_event':
      return streamEvents(json.value);
    case 'assistant':
      return assistantEvents(json.value);
    case 'result':
      return resultEvents(json.value);
    default:
      return [];
  }
}
