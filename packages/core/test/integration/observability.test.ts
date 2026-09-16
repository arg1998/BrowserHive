/** @module test/integration/observability — tool calls project into SQLite rows (sessions, tool_calls, pages, screenshots) with trace ids, screenshots archived by event id, trace.zip finalized. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Recorder } from '../../src/app/observability/recorder.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import {
  type DatabaseHandle,
  openDatabase,
  SqliteUnitOfWork,
  SqliteWriteQueue,
} from '../../src/infra/persistence/index.ts';
import { createRedactor } from '../../src/kernel/redact.ts';
import type { ToolHarness } from '../helpers/fake-transport.ts';
import { type FixtureServer, startFixtureServer } from '../helpers/fixture-server.ts';
import { createRealHarness } from './mcp-fixture.ts';

describe('observability end-to-end (real Chromium + SQLite)', () => {
  let h: ToolHarness;
  let fixture: FixtureServer;
  let db: DatabaseHandle;
  let uow: SqliteUnitOfWork;
  let queue: SqliteWriteQueue;
  let recorder: Recorder;

  beforeEach(async () => {
    fixture = startFixtureServer();
    h = await createRealHarness({ trace: true });
    const logger = createCollectingLogger();
    db = await openDatabase({
      path: join(h.dataDir, 'browserhive.db'),
      dataDir: h.dataDir,
      appVersion: '0.1.0',
      clock: createSystemClock(),
      logger,
    });
    uow = new SqliteUnitOfWork(db.db);
    queue = new SqliteWriteQueue({ uow, logger });
    recorder = new Recorder({
      bus: h.bus,
      queue,
      logger,
      redactor: createRedactor(h.secrets),
      config: { recordToolResults: 'full', urlQueryAllowlist: [] },
    });
    recorder.start();
  });

  afterEach(async () => {
    await h.close();
    recorder.stop();
    await queue.close();
    await db.close();
    fixture.stop();
  });

  it('projects a full session lifecycle into the database', async () => {
    const id = await h.launch({ slug: 'obs' });
    await h.callJson('navigate', { session_id: id, url: fixture.url('/?token=secret#frag') });
    const shot = await h.call('screenshot', { session_id: id });
    expect(shot.isError).toBeUndefined();
    await queue.drain();

    const session = await uow.repos.sessions.get(id);
    expect(session?.slug).toBe('obs');
    expect(session?.closedAt).toBeNull();

    const calls = await uow.repos.toolCalls.listBySession(id, {});
    expect(calls.items.map((c) => c.tool)).toEqual(
      expect.arrayContaining(['launch_session', 'navigate', 'screenshot']),
    );
    const navigate = calls.items.find((c) => c.tool === 'navigate');
    expect(navigate?.ok).toBe(true);
    expect(navigate?.seq).toBeGreaterThan(0);

    const pages = await uow.repos.pages.list({ sessionId: id });
    expect(pages.items).toHaveLength(1);
    expect(pages.items[0]?.url).not.toContain('secret');

    const screenshots = await uow.repos.screenshots.listBySession(id, {});
    expect(screenshots.items).toHaveLength(1);
    const archived = screenshots.items[0];
    expect(archived?.eventId).toBe(calls.items.find((c) => c.tool === 'screenshot')?.eventId ?? '');
    expect((await stat(archived?.path ?? '')).size).toBeGreaterThan(100);

    await h.callJson('close_session', { session_id: id });
    await queue.drain();
    expect((await uow.repos.sessions.get(id))?.closedReason).toBe('user');
    expect((await stat(join(h.dataDir, 'sessions', id, 'trace.zip'))).size).toBeGreaterThan(0);
  });

  it('validation failures are recorded rows too (no session)', async () => {
    await h.call('navigate', { session_id: 'ghost-12345678' });
    await queue.drain();
    const all = await uow.repos.toolCalls.listAll({ errorCodes: ['INVALID_ARGUMENTS'] });
    expect(all.items).toHaveLength(1);
    expect(all.items[0]?.sessionId).toBeNull();
  });
});
