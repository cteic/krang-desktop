import { describe, expect, it } from 'vitest';

import {
  EMPTY_HISTORY,
  backUrl,
  currentUrl,
  forwardUrl,
  historyReducer,
  initialHistory,
} from './history';
import type { HistoryAction, HistoryState } from './history';

function run(state: HistoryState, ...actions: HistoryAction[]): HistoryState {
  return actions.reduce(historyReducer, state);
}

function go(url: string): HistoryAction {
  return { type: 'navigate', url };
}

describe('historyReducer', () => {
  it('starts empty, or with one entry', () => {
    expect(initialHistory('')).toBe(EMPTY_HISTORY);
    expect(currentUrl(EMPTY_HISTORY)).toBe('');
    expect(initialHistory('http://a/')).toEqual({ entries: ['http://a/'], index: 0, visit: 1 });
  });

  it('appends on navigate and moves to the new entry', () => {
    const state = run(EMPTY_HISTORY, go('http://a/'), go('http://b/'));
    expect(state.entries).toEqual(['http://a/', 'http://b/']);
    expect(state.index).toBe(1);
    expect(currentUrl(state)).toBe('http://b/');
  });

  it('moves the index back and forward without changing the list', () => {
    const start = run(EMPTY_HISTORY, go('http://a/'), go('http://b/'), go('http://c/'));
    const back = run(start, { type: 'back' }, { type: 'back' });
    expect(back.index).toBe(0);
    expect(back.entries).toEqual(start.entries);
    expect(backUrl(back)).toBeNull();
    expect(forwardUrl(back)).toBe('http://b/');

    const forward = run(back, { type: 'forward' });
    expect(currentUrl(forward)).toBe('http://b/');
    expect(backUrl(forward)).toBe('http://a/');
    expect(forwardUrl(forward)).toBe('http://c/');
  });

  it('does nothing at either end', () => {
    const one = initialHistory('http://a/');
    expect(run(one, { type: 'back' })).toBe(one);
    expect(run(one, { type: 'forward' })).toBe(one);
    expect(run(EMPTY_HISTORY, { type: 'back' })).toBe(EMPTY_HISTORY);
    expect(run(EMPTY_HISTORY, { type: 'forward' })).toBe(EMPTY_HISTORY);
    expect(run(EMPTY_HISTORY, { type: 'reload' })).toBe(EMPTY_HISTORY);
    expect(run(one, go(''))).toBe(one);
  });

  it('truncates forward history on navigate', () => {
    const start = run(EMPTY_HISTORY, go('http://a/'), go('http://b/'), go('http://c/'));
    const state = run(start, { type: 'back' }, { type: 'back' }, go('http://d/'));
    expect(state.entries).toEqual(['http://a/', 'http://d/']);
    expect(state.index).toBe(1);
    expect(forwardUrl(state)).toBeNull();
  });

  it('keeps the index and the list on reload, and counts a new visit', () => {
    const start = run(EMPTY_HISTORY, go('http://a/'), go('http://b/'), { type: 'back' });
    const state = run(start, { type: 'reload' });
    expect(state.index).toBe(start.index);
    expect(state.entries).toEqual(start.entries);
    expect(state.visit).toBe(start.visit + 1);
  });

  it('treats navigating to the current address as a reload', () => {
    const start = run(EMPTY_HISTORY, go('http://a/'), go('http://b/'), { type: 'back' });
    const state = run(start, go('http://a/'));
    expect(state.entries).toEqual(['http://a/', 'http://b/']);
    expect(state.index).toBe(0);
    expect(state.visit).toBe(start.visit + 1);
  });

  it('counts a visit for every load', () => {
    const state = run(
      EMPTY_HISTORY,
      go('http://a/'),
      go('http://b/'),
      { type: 'back' },
      { type: 'forward' },
      { type: 'reload' },
    );
    expect(state.visit).toBe(5);
  });
});
