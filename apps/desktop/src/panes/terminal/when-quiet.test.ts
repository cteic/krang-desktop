import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { whenQuiet } from './when-quiet';

describe('whenQuiet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once activity has paused for the quiet period', () => {
    const onQuiet = vi.fn();
    const watch = whenQuiet(onQuiet, 200, 5000);

    watch.touch();
    vi.advanceTimersByTime(199);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('restarts the quiet period on each burst', () => {
    const onQuiet = vi.fn();
    const watch = whenQuiet(onQuiet, 200, 5000);

    watch.touch();
    vi.advanceTimersByTime(150);
    watch.touch();
    vi.advanceTimersByTime(150);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('does not fire on silence alone before the limit', () => {
    const onQuiet = vi.fn();
    whenQuiet(onQuiet, 200, 5000);

    vi.advanceTimersByTime(4999);
    expect(onQuiet).not.toHaveBeenCalled();
  });

  it('fires at the limit when nothing ever arrives', () => {
    const onQuiet = vi.fn();
    whenQuiet(onQuiet, 200, 5000);

    vi.advanceTimersByTime(5000);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('fires at the limit when output never pauses', () => {
    const onQuiet = vi.fn();
    const watch = whenQuiet(onQuiet, 200, 1000);

    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      watch.touch();
      vi.advanceTimersByTime(100);
    }
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('fires only once', () => {
    const onQuiet = vi.fn();
    const watch = whenQuiet(onQuiet, 200, 1000);

    watch.touch();
    vi.advanceTimersByTime(200);
    watch.touch();
    vi.advanceTimersByTime(5000);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('never fires after cancel', () => {
    const onQuiet = vi.fn();
    const watch = whenQuiet(onQuiet, 200, 1000);

    watch.touch();
    watch.cancel();
    vi.advanceTimersByTime(5000);
    expect(onQuiet).not.toHaveBeenCalled();
  });
});
