// Tests for withStorageLock: the per-key serializer that keeps concurrent
// read-modify-write cycles on counter-style storage keys (usage, stats) from
// clobbering each other. Pure promise-chaining, so no chrome mock needed.

import { describe, it, expect } from 'vitest';
import { withStorageLock } from '../../src/shared/storage.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('withStorageLock', () => {
  it('serializes read-modify-write cycles that would otherwise interleave', async () => {
    // Simulated storage: both "handlers" read, await (yielding), then write.
    // Unserialized, both would read 0 and the final value would be 1.
    let stored = 0;
    const bump = async () => {
      const read = stored;
      await tick(); // interleave point
      stored = read + 1;
    };

    await Promise.all([
      withStorageLock('k', bump),
      withStorageLock('k', bump),
      withStorageLock('k', bump),
    ]);
    expect(stored).toBe(3);
  });

  it('different keys do not block each other', async () => {
    const order: string[] = [];
    let releaseA: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });

    const a = withStorageLock('a', async () => { await gateA; order.push('a'); });
    const b = withStorageLock('b', async () => { order.push('b'); });

    await b;
    expect(order).toEqual(['b']); // b finished while a still held its own lock
    releaseA!();
    await a;
    expect(order).toEqual(['b', 'a']);
  });

  it('a rejected holder does not wedge the lock', async () => {
    const boom = withStorageLock('k2', async () => { throw new Error('boom'); });
    await expect(boom).rejects.toThrow('boom');

    let ran = false;
    await withStorageLock('k2', async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('propagates the return value', async () => {
    const v = await withStorageLock('k3', async () => 42);
    expect(v).toBe(42);
  });
});
