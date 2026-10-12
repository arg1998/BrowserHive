/** @module test/composition/process-handlers.test — second-signal policy (injected signal source), unhandled failures as degradations, exit 1 only on storage corruption. */

import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { AppError } from '@browserhive/core/runtime';
import {
  FORCED_EXIT_CODE,
  installProcessHandlers,
  isStorageCorruption,
  STOP_SIGNALS,
  stopSignalsFor,
  WINDOWS_STOP_SIGNALS,
} from '../../src/composition/index.ts';

function rig(platform: NodeJS.Platform = 'linux') {
  const target = new EventEmitter();
  const stops: number[] = [];
  const exits: number[] = [];
  const stderr: string[] = [];
  const unhandled: { kind: string; error: unknown }[] = [];
  const uninstall = installProcessHandlers({
    target,
    stop: (code) => stops.push(code),
    output: { stderr: (line) => stderr.push(line) },
    exit: (code) => exits.push(code),
    unhandled: (error, kind) => unhandled.push({ kind, error }),
    platform,
  });
  return { target, stops, exits, stderr, unhandled, uninstall };
}

describe('installProcessHandlers', () => {
  it('first SIGINT stops gracefully; a second signal forces exit 130 with a message', () => {
    const r = rig();
    r.target.emit('SIGINT');
    expect(r.stops).toEqual([0]);
    expect(r.exits).toEqual([]);
    expect(r.stderr[0]).toContain('received SIGINT, shutting down');
    r.target.emit('SIGTERM');
    expect(r.exits).toEqual([FORCED_EXIT_CODE]);
    expect(r.stderr[1]).toBe('browserhive: received SIGTERM again, forcing exit');
    expect(r.stops).toEqual([0]);
  });

  it('reports unhandled rejections and exceptions and keeps serving', () => {
    const r = rig();
    const boom = new Error('boom');
    r.target.emit('unhandledRejection', boom);
    r.target.emit('uncaughtException', new TypeError('bad'));
    expect(r.unhandled.map((u) => u.kind)).toEqual(['rejection', 'exception']);
    expect(r.stops).toEqual([]);
    expect(r.exits).toEqual([]);
  });

  it('stops with exit 1 on storage corruption', () => {
    const r = rig();
    const corrupt = new AppError('DB_CORRUPT', { path: '/x.db', quarantine_path: '/x.db.bad' });
    r.target.emit('uncaughtException', corrupt);
    expect(r.stops).toEqual([1]);
    expect(r.stderr.at(-1)).toContain('[DB_CORRUPT]');
  });

  it('uninstall removes every listener, once', () => {
    const r = rig();
    expect(r.target.listenerCount('SIGINT')).toBe(1);
    r.uninstall();
    r.uninstall();
    for (const event of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
      expect(r.target.listenerCount(event)).toBe(0);
    }
  });

  it('Windows: Ctrl+Break (SIGBREAK) and closing the console (SIGHUP) stop gracefully', () => {
    for (const signal of WINDOWS_STOP_SIGNALS) {
      const r = rig('win32');
      r.target.emit(signal);
      expect(r.stops).toEqual([0]);
      expect(r.exits).toEqual([]);
      expect(r.stderr[0]).toContain(`received ${signal}, shutting down`);
      r.target.emit('SIGINT');
      expect(r.exits).toEqual([FORCED_EXIT_CODE]);
      r.uninstall();
      expect(r.target.listenerCount(signal)).toBe(0);
    }
  });

  it('POSIX leaves SIGHUP and SIGBREAK alone', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const r = rig(platform);
      expect(r.target.listenerCount('SIGHUP')).toBe(0);
      expect(r.target.listenerCount('SIGBREAK')).toBe(0);
      r.target.emit('SIGHUP');
      expect(r.stops).toEqual([]);
      r.uninstall();
    }
  });

  it('stopSignalsFor: SIGINT and SIGTERM everywhere, the console events only on Windows', () => {
    expect(stopSignalsFor('linux')).toEqual([...STOP_SIGNALS]);
    expect(stopSignalsFor('darwin')).toEqual([...STOP_SIGNALS]);
    expect(stopSignalsFor('win32')).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
  });

  it('classifies corruption from raw SQLite errors', () => {
    expect(isStorageCorruption(new Error('database disk image is malformed'))).toBe(true);
    expect(isStorageCorruption(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toBe(
      true,
    );
    expect(isStorageCorruption(new Error('SQLITE_BUSY: database is locked'))).toBe(false);
    expect(isStorageCorruption('corrupt')).toBe(false);
  });
});
