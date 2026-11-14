export type KeyAction =
  | 'next'
  | 'previous'
  | 'first'
  | 'last'
  | 'open'
  | 'open-web'
  | 'parent'
  | 'focus-filter'
  | 'clear-filter';

/** Where the key was pressed: the list, the filter box, or one of the buttons. */
export type KeySource = 'list' | 'filter' | 'button';

export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

function withCommand(key: string, source: KeySource): KeyAction | null {
  if (key === 'ArrowUp') {
    return 'parent';
  }
  if (key === 'Enter' && source !== 'button') {
    return 'open-web';
  }
  return null;
}

function plain(key: string, source: KeySource): KeyAction | null {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Escape':
      return 'clear-filter';
    case 'Enter':
      // On a button, Enter presses the button.
      return source === 'button' ? null : 'open';
    case 'Home':
      return source === 'filter' ? null : 'first';
    case 'End':
      return source === 'filter' ? null : 'last';
    case 'Backspace':
      return source === 'filter' ? null : 'parent';
    case '/':
      return source === 'filter' ? null : 'focus-filter';
    default:
      return null;
  }
}

/** What a key press means in the files pane. Null leaves the key alone. */
export function keyAction(press: KeyPress, source: KeySource): KeyAction | null {
  if (press.ctrlKey || press.altKey) {
    return null;
  }
  return press.metaKey ? withCommand(press.key, source) : plain(press.key, source);
}
