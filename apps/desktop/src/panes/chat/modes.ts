/**
 * What a chat may do to the machine. There are two modes and no third: no
 * mode here turns off an agent's permission checks or its sandbox.
 */
export const MODE_IDS = ['read-only', 'edit'] as const;

export type ModeId = (typeof MODE_IDS)[number];

export const DEFAULT_MODE: ModeId = 'read-only';

export const MODE_LABELS: Record<ModeId, string> = {
  'read-only': 'Read only',
  edit: 'Can edit files',
};

/** Claude Code: the value of `--permission-mode`. */
export const CLAUDE_PERMISSION_MODES: Record<ModeId, string> = {
  'read-only': 'plan',
  edit: 'acceptEdits',
};

/** Codex: the value of `-s`, its sandbox policy. */
export const CODEX_SANDBOX_MODES: Record<ModeId, string> = {
  'read-only': 'read-only',
  edit: 'workspace-write',
};

export function isModeId(value: string): value is ModeId {
  return MODE_IDS.some((id) => id === value);
}
