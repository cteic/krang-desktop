import { describe, expect, it } from 'vitest';

import { keyAction } from './keys';
import type { KeyPress } from './keys';

function press(key: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers };
}

describe('keyAction', () => {
  it('moves the selection with the arrow keys, wherever focus is', () => {
    expect(keyAction(press('ArrowDown'), 'list')).toBe('next');
    expect(keyAction(press('ArrowUp'), 'list')).toBe('previous');
    expect(keyAction(press('ArrowDown'), 'filter')).toBe('next');
    expect(keyAction(press('ArrowUp'), 'button')).toBe('previous');
  });

  it('jumps to the ends with Home and End in the list', () => {
    expect(keyAction(press('Home'), 'list')).toBe('first');
    expect(keyAction(press('End'), 'list')).toBe('last');
  });

  it('opens with Enter from the list and from the filter', () => {
    expect(keyAction(press('Enter'), 'list')).toBe('open');
    expect(keyAction(press('Enter'), 'filter')).toBe('open');
  });

  it('leaves Enter to a focused button', () => {
    expect(keyAction(press('Enter'), 'button')).toBeNull();
    expect(keyAction(press('Enter', { metaKey: true }), 'button')).toBeNull();
  });

  it('opens the web pane with Cmd+Enter', () => {
    expect(keyAction(press('Enter', { metaKey: true }), 'list')).toBe('open-web');
  });

  it('goes to the parent with Backspace or Cmd+Up', () => {
    expect(keyAction(press('Backspace'), 'list')).toBe('parent');
    expect(keyAction(press('ArrowUp', { metaKey: true }), 'list')).toBe('parent');
    expect(keyAction(press('ArrowUp', { metaKey: true }), 'filter')).toBe('parent');
  });

  it('focuses the filter with a slash and clears it with Escape', () => {
    expect(keyAction(press('/'), 'list')).toBe('focus-filter');
    expect(keyAction(press('Escape'), 'list')).toBe('clear-filter');
    expect(keyAction(press('Escape'), 'filter')).toBe('clear-filter');
  });

  it('lets the filter box keep its editing keys', () => {
    expect(keyAction(press('Backspace'), 'filter')).toBeNull();
    expect(keyAction(press('/'), 'filter')).toBeNull();
    expect(keyAction(press('Home'), 'filter')).toBeNull();
    expect(keyAction(press('End'), 'filter')).toBeNull();
  });

  it('ignores keys held with Control or Option', () => {
    expect(keyAction(press('ArrowDown', { ctrlKey: true }), 'list')).toBeNull();
    expect(keyAction(press('Backspace', { altKey: true }), 'list')).toBeNull();
  });

  it('ignores keys it has no use for', () => {
    expect(keyAction(press('a'), 'list')).toBeNull();
    expect(keyAction(press('a', { metaKey: true }), 'list')).toBeNull();
    expect(keyAction(press('Tab'), 'list')).toBeNull();
  });
});
