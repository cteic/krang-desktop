const ELLIPSIS = '…';

function chunks(word: string, size: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < word.length; start += size) {
    parts.push(word.slice(start, start + size));
  }
  return parts;
}

/**
 * Breaks a title into at most `maxLines` lines of at most `maxChars`
 * characters. Lines break between words. A word longer than a line is cut.
 * When the text does not fit, the last line ends in an ellipsis.
 */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const width = Math.max(1, Math.floor(maxChars));
  const limit = Math.max(1, Math.floor(maxLines));
  const words = text
    .split(/\s+/)
    .filter((word) => word !== '')
    .flatMap((word) => chunks(word, width));

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const joined = current === '' ? word : `${current} ${word}`;
    if (joined.length <= width) {
      current = joined;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') {
    lines.push(current);
  }

  if (lines.length <= limit) {
    return lines;
  }
  const kept = lines.slice(0, limit);
  const last = kept[limit - 1] ?? '';
  const room = Math.max(0, width - 1);
  kept[limit - 1] = `${last.slice(0, room).trimEnd()}${ELLIPSIS}`;
  return kept;
}
