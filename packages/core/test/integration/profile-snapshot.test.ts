/** @module test/integration/profile-snapshot — saving and restoring a ~200 MB full profile keeps the event loop responsive and memory flat (issue #58). No browser: the cost under test is the zip itself. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStateStore } from '../../src/app/auth-states/store.ts';
import { LOCAL_PRINCIPAL } from '../../src/domain/auth/principal.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { createCollectingLogger } from '../helpers/test-logger.ts';

/** 25 × 8 MiB of incompressible bytes: deflate cannot shrink it, so every byte costs CPU. */
const FILE_COUNT = 25;
const FILE_BYTES = 8 * 1024 * 1024;
/** The longest a concurrent timer or request may wait (issue #58 acceptance). */
const MAX_STALL_MS = 250;
/** Peak RSS growth allowed while the profile is processed: a few slices, never the profile. */
const MAX_RSS_GROWTH_BYTES = 64 * 1024 * 1024;

/** Watches the event loop while `work` runs: the longest timer gap, request latency and RSS peak. */
async function observe(work: () => Promise<unknown>): Promise<{
  stallMs: number;
  requestMs: number;
  requests: number;
  rssGrowth: number;
}> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  let stallMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  let done = false;
  let requestMs = 0;
  let requests = 0;
  const health = (async () => {
    while (!done) {
      const started = performance.now();
      await (await fetch(`http://127.0.0.1:${server.port}/health`)).text();
      requestMs = Math.max(requestMs, performance.now() - started);
      requests += 1;
      await Bun.sleep(20);
    }
  })();
  try {
    await work();
    // A timer tick after the work, so a stall at its very end is measured too (a microtask
    // continuation would read the result before the delayed timer had a chance to fire).
    await Bun.sleep(50);
  } finally {
    done = true;
    await health;
    clearInterval(timer);
    server.stop(true);
  }
  return { stallMs, requestMs, requests, rssGrowth: peak - rss0 };
}

describe('full-profile snapshot of a ~200 MB profile', () => {
  let dir: string;
  let userdata: string;
  let store: AuthStateStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bh-big-profile-'));
    userdata = join(dir, 'userdata');
    const data = join(userdata, 'Default', 'IndexedDB', 'https_a.test_0.indexeddb.leveldb');
    await mkdir(data, { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) {
      await writeFile(join(data, `${String(i).padStart(6, '0')}.ldb`), randomBytes(FILE_BYTES));
    }
    await writeFile(join(userdata, 'Default', 'Cookies'), 'sid=logged-in');
    store = new AuthStateStore({
      dataDir: join(dir, 'data'),
      clock: new FakeClock(),
      logger: createCollectingLogger(),
    });
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('saves without stalling the event loop or holding the profile in memory', async () => {
    let size = 0;
    const seen = await observe(async () => {
      ({ size } = await store.saveFullProfile(userdata, 'big', 'prof-00000001', LOCAL_PRINCIPAL));
    });
    expect(size).toBeGreaterThan(FILE_COUNT * FILE_BYTES);
    expect(seen.requests).toBeGreaterThan(10);
    expect(seen.stallMs).toBeLessThan(MAX_STALL_MS);
    expect(seen.requestMs).toBeLessThan(MAX_STALL_MS);
    expect(seen.rssGrowth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  }, 120_000);

  it('restores without stalling the event loop or holding the archive in memory', async () => {
    const dest = join(dir, 'restored');
    const seen = await observe(() => store.restoreProfile('big', dest, LOCAL_PRINCIPAL));
    expect(seen.requests).toBeGreaterThan(2);
    expect(seen.stallMs).toBeLessThan(MAX_STALL_MS);
    expect(seen.requestMs).toBeLessThan(MAX_STALL_MS);
    expect(seen.rssGrowth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
    const data = join('Default', 'IndexedDB', 'https_a.test_0.indexeddb.leveldb');
    expect((await readdir(join(dest, data))).length).toBe(FILE_COUNT);
    const name = `${String(FILE_COUNT - 1).padStart(6, '0')}.ldb`;
    expect(
      Buffer.compare(
        await readFile(join(dest, data, name)),
        await readFile(join(userdata, data, name)),
      ),
    ).toBe(0);
    expect(await readFile(join(dest, 'Default', 'Cookies'), 'utf8')).toBe('sid=logged-in');
  }, 120_000);
});
