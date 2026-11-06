import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../../src/lib/concurrency.js';

describe('mapWithConcurrency', () => {
  it('keeps input order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, n));
      inFlight--;
      return n * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it('handles an empty list and rejects on the first failure', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    await expect(
      mapWithConcurrency([1, 2], 4, async (n) => {
        if (n === 2) throw new Error('nope');
        return n;
      }),
    ).rejects.toThrow('nope');
  });
});
