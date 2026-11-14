const ELLIPSIS = '…';

/**
 * Shortens `text` to at most `max` characters by cutting from the middle.
 * The tail gets the spare character, because a path's file name is at its end.
 */
export function truncateMiddle(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) {
    return text;
  }
  if (max <= 1) {
    return ELLIPSIS;
  }
  const kept = max - 1;
  const tail = Math.ceil(kept / 2);
  const head = kept - tail;
  return (
    characters.slice(0, head).join('') +
    ELLIPSIS +
    characters.slice(characters.length - tail).join('')
  );
}
