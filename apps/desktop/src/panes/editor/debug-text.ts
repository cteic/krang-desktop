import type { ViewMode } from './file-kind';

export interface DebugState {
  path: string | null;
  dirty: boolean;
  view: ViewMode;
  text: string;
}

/** What a debug snapshot of the editor pane holds: one header line, then the buffer. */
export function debugText({ path, dirty, view, text }: DebugState): string {
  return `path=${path ?? 'null'} dirty=${String(dirty)} view=${view}\n${text}`;
}
