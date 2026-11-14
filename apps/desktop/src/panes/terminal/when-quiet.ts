export interface QuietWatch {
  /** Call on every sign of activity. */
  touch(): void;
  /** Stops the watch. The callback will not run after this. */
  cancel(): void;
}

/**
 * Runs `onQuiet` once, when activity has started and then paused for
 * `quietMs`, or after `maxMs` if that never happens.
 *
 * A shell prints its prompt in several bursts while its profile loads.
 * Typing startup commands only after the output settles keeps them from
 * being echoed into the middle of that.
 */
export function whenQuiet(onQuiet: () => void, quietMs: number, maxMs: number): QuietWatch {
  let done = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  function finish() {
    if (done) {
      return;
    }
    done = true;
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
    }
    clearTimeout(maxTimer);
    onQuiet();
  }

  const maxTimer = setTimeout(finish, maxMs);

  return {
    touch() {
      if (done) {
        return;
      }
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(finish, quietMs);
    },
    cancel() {
      done = true;
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
      }
      clearTimeout(maxTimer);
    },
  };
}
