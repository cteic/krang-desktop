import type { Badge, Direction, PaneContent } from '../workspace/model';

export interface OpenPaneOptions {
  /** Where the new pane goes relative to this one. Defaults to `row`: beside it. */
  direction?: Direction;
  title?: string;
}

/** What a pane may ask the workspace to do. Stable for the life of the pane. */
export interface PaneActions {
  /** Opens a new pane next to this one and focuses it. */
  openPane(content: PaneContent, options?: OpenPaneOptions): void;
  /** Swaps what this pane shows, keeping its place in the layout. */
  replaceContent(content: PaneContent): void;
  /** Sets the title bar text. Null goes back to the title derived from content. */
  setTitle(title: string | null): void;
  setBadge(badge: Badge | null): void;
  close(): void;
}

export interface PaneProps<C extends PaneContent> {
  paneId: string;
  /** A short name for logs and debug snapshots. Not unique. */
  name: string;
  content: C;
  /** True when this pane has keyboard focus within the window. */
  active: boolean;
  /** True when debug snapshots are on. See `useDebugSnapshot`. */
  debug: boolean;
  actions: PaneActions;
}
