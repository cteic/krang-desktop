import type { AgentEvent } from './agent-event';
import { claudeArgs, parseClaudeLine } from './claude-adapter';
import { codexArgs, parseCodexLine } from './codex-adapter';
import type { RunRequest } from './run-request';

export const AGENT_IDS = ['claude', 'codex'] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const DEFAULT_AGENT: AgentId = 'claude';

export interface AgentAdapter {
  label: string;
  /**
   * True when the agent would load a directory's own settings and hooks
   * without asking, so the pane has to ask first. Codex keeps its own
   * record of trusted projects and hooks, and a run here never bypasses it.
   */
  asksFolderTrust: boolean;
  /** The full argument list for one message. */
  buildArgs(request: RunRequest): string[];
  /** Turns one line of standard output into events. Never throws. */
  parseLine(line: string): AgentEvent[];
}

export const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: {
    label: 'Claude Code',
    asksFolderTrust: true,
    buildArgs: claudeArgs,
    parseLine: parseClaudeLine,
  },
  codex: {
    label: 'Codex',
    asksFolderTrust: false,
    buildArgs: codexArgs,
    parseLine: parseCodexLine,
  },
};

export function isAgentId(value: string): value is AgentId {
  return AGENT_IDS.some((id) => id === value);
}

/** The agent a pane's content names. Null or an unknown name is the default. */
export function toAgentId(value: string | null): AgentId {
  return value !== null && isAgentId(value) ? value : DEFAULT_AGENT;
}
