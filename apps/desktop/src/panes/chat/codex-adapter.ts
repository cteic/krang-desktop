import { z } from 'zod';

import { type AgentEvent, oneLine, parseJsonLine } from './agent-event';
import { CODEX_SANDBOX_MODES } from './modes';
import type { RunRequest } from './run-request';

const typedSchema = z.object({ type: z.string() });

const threadSchema = z.object({ thread_id: z.string() });

const itemSchema = z.object({
  item: z.object({
    id: z.string().optional(),
    type: z.string(),
    text: z.string().optional(),
    command: z.string().optional(),
    message: z.string().optional(),
    query: z.string().optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
    changes: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
  }),
});

const changeSchema = z.object({ path: z.string() });

const failedSchema = z.object({ error: z.object({ message: z.string() }) });

const errorSchema = z.object({ message: z.string() });

type CodexItem = z.infer<typeof itemSchema>['item'];

/**
 * The arguments for one message. The prompt goes on standard input: the
 * final `-` says so.
 *
 * `codex exec resume` takes neither `-s` nor `-C`, so a follow-up sets the
 * sandbox through the `sandbox_mode` config key and relies on the process's
 * own working directory. `-C` is given only for an absolute path: Codex
 * does not expand `~`, and the process already starts in the right place.
 */
export function codexArgs({ mode, directory, sessionId }: RunRequest): string[] {
  const sandbox = CODEX_SANDBOX_MODES[mode];
  if (sessionId !== null) {
    return [
      'exec',
      'resume',
      sessionId,
      '--json',
      '--skip-git-repo-check',
      '-c',
      `sandbox_mode="${sandbox}"`,
      '-',
    ];
  }
  const args = ['exec', '--json', '--skip-git-repo-check'];
  if (directory !== null && directory.startsWith('/')) {
    args.push('-C', directory);
  }
  args.push('-s', sandbox, '-');
  return args;
}

function changedPaths(changes: unknown[] | undefined): string {
  const paths = (changes ?? []).flatMap((change) => {
    const parsed = changeSchema.safeParse(change);
    return parsed.success ? [parsed.data.path] : [];
  });
  return oneLine(paths.join(', '));
}

function toolEvent(item: CodexItem, name: string, summary: string): AgentEvent {
  return { type: 'tool', id: item.id ?? null, name, summary };
}

function itemEvents(item: CodexItem, completed: boolean): AgentEvent[] {
  switch (item.type) {
    case 'agent_message':
      return completed && item.text !== undefined && item.text !== ''
        ? [{ type: 'text', text: item.text }]
        : [];
    case 'command_execution':
      return [toolEvent(item, 'Run', oneLine(item.command ?? ''))];
    case 'file_change':
      return [toolEvent(item, 'Edit', changedPaths(item.changes))];
    case 'mcp_tool_call':
      return [toolEvent(item, [item.server, item.tool].filter(Boolean).join('.') || 'Tool', '')];
    case 'web_search':
      return [toolEvent(item, 'Search', oneLine(item.query ?? ''))];
    case 'todo_list':
      return [toolEvent(item, 'Plan', `${String(item.items?.length ?? 0)} steps`)];
    case 'error':
      // An error item is a warning inside a turn that carries on. A turn
      // that fails says so with `turn.failed`.
      return completed && item.message !== undefined ? [{ type: 'note', text: item.message }] : [];
    default:
      return [];
  }
}

/**
 * Reads one line of `codex exec --json`. An event type this does not know,
 * or a known one with an unexpected shape, gives no events.
 */
export function parseCodexLine(line: string): AgentEvent[] {
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
    case 'thread.started': {
      const thread = threadSchema.safeParse(json.value);
      return thread.success ? [{ type: 'session', id: thread.data.thread_id }] : [];
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const parsed = itemSchema.safeParse(json.value);
      return parsed.success
        ? itemEvents(parsed.data.item, typed.data.type === 'item.completed')
        : [];
    }
    case 'turn.completed':
      return [{ type: 'done', costUsd: null }];
    case 'turn.failed': {
      const failed = failedSchema.safeParse(json.value);
      return [
        { type: 'error', message: failed.success ? failed.data.error.message : 'The turn failed' },
      ];
    }
    case 'error': {
      const error = errorSchema.safeParse(json.value);
      return [
        {
          type: 'error',
          message: error.success ? error.data.message : 'The agent reported an error',
        },
      ];
    }
    default:
      return [];
  }
}
