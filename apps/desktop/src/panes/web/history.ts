/**
 * The pane's own back and forward list. A cross-origin frame's history is not
 * readable, so the pane records the addresses it was sent to.
 */
export interface HistoryState {
  entries: readonly string[];
  /** Position in `entries`. -1 when nothing has been opened. */
  index: number;
  /** Goes up on every load, a reload included. The frame is keyed on it. */
  visit: number;
}

export interface NavigateAction {
  type: 'navigate';
  url: string;
}

export interface MoveAction {
  type: 'back' | 'forward' | 'reload';
}

export type HistoryAction = NavigateAction | MoveAction;

export const EMPTY_HISTORY: HistoryState = { entries: [], index: -1, visit: 0 };

export function initialHistory(url: string): HistoryState {
  return url === '' ? EMPTY_HISTORY : { entries: [url], index: 0, visit: 1 };
}

/** The address at the current position. Empty when nothing has been opened. */
export function currentUrl(state: HistoryState): string {
  return state.entries[state.index] ?? '';
}

export function backUrl(state: HistoryState): string | null {
  return state.index > 0 ? (state.entries[state.index - 1] ?? null) : null;
}

export function forwardUrl(state: HistoryState): string | null {
  return state.entries[state.index + 1] ?? null;
}

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'navigate': {
      if (action.url === '') {
        return state;
      }
      // Going to the address already shown is a reload, not a new entry.
      if (action.url === currentUrl(state)) {
        return { ...state, visit: state.visit + 1 };
      }
      return {
        entries: [...state.entries.slice(0, state.index + 1), action.url],
        index: state.index + 1,
        visit: state.visit + 1,
      };
    }
    case 'back':
      return backUrl(state) === null
        ? state
        : { ...state, index: state.index - 1, visit: state.visit + 1 };
    case 'forward':
      return forwardUrl(state) === null
        ? state
        : { ...state, index: state.index + 1, visit: state.visit + 1 };
    case 'reload':
      return state.index < 0 ? state : { ...state, visit: state.visit + 1 };
  }
}
