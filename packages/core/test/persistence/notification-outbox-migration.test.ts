/** @module test/persistence/notification-outbox-migration.test — schema v5 (`0005-notification-outbox`) over a v4 database: the backfill from facts only, rows an older reader writes, the CHECKs, the delivery idempotency key, the cascades, and `purge` inventorying an older database (03 §7, §9; D-32, D-34). */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteMaintenanceService } from '../../src/infra/persistence/maintenance.ts';
import { SCHEMA_VERSION } from '../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../src/infra/persistence/unit-of-work.ts';
import { FakeClock, FakeLogger, tempDir } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** Copies a fixture, lets `prepare` write to it at its own version, then opens it (migrating). */
async function openCopy(fixture: string, prepare?: (raw: Database) => void) {
  const dir = tempDir();
  const path = join(dir.path, 'browserhive.db');
  copyFileSync(join(FIXTURES, fixture), path);
  if (prepare !== undefined) {
    const raw = new Database(path);
    try {
      prepare(raw);
    } finally {
      raw.close();
    }
  }
  const handle = await openDatabase({
    path,
    dataDir: dir.path,
    appVersion: 'test',
    clock: new FakeClock(),
    logger: new FakeLogger(),
  });
  return { dir, path, handle, uow: new SqliteUnitOfWork(handle.db) };
}

type Row = Record<string, unknown>;

/** Inserts a v4-shaped notification row. */
function legacy(raw: Database, row: Row): void {
  const full: Row = {
    principal_id: null,
    body: null,
    session_id: null,
    target: null,
    source_event_id: null,
    created_at: 1,
    updated_at: 1,
    count: 1,
    group_key: null,
    read_at: null,
    dismissed_at: null,
    ...row,
  };
  const cols = Object.keys(full);
  raw
    .query(
      `INSERT INTO notifications (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
    .run(...(Object.values(full) as (string | number | null)[]));
}

describe('migration 0005-notification-outbox', () => {
  it('backfills every existing notification from facts only and leaves message_json NULL', async () => {
    const { dir, handle } = await openCopy('v4.db', (raw) => {
      // v4 rows of every producer, and requests/degradations in every state.
      raw.exec(
        "INSERT INTO operator_requests (request_id, kind, session_id, owner, reason, status, created_at) VALUES ('a-resolved0001','attention','shop-a1b2c3d4','local','x','resolved',1), ('a-timeout00001','attention','shop-a1b2c3d4','local','x','timeout',1), ('a-cancelled001','vault_confirm','shop-a1b2c3d4','local','x','cancelled',1)",
      );
      raw.exec(
        "INSERT INTO system_events (event_id, code, severity, message, first_seen_at, last_seen_at, resolved_at) VALUES ('e-sys-open', 'X', 'error', 'm', 1, 1, NULL), ('e-sys-done', 'Y', 'error', 'm', 1, 1, 5)",
      );
      legacy(raw, {
        notification_id: 'n-att-resolved',
        type: 'attention',
        title: 'Attention requested',
        source_event_id: 'a-resolved0001',
      });
      legacy(raw, {
        notification_id: 'n-att-timeout0',
        type: 'attention',
        title: 'Attention requested',
        source_event_id: 'a-timeout00001',
      });
      legacy(raw, {
        notification_id: 'n-att-orphan00',
        type: 'attention',
        title: 'Attention requested',
        source_event_id: 'a-gone00000001',
      });
      legacy(raw, {
        notification_id: 'n-vault-cancel',
        type: 'vault',
        title: 'Vault fill awaiting confirm',
        source_event_id: 'a-cancelled001',
      });
      legacy(raw, {
        notification_id: 'n-crash0000001',
        type: 'error',
        title: 'Session crashed',
        session_id: 'shop-a1b2c3d4',
      });
      legacy(raw, {
        notification_id: 'n-toolerr00001',
        type: 'error',
        title: 'shop · 3 tool errors',
        group_key: 'tool-errors:shop-a1b2c3d4',
      });
      legacy(raw, {
        notification_id: 'n-toolerrv1001',
        type: 'error',
        title: 'shop · 1 tool error',
        session_id: 'shop-a1b2c3d4',
      });
      legacy(raw, {
        notification_id: 'n-reaped000001',
        type: 'lifecycle',
        title: 'Session reaped (lease expired)',
        session_id: 'shop-a1b2c3d4',
      });
      legacy(raw, {
        notification_id: 'n-sys-open0001',
        type: 'system',
        title: 'm',
        source_event_id: 'e-sys-open',
      });
      legacy(raw, {
        notification_id: 'n-sys-done0001',
        type: 'system',
        title: 'm',
        source_event_id: 'e-sys-done',
      });
    });
    try {
      expect(handle.schemaVersion).toBe(SCHEMA_VERSION);
      const rows = handle.raw
        .query<Row, []>(
          'SELECT notification_id, kind, category, severity, state, revision, thread, message_json FROM notifications ORDER BY notification_id',
        )
        .all();
      const byId = Object.fromEntries(rows.map((r) => [r['notification_id'], r]));
      const expectRow = (id: string, want: Row) =>
        expect(byId[id]).toMatchObject({ revision: 1, message_json: null, ...want });
      // The fixture's own row: a pending request.
      expectRow('n-1', {
        kind: 'attention.requested',
        category: 'needs-you',
        severity: 'warn',
        state: 'open',
        thread: 'attention:a-fixture00001',
      });
      expectRow('n-att-resolved', { state: 'resolved', thread: 'attention:a-resolved0001' });
      expectRow('n-att-timeout0', { state: 'expired' });
      expectRow('n-att-orphan00', { state: 'final' });
      expectRow('n-vault-cancel', {
        kind: 'vault.confirm',
        category: 'needs-you',
        state: 'final',
        thread: 'vault:a-cancelled001',
      });
      expectRow('n-crash0000001', {
        kind: 'session.crashed',
        category: 'problems',
        severity: 'error',
        state: 'final',
        thread: 'session:shop-a1b2c3d4',
      });
      expectRow('n-toolerr00001', {
        kind: 'tool.errors',
        category: 'problems',
        severity: 'warn',
        state: 'open',
        thread: 'tool-errors:shop-a1b2c3d4',
      });
      expectRow('n-toolerrv1001', { kind: 'tool.errors', thread: 'tool-errors:shop-a1b2c3d4' });
      expectRow('n-reaped000001', {
        kind: 'session.reaped',
        category: 'problems',
        severity: 'warn',
        state: 'final',
      });
      expectRow('n-sys-open0001', {
        kind: 'system.degraded',
        category: 'system',
        severity: 'error',
        state: 'open',
        thread: 'system:e-sys-open',
      });
      expectRow('n-sys-done0001', { state: 'resolved' });
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('reads rows an older reader inserted (NULL classification) as derived from type', async () => {
    const { dir, handle, uow } = await openCopy('v4.db');
    try {
      legacy(handle.raw, {
        notification_id: 'n-oldreader001',
        type: 'error',
        title: 'Session crashed',
        session_id: 'shop-a1b2c3d4',
      });
      const row = await uow.repos.notifications.get('n-oldreader001');
      expect(row).toMatchObject({
        kind: 'session.crashed',
        category: 'problems',
        severity: 'error',
        state: 'final',
        revision: 1,
        thread: 'session:shop-a1b2c3d4',
        messageJson: null,
      });
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('checks the enums, keeps delivery jobs idempotent and cascades', async () => {
    const { dir, handle, uow } = await openCopy('v5.db');
    try {
      const raw = handle.raw;
      expect(() =>
        raw.exec("UPDATE notifications SET severity = 'loud' WHERE notification_id = 'n-1'"),
      ).toThrow();
      expect(() =>
        raw.exec("UPDATE notifications SET state = 'done' WHERE notification_id = 'n-1'"),
      ).toThrow();
      expect(() => raw.exec("UPDATE notification_channels SET status = 'off'")).toThrow();
      expect(() => raw.exec("UPDATE notification_deliveries SET op = 'post'")).toThrow();
      const job = {
        channelId: 'nc-fixture00001',
        notificationId: 'n-fixture00002',
        revision: 1,
        op: 'send' as const,
        status: 'pending' as const,
        reason: null,
        nextAttemptAt: 1,
        createdAt: 1,
      };
      expect(await uow.repos.notificationDeliveries.enqueue([job])).toBe(0);
      expect(
        await uow.repos.notificationDeliveries.enqueue([{ ...job, revision: 2, op: 'edit' }]),
      ).toBe(1);
      raw.exec("DELETE FROM notifications WHERE notification_id = 'n-fixture00002'");
      expect(raw.query('SELECT COUNT(*) AS n FROM notification_deliveries').get()).toEqual({
        n: 0,
      });
      expect(raw.query('SELECT COUNT(*) AS n FROM notification_channel_messages').get()).toEqual({
        n: 0,
      });
      expect(await uow.repos.notificationChannels.remove('nc-fixture00001')).toBe(true);
    } finally {
      await handle.close();
      dir.dispose();
    }
  });

  it('purge inventories a database from before v5 without failing on the new tables', async () => {
    const dir = tempDir();
    try {
      const path = join(dir.path, 'browserhive.db');
      copyFileSync(join(FIXTURES, 'v4.db'), path);
      const handle = await openDatabase({
        path,
        dataDir: dir.path,
        appVersion: 'test',
        clock: new FakeClock(),
        logger: new FakeLogger(),
        readOnly: true,
      });
      try {
        const maintenance = new SqliteMaintenanceService({
          handle,
          clock: new FakeClock(),
          logger: new FakeLogger(),
          appVersion: 'test',
        });
        const inventory = await maintenance.inventory();
        const tables = inventory.tables.map((t) => t.table);
        expect(tables).toContain('notifications');
        expect(tables).not.toContain('notification_channels');
      } finally {
        await handle.close();
      }
    } finally {
      dir.dispose();
    }
  });
});
