import type { ModeId } from './modes';

/** What an adapter needs to build the arguments for one message. */
export interface RunRequest {
  mode: ModeId;
  /** The directory the agent works in. It may start with `~`. Null is home. */
  directory: string | null;
  /** The agent's id for the conversation so far. Null for a first message. */
  sessionId: string | null;
  /**
   * Whether the person has trusted the directory. Until they have, the
   * directory's own agent settings must not load.
   */
  trusted: boolean;
}
