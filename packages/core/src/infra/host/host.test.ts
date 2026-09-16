/** @module infra/host/host.test — memory helpers (the host record is built by the composition root, `browserhive/src/composition/host.ts`). */

import { describe, expect, it } from 'bun:test';
import { estimateSessionCapacity, readHostMemory, readProcessMemory } from './memory.ts';

describe('memory', () => {
  it('reads host and process memory', () => {
    const host = readHostMemory();
    expect(host.totalBytes).toBeGreaterThan(host.freeBytes);
    const proc = readProcessMemory();
    expect(proc.rssBytes).toBeGreaterThan(0);
    expect(proc.heapUsedBytes).toBeGreaterThan(0);
  });

  it('estimates session capacity', () => {
    expect(estimateSessionCapacity(8 * 1024 ** 3)).toBe(17);
    expect(estimateSessionCapacity(512 * 1024 ** 2)).toBe(0);
    expect(
      estimateSessionCapacity(3 * 1024 ** 3, { perSessionBytes: 1024 ** 3, reserveBytes: 0 }),
    ).toBe(3);
  });
});
