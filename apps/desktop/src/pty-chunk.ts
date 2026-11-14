/**
 * Turns one message from the Rust output channel into bytes.
 *
 * Rust sends raw bytes, which arrive as an ArrayBuffer. A webview that cannot
 * take the raw path falls back to JSON, where the same bytes arrive as an
 * array of numbers. Anything else is not terminal output and yields nothing.
 */
export function toBytes(message: unknown): Uint8Array {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (message instanceof Uint8Array) {
    return message;
  }
  if (Array.isArray(message) && message.every(isByte)) {
    return Uint8Array.from(message);
  }
  return new Uint8Array(0);
}

function isByte(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}
