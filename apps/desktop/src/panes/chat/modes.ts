import { CHAT_MODES, type ChatMode } from '../../workspace/model';

/**
 * What a chat may do to the machine. There are two modes and no third: no
 * mode here turns off an agent's permission checks or its sandbox.
 */
export const MODE_IDS = CHAT_MODES;

export type ModeId = ChatMode;

export const DEFAULT_MODE: ModeId = 'read-only';

export const MODE_LABELS: Record<ModeId, string> = {
  'read-only': 'Read only',
  edit: 'Edit files and graph',
};

/** Claude Code: the value of `--permission-mode`. */
export const CLAUDE_PERMISSION_MODES: Record<ModeId, string> = {
  'read-only': 'plan',
  edit: 'acceptEdits',
};

/**
 * Claude Code: the shell commands this app allows it to run, on top of what
 * the permission mode and the person's own settings allow. A run has nobody
 * to ask, so a command that needs approval is refused. These four create
 * and list graph nodes and relations in a vault's files. The bare tool is
 * left out on purpose: its other commands drive the app, and one of them
 * types into a terminal.
 */
export const CLAUDE_ALLOWED_TOOLS: Record<ModeId, readonly string[]> = {
  'read-only': [],
  edit: ['Bash(kd node:*)', 'Bash(kd relate:*)', 'Bash(kd types:*)', 'Bash(kd nodes:*)'],
};

/** Codex: the value of `-s`, its sandbox policy. */
export const CODEX_SANDBOX_MODES: Record<ModeId, string> = {
  'read-only': 'read-only',
  edit: 'workspace-write',
};

export function isModeId(value: string): value is ModeId {
  return MODE_IDS.some((id) => id === value);
}
