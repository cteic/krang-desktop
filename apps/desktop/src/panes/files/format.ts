const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'];
const STEP = 1024;

/** A compact size with no space, such as `512B`, `1.5K` or `12M`. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  // Rounding can reach the next unit: 1023.6K reads better as 1.0M.
  if (Math.round(value) >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  const label = UNITS[unit] ?? '';
  if (unit === 0) {
    return `${String(Math.round(value))}${label}`;
  }
  const text = value < 9.95 ? value.toFixed(1) : String(Math.round(value));
  return `${text}${label}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A short local date and time, `2026-01-05 09:07`. Blank for zero, which is
 * what the Rust side sends when the system cannot say.
 */
export function formatModified(modifiedMs: number): string {
  if (!Number.isFinite(modifiedMs) || modifiedMs <= 0) {
    return '';
  }
  const date = new Date(modifiedMs);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
