export interface BufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface TextBuffer {
  length: number;
  getLine(index: number): BufferLine | undefined;
}

/** Reads a terminal buffer as plain text, one line per row, blank tail removed. */
export function bufferText(buffer: TextBuffer): string {
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}
