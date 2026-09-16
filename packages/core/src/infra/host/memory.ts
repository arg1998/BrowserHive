/** @module infra/host/memory — host and process memory readings for `/system`, `doctor` and the process gauges (spec 10 §7). */

import { freemem, totalmem } from 'node:os';

/** Host-level memory snapshot. */
export interface HostMemory {
  readonly totalBytes: number;
  readonly freeBytes: number;
}

/** Process-level memory snapshot. */
export interface ProcessMemory {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly externalBytes: number;
}

/** Reads host memory via `node:os`. */
export function readHostMemory(): HostMemory {
  return { totalBytes: totalmem(), freeBytes: freemem() };
}

/** Reads this process's memory via `process.memoryUsage()`. */
export function readProcessMemory(): ProcessMemory {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
  };
}

/**
 * Rule-of-thumb for the `doctor` sanity check: sessions the host can plausibly hold at
 * `perSessionBytes` each (default 400 MiB, a headless Chromium with a couple of tabs) while
 * leaving `reserveBytes` (default 1 GiB) for the OS and the server itself.
 */
export function estimateSessionCapacity(
  totalBytes: number,
  options: { readonly perSessionBytes?: number; readonly reserveBytes?: number } = {},
): number {
  const perSession = options.perSessionBytes ?? 400 * 1024 ** 2;
  const reserve = options.reserveBytes ?? 1024 ** 3;
  return Math.max(0, Math.floor((totalBytes - reserve) / perSession));
}
