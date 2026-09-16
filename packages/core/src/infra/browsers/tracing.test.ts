/** @module infra/browsers/tracing.test — tracing handle state machine over a fake Tracing object and chunk merging. */

import { describe, expect, it } from 'bun:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import {
  mergeTraceParts,
  PlaywrightTracingHandle,
  type TracingFs,
  type TracingLike,
} from './tracing.ts';

/** A fake Playwright `Tracing` that records the call sequence and "writes" a tiny zip per path. */
function fakeTracing(files: Map<string, Uint8Array>, options: { failStop?: boolean } = {}) {
  const calls: string[] = [];
  let chunk = 0;
  const zipFor = (): Uint8Array =>
    zipSync({
      'trace.trace': new TextEncoder().encode(`chunk-${chunk++}`),
      'trace.network': new TextEncoder().encode('net'),
      'resources/abc.png': new Uint8Array([1, 2, 3]),
    });
  const tracing: TracingLike = {
    start: async (o) => {
      calls.push(`start:${o.screenshots}:${o.snapshots}:${o.sources}`);
    },
    stop: async (o) => {
      calls.push(`stop:${o?.path ?? '-'}`);
      if (options.failStop === true) throw new Error('flush hung');
      if (o?.path !== undefined) files.set(o.path, zipFor());
    },
  };
  return { tracing, calls };
}

function memoryFs(files: Map<string, Uint8Array>): TracingFs {
  return {
    mkdir: async () => undefined,
    readFile: async (path) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`missing ${path}`);
      return data;
    },
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    rm: async () => undefined,
  };
}

function handleWith(files: Map<string, Uint8Array>, options: { failStop?: boolean } = {}) {
  const { tracing, calls } = fakeTracing(files, options);
  const handle = new PlaywrightTracingHandle({
    tracing,
    partsDir: '/parts',
    screenshots: true,
    snapshots: true,
    logger: createCollectingLogger(),
    fs: memoryFs(files),
    finalizeTimeoutMs: 200,
  });
  return { handle, calls };
}

describe('PlaywrightTracingHandle state machine', () => {
  it('start → stop(path) with no pause is a plain stop into the path', async () => {
    const files = new Map<string, Uint8Array>();
    const { handle, calls } = handleWith(files);
    expect(handle.status).toBe('idle');
    await handle.start();
    expect(handle.status).toBe('recording');
    await handle.stop('/out/trace.zip');
    await handle.stop('/out/trace.zip'); // idempotent
    expect(handle.status).toBe('stopped');
    expect(calls).toEqual(['start:true:true:false', 'stop:/out/trace.zip']);
    expect(files.has('/out/trace.zip')).toBe(true);
  });

  it('pause/resume around a fill fully stops and restarts tracing (never stopChunk), merging parts at stop (D-13)', async () => {
    const files = new Map<string, Uint8Array>();
    const { handle, calls } = handleWith(files);
    await handle.start();
    await handle.pauseChunk();
    expect(handle.status).toBe('paused');
    await handle.pauseChunk(); // no-op while paused
    await handle.resumeChunk();
    expect(handle.status).toBe('recording');
    await handle.resumeChunk(); // no-op while recording
    await handle.stop('/out/trace.zip');
    // A full stop/start, with the original options replayed: `stopChunk` would keep the network
    // tracer running across the pause and capture the login POST body (verified on Playwright 1.63).
    expect(calls).toEqual([
      'start:true:true:false',
      'stop:/parts/part-0.zip',
      'start:true:true:false',
      'stop:/parts/part-1.zip',
    ]);
    const merged = unzipSync(files.get('/out/trace.zip') ?? new Uint8Array());
    expect(Object.keys(merged).sort()).toEqual([
      'resources/abc.png',
      'trace-1.network',
      'trace-1.trace',
      'trace.network',
      'trace.trace',
    ]);
    expect(strFromU8(merged['trace.trace'] ?? new Uint8Array())).toBe('chunk-0');
    expect(strFromU8(merged['trace-1.trace'] ?? new Uint8Array())).toBe('chunk-1');
  });

  it('stopping while paused merges only the written parts', async () => {
    const files = new Map<string, Uint8Array>();
    const { handle, calls } = handleWith(files);
    await handle.start();
    await handle.pauseChunk();
    await handle.stop('/out/trace.zip');
    // Already stopped by the pause: no second stop is issued.
    expect(calls).toEqual(['start:true:true:false', 'stop:/parts/part-0.zip']);
    expect(Object.keys(unzipSync(files.get('/out/trace.zip') ?? new Uint8Array()))).toContain(
      'trace.trace',
    );
  });

  it('pause/resume/stop before start are no-ops', async () => {
    const { handle, calls } = handleWith(new Map());
    await handle.pauseChunk();
    await handle.resumeChunk();
    await handle.stop('/out/x.zip');
    expect(calls).toEqual([]);
    expect(handle.status).toBe('idle');
  });

  it('surfaces a failing stop as a rejection the caller turns into TRACE_FINALIZE_FAILED', async () => {
    const { handle } = handleWith(new Map(), { failStop: true });
    await handle.start();
    await expect(handle.stop('/out/trace.zip')).rejects.toThrow('flush hung');
    expect(handle.status).toBe('stopped');
  });

  it('abandon() discards an active trace without a file and reports failures as a warning', async () => {
    const ok = handleWith(new Map());
    await ok.handle.start();
    expect(await ok.handle.abandon()).toBeNull();
    expect(ok.calls).toContain('stop:-');
    const bad = handleWith(new Map(), { failStop: true });
    await bad.handle.start();
    expect((await bad.handle.abandon())?.code).toBe('TRACE_FINALIZE_FAILED');
  });
});

describe('mergeTraceParts', () => {
  it('keeps the first chunk names and suffixes later chunks by ordinal', async () => {
    const files = new Map<string, Uint8Array>();
    files.set(
      '/a.zip',
      zipSync({ 'trace.trace': new Uint8Array([1]), 'trace.stacks': new Uint8Array([2]) }),
    );
    files.set(
      '/b.zip',
      zipSync({ 'trace.trace': new Uint8Array([3]), 'resources/x': new Uint8Array([4]) }),
    );
    const merged = unzipSync(await mergeTraceParts(['/a.zip', '/b.zip'], memoryFs(files)));
    expect(Object.keys(merged).sort()).toEqual([
      'resources/x',
      'trace-1.trace',
      'trace.stacks',
      'trace.trace',
    ]);
  });
});
