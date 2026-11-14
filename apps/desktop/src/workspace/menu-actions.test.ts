import { describe, expect, it } from 'vitest';

import { actionForMenu, contentForSplit, isMenuAction, MENU_ACTIONS } from './menu-actions';
import { activeTab } from './model';
import { createWorkspace } from './reducer';

const START = createWorkspace({
  title: 'one',
  color: null,
  focusedId: 'a',
  root: {
    kind: 'leaf',
    id: 'a',
    title: 'a',
    badge: null,
    content: { type: 'terminal', directory: '/work', commands: ['make'] },
  },
});

describe('isMenuAction', () => {
  it('accepts every listed id and nothing else', () => {
    expect(MENU_ACTIONS.every(isMenuAction)).toBe(true);
    expect(isMenuAction('format-disk')).toBe(false);
    expect(isMenuAction(7)).toBe(false);
  });
});

describe('contentForSplit', () => {
  it('copies a terminal directory but not its startup commands', () => {
    expect(contentForSplit({ type: 'terminal', directory: '/work', commands: ['make'] })).toEqual({
      type: 'terminal',
      directory: '/work',
      commands: [],
    });
  });

  it('opens a plain terminal beside any other pane', () => {
    expect(contentForSplit({ type: 'web', url: 'http://localhost:3000' })).toEqual({
      type: 'terminal',
      directory: null,
      commands: [],
    });
    expect(contentForSplit(null).type).toBe('terminal');
  });
});

describe('actionForMenu', () => {
  it('splits the focused pane in the asked direction', () => {
    const focused = activeTab(START)?.focusedId;
    expect(actionForMenu('split-right', START)).toEqual({
      type: 'split',
      paneId: focused,
      direction: 'row',
      content: { type: 'terminal', directory: '/work', commands: [] },
    });
    expect(actionForMenu('split-down', START)).toMatchObject({ direction: 'column' });
  });

  it('targets the focused pane for close and magnify', () => {
    const focused = activeTab(START)?.focusedId;
    expect(actionForMenu('close-pane', START)).toEqual({ type: 'close', paneId: focused });
    expect(actionForMenu('magnify-pane', START)).toEqual({
      type: 'toggle-magnify',
      paneId: focused,
    });
  });

  it('maps tab and focus movement', () => {
    expect(actionForMenu('new-tab', START)?.type).toBe('add-tab');
    expect(actionForMenu('close-tab', START)).toEqual({
      type: 'close-tab',
      tabId: START.activeTabId,
    });
    expect(actionForMenu('next-tab', START)).toEqual({ type: 'activate-next-tab', offset: 1 });
    expect(actionForMenu('previous-pane', START)).toEqual({ type: 'focus-next', offset: -1 });
  });

  it('does nothing pane-specific when no tab is active', () => {
    const lost = { ...START, activeTabId: 'gone' };
    expect(actionForMenu('close-pane', lost)).toBeNull();
    expect(actionForMenu('split-right', lost)).toBeNull();
  });
});
