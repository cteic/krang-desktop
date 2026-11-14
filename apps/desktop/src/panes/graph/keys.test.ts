import { describe, expect, it } from 'vitest';

import { keyAction } from './keys';
import type { KeyPress } from './keys';

function press(key: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

describe('keyAction', () => {
  it('moves the selection with the arrow keys', () => {
    expect(keyAction(press('ArrowLeft'))).toBe('left');
    expect(keyAction(press('ArrowRight'))).toBe('right');
    expect(keyAction(press('ArrowUp'))).toBe('up');
    expect(keyAction(press('ArrowDown'))).toBe('down');
  });

  it('steps through the nodes with Tab, and back with Shift', () => {
    expect(keyAction(press('Tab'))).toBe('next');
    expect(keyAction(press('Tab', { shiftKey: true }))).toBe('previous');
  });

  it('opens with Enter, clears with Escape and fits with F', () => {
    expect(keyAction(press('Enter'))).toBe('open');
    expect(keyAction(press('Escape'))).toBe('clear');
    expect(keyAction(press('f'))).toBe('fit');
    expect(keyAction(press('F', { shiftKey: true }))).toBe('fit');
  });

  it('leaves shortcuts and other keys alone', () => {
    expect(keyAction(press('ArrowLeft', { metaKey: true }))).toBeNull();
    expect(keyAction(press('f', { ctrlKey: true }))).toBeNull();
    expect(keyAction(press('Enter', { altKey: true }))).toBeNull();
    expect(keyAction(press('a'))).toBeNull();
  });
});
