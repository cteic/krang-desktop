export type KeyAction =
  'left' | 'right' | 'up' | 'down' | 'next' | 'previous' | 'open' | 'clear' | 'fit';

export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a key press means on the graph drawing. Null leaves the key alone. */
export function keyAction(press: KeyPress): KeyAction | null {
  if (press.metaKey || press.ctrlKey || press.altKey) {
    return null;
  }
  switch (press.key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Tab':
      return press.shiftKey ? 'previous' : 'next';
    case 'Enter':
      return 'open';
    case 'Escape':
      return 'clear';
    case 'f':
    case 'F':
      return 'fit';
    default:
      return null;
  }
}
