import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIRROR_DELAY_MS, MirrorScheduler } from '../src/mirror/scheduler';

afterEach(() => vi.useRealTimers());

describe('MirrorScheduler', () => {
  it('runs once, MIRROR_DELAY_MS after the last change to a book', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const s = new MirrorScheduler(run);
    s.touch('b1');
    vi.advanceTimersByTime(1000);
    s.touch('b1');
    vi.advanceTimersByTime(MIRROR_DELAY_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('b1');
  });

  it('schedules books separately', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const s = new MirrorScheduler(run);
    s.touch('b1');
    s.touch('b2');
    await vi.advanceTimersByTimeAsync(MIRROR_DELAY_MS);
    expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(['b1', 'b2']);
  });

  it('flush runs a book now, pending or not; flushAll runs the pending ones only', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const s = new MirrorScheduler(run);
    s.touch('b1');
    s.touch('b2');
    await s.flush('b1');
    expect(run.mock.calls).toEqual([['b1']]);
    await s.flushAll();
    expect(run.mock.calls).toEqual([['b1'], ['b2']]);
    await s.flushAll();
    expect(run).toHaveBeenCalledTimes(2);
    await s.flush('b3');
    expect(run).toHaveBeenLastCalledWith('b3');
    await vi.advanceTimersByTimeAsync(MIRROR_DELAY_MS * 2);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('a failing run is reported and does not stop later runs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn(async () => {}).mockRejectedValueOnce(new Error('disk full'));
    const s = new MirrorScheduler(run, 0);
    await s.flush('b1');
    expect(error).toHaveBeenCalled();
    await s.flush('b1');
    expect(run).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('dispose cancels pending runs', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const s = new MirrorScheduler(run);
    s.touch('b1');
    s.dispose();
    await vi.advanceTimersByTimeAsync(MIRROR_DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });
});
