/** @module test/persistence/fixtures/generate-fixture — writes `v<N>.db`, a populated database at the current schema version. */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../../../src/infra/persistence/migrations/index.ts';
import { openDatabase } from '../../../src/infra/persistence/open.ts';
import { SqliteUnitOfWork } from '../../../src/infra/persistence/unit-of-work.ts';
import {
  blockedRequestRecord,
  FakeClock,
  FakeLogger,
  pageRecord,
  screenshotRecord,
  sessionRecord,
  toolCallRecord,
  vaultAccessRecord,
} from '../helpers.ts';

/** Seeds a representative dataset (one row per table family) into `repos`. */
export async function seedFixture(uow: SqliteUnitOfWork): Promise<void> {
  const at = 1_700_000_000_000;
  await uow.transaction(async (r) => {
    await r.principals.insert({
      principalId: 'local',
      kind: 'operator',
      display: 'Local operator',
      tenantId: null,
      mustChangePassword: true,
      createdAt: at,
      updatedAt: at,
      disabledAt: null,
    });
    await r.credentials.insert({
      credentialId: 'cred-1',
      principalId: 'local',
      kind: 'password',
      publicPrefix: null,
      secretHash: '$argon2id$fixture',
      display: null,
      scopes: [],
      createdAt: at,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    });
    await r.authSessions.insert({
      authSessionId: 'as-1',
      principalId: 'local',
      tokenHash: 'hash-1',
      createdAt: at,
      lastSeenAt: at,
      expiresAt: at + 86_400_000,
      userAgent: 'fixture',
      ip: '127.0.0.1',
      revokedAt: null,
    });
    await r.grants.insert({
      grantId: 'g-1',
      tokenHash: 'grant-hash-1',
      authSessionId: 'as-1',
      route: 'trace',
      resourceId: 'shop-a1b2c3d4',
      createdAt: at,
      expiresAt: at + 60_000,
      usedAt: null,
    });
    await r.authEvents.append({
      eventId: 'e-auth-1',
      type: 'login_success',
      principalId: 'local',
      ip: '127.0.0.1',
      userAgent: 'fixture',
      details: null,
      occurredAt: at,
    });
    await r.mcpConnections.insert({
      connectionId: 'c-1',
      principalId: 'local',
      transport: 'http',
      mcpSessionId: 'm-1',
      clientName: 'fixture-client',
      clientVersion: '1.0',
      protocolVersion: '2025-06-18',
      capabilities: {},
      agentName: 'fixture-workspace',
      model: 'fixture-model',
      harness: 'claude-code',
      clientTitle: 'Fixture Client',
      workspace: 'fixture-workspace',
      modelSource: 'header',
      harnessSource: 'header',
      conflicts: [{ source: 'client_info', value: 'fixture-client', harness: 'fixture-client' }],
      meta: { team: 'fixture' },
      ip: '127.0.0.1',
      userAgent: 'fixture-agent/1.0',
      connectedAt: at,
      lastSeenAt: at,
      closedAt: null,
    });
    await r.sessions.insert(
      sessionRecord({
        connectionId: 'c-1',
        harness: 'claude-code',
        sandboxed: true,
        browserVersion: '154.0.8037.57',
      }),
    );
    await r.sessions.insert(
      sessionRecord({
        sessionId: 'old-11111111',
        createdAt: at - 86_400_000 * 10,
        closedAt: at - 86_400_000 * 9,
        closedReason: 'user',
        state: 'closed',
      }),
    );
    await r.events.append({
      eventId: 'e-ev-1',
      type: 'session.opened',
      sessionId: 'shop-a1b2c3d4',
      tenantId: null,
      actorKind: 'agent',
      actorId: 'local',
      occurredAt: at,
      traceId: null,
      payload: { session_id: 'shop-a1b2c3d4' },
    });
    await r.toolCalls.insert(toolCallRecord());
    await r.toolCalls.insert(
      toolCallRecord({
        eventId: 'e-tc-err',
        tool: 'click',
        ok: false,
        errorCode: 'ELEMENT_NOT_FOUND',
        errorMessage: 'no match',
        ts: at + 2_000,
        seq: 2,
      }),
    );
    await r.pages.insert(pageRecord());
    await r.screenshots.insert(screenshotRecord());
    await r.vaultAudit.insert(vaultAccessRecord());
    await r.blocklistAudit.insert(blockedRequestRecord());
    await r.operatorRequests.insert({
      requestId: 'a-fixture00001',
      kind: 'attention',
      sessionId: 'shop-a1b2c3d4',
      owner: 'local',
      reason: 'captcha',
      mode: 'takeover',
      entryName: null,
      tool: 'navigate',
      toolEventId: null,
      pageUrl: 'https://example.com/',
      options: null,
      idempotencyKey: null,
      createdAt: at + 3_000,
      deadlineAt: at + 300_000,
    });
    await r.operatorActions.append({
      eventId: 'e-op-1',
      principalId: 'local',
      action: 'terminate',
      resourceKind: 'session',
      resourceId: 'old-11111111',
      details: null,
      occurredAt: at,
    });
    await r.vaultBindings.upsert({
      handle: 'github',
      tenantId: null,
      title: 'GitHub',
      itemName: 'github.com',
      itemId: 'item-1',
      groupId: null,
      allowedOrigins: ['https://github.com'],
      authorizedPrincipals: [],
      authorizedSessionSlugs: ['*'],
      allowAllSessions: false,
      redactUsername: false,
      requireNoEvaluate: true,
      dashboardConfirm: false,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    await r.vaultGroupPolicies.upsert({
      groupKey: '__ungrouped__',
      groupId: null,
      tenantId: null,
      accessMode: 'manual',
      allowAllSessions: false,
      sessionSlugGlobs: [],
      authorizedPrincipals: [],
      dashboardConfirm: false,
      requireNoEvaluate: false,
      redactUsername: false,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    await r.notifications.insert({
      notificationId: 'n-1',
      principalId: 'local',
      type: 'attention',
      title: 'Attention requested',
      body: null,
      sessionId: 'shop-a1b2c3d4',
      target: '/sessions/shop-a1b2c3d4',
      sourceEventId: 'a-fixture00001',
      createdAt: at + 3_000,
      updatedAt: at + 3_000,
      count: 1,
      groupKey: null,
      readAt: null,
      dismissedAt: null,
      kind: 'attention.requested',
      category: 'needs-you',
      severity: 'warn',
      state: 'open',
      revision: 1,
      thread: 'notification:n-1',
      messageJson: null,
    });
    // Schema v5: a notification with its contract message, one channel, one delivery, one message.
    await r.notifications.insert({
      notificationId: 'n-fixture00002',
      principalId: null,
      type: 'attention',
      title: 'Attention requested',
      body: 'captcha · takeover — agent blocked, lease frozen',
      sessionId: 'shop-a1b2c3d4',
      target: '/sessions/shop-a1b2c3d4?live=1&takeover=1',
      sourceEventId: 'a-fixture00001',
      createdAt: at + 3_000,
      updatedAt: at + 3_000,
      count: 1,
      groupKey: null,
      readAt: null,
      dismissedAt: null,
      kind: 'attention.requested',
      category: 'needs-you',
      severity: 'warn',
      state: 'open',
      revision: 1,
      thread: 'attention:a-fixture00001',
      messageJson: JSON.stringify({
        schema: 1,
        id: 'n-fixture00002',
        revision: 1,
        thread: 'attention:a-fixture00001',
        kind: 'attention.requested',
        category: 'needs-you',
        severity: 'warn',
        state: 'open',
        alert: true,
        at: { created: at + 3_000, updated: at + 3_000 },
        title: 'Attention requested',
        summary: 'captcha · takeover — agent blocked, lease frozen',
        blocks: [
          {
            type: 'fields',
            items: [
              {
                label: 'Session',
                value: [{ type: 'link', text: 'shop', path: '/sessions/shop-a1b2c3d4' }],
              },
            ],
          },
        ],
        actions: [
          {
            kind: 'open',
            id: 'take-over',
            label: 'Take over',
            style: 'primary',
            path: '/sessions/shop-a1b2c3d4?live=1&takeover=1',
          },
        ],
        entities: { session_id: 'shop-a1b2c3d4', session_slug: 'shop', owner: 'local' },
        privacy: { level: 'full', has_image: false },
      }),
    });
    await r.notificationChannels.upsert({
      channelId: 'nc-fixture00001',
      name: 'phone',
      kind: 'telegram',
      mode: null,
      source: 'db',
      status: 'active',
      target: { chat: '123456' },
      secretRefs: { token: 'BH_TG_TOKEN' },
      rules: { categories: ['needs-you', 'problems'], content: 'titles' },
      failureCount: 0,
      lastError: null,
      lastOkAt: at + 3_100,
      lastFailureAt: null,
      createdAt: at,
      updatedAt: at,
    });
    await r.notificationDeliveries.enqueue([
      {
        channelId: 'nc-fixture00001',
        notificationId: 'n-fixture00002',
        revision: 1,
        op: 'send',
        status: 'pending',
        reason: null,
        nextAttemptAt: at + 3_000,
        createdAt: at + 3_000,
      },
    ]);
    await r.notificationChannelMessages.upsert({
      channelId: 'nc-fixture00001',
      notificationId: 'n-fixture00002',
      thread: 'attention:a-fixture00001',
      messageRef: { chat_id: 123456, message_id: 42 },
      lastRevision: 1,
      sentAt: at + 3_100,
      updatedAt: at + 3_100,
      expiresAt: null,
      deletedAt: null,
    });
    // Schema v6: one act-button token, one audited press, one listener cursor (D-41, D-42).
    await r.notificationActionTokens.insert([
      {
        tokenHash: 'a'.repeat(64),
        channelId: 'nc-fixture00001',
        notificationId: 'n-fixture00002',
        actionId: 'resolve',
        op: 'attention.resolve',
        args: { request_id: 'a-fixture00001', decision: 'resolve' },
        createdAt: at + 3_000,
        expiresAt: at + 3_000 + 86_400_000,
        usedAt: at + 4_000,
      },
    ]);
    await r.notificationActions.insert({
      at: at + 4_000,
      channelId: 'nc-fixture00001',
      channelName: 'phone',
      channelKind: 'telegram',
      notificationId: 'n-fixture00002',
      actionId: 'resolve',
      actionLabel: 'Mark resolved',
      op: 'attention.resolve',
      args: { request_id: 'a-fixture00001', decision: 'resolve' },
      actor: 'telegram:123456',
      actorName: 'Fixture Person',
      outcome: 'done',
      detail: 'Marked resolved. The agent continues.',
    });
    await r.notificationCursors.set('telegram:123456', '1001', at + 4_000);
    await r.preferences.set('local', 'theme', 'dark', at);
    await r.systemEvents.record({
      eventId: 'e-sys-1',
      code: 'RETENTION_FAILED',
      severity: 'warn',
      message: 'retention step failed',
      details: { step: 'logs' },
      at,
    });
    await r.idempotency.put({
      key: 'idem-1',
      principalId: 'local',
      route: 'POST /sessions/bulk',
      response: { ok_count: 1 },
      createdAt: at,
    });
    await r.artifactOutbox.enqueue({
      kind: 'trace',
      path: 'sessions/old-11111111/trace.zip',
      sessionId: 'old-11111111',
      enqueuedAt: at,
    });
  });
}

if (import.meta.main) {
  const target = join(import.meta.dir, `v${SCHEMA_VERSION}.db`);
  rmSync(target, { force: true });
  rmSync(`${target}-wal`, { force: true });
  rmSync(`${target}-shm`, { force: true });
  const handle = await openDatabase({
    path: target,
    dataDir: import.meta.dir,
    appVersion: 'fixture',
    clock: new FakeClock(),
    logger: new FakeLogger(),
  });
  await seedFixture(new SqliteUnitOfWork(handle.db));
  await handle.close();
  process.stdout.write(`wrote ${target}\n`);
}
