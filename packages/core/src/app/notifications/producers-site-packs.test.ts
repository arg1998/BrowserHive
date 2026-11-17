/** @module app/notifications/producers-site-packs.test — `site_pack.write_confirm` (spec 13 §8.6): one coalesced thread per template site with the open count, Approve/Deny on the newest request for `write` guards only, resolved when none is open; contract validity and the redaction sentinel; security intercepts never become "Attention requested". */

import { describe, expect, it } from 'bun:test';
import { NotificationMessage } from '@browserhive/contracts/notifications';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryNotificationRepository } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { toOperatorRequestRow } from '../../domain/operator-requests/wire.ts';
import { createRedactor, SecretRegistry } from '../../kernel/redact.ts';
import type { SiteConfirmEvent } from '../../ports/site-guards.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { NotificationService } from './notification-service.ts';
import { draftFor, type ProducedEvent, revisionFor } from './producers.ts';
import {
  siteConfirmThread,
  writeConfirmDraft,
  writeConfirmRevision,
} from './producers-site-packs.ts';

const TID = 'tp-fixture001';

function confirm(over: Partial<SiteConfirmEvent> = {}): SiteConfirmEvent {
  return {
    type: 'site_pack.confirm',
    phase: 'opened',
    template_id: TID,
    template_name: 'Job Hunt',
    site: 'site-a.test',
    site_title: 'Site A',
    open: 1,
    request_id: 'a-000000000001',
    session_id: 'demo-00000001',
    guard: { pack_id: 'site-a.test', id: 'invite', kind: 'write' },
    method: 'POST',
    url: 'https://www.site-a.test/api/invite',
    tool: null,
    at: 1_700_000_000_000,
    ...over,
  };
}

const event = (payload: SiteConfirmEvent): ProducedEvent => ({
  name: 'site_pack.confirm',
  at: 1,
  payload,
});

function setup(redactor?: ReturnType<typeof createRedactor>) {
  const repo = new InMemoryNotificationRepository();
  const service = new NotificationService({
    repo,
    bus: new RecordingEventBus<DomainEvents>(),
    clock: new FakeClock(),
    ids: new FakeIdGenerator(),
    logger: new CollectingLogger(),
    ...(redactor !== undefined && { redactor }),
  });
  return { repo, service };
}

function messageOf(repo: InMemoryNotificationRepository, id: string | undefined) {
  return NotificationMessage.parse(JSON.parse(repo.rows.get(id ?? '')?.messageJson ?? 'null'));
}

describe('site_pack.write_confirm — pure rules', () => {
  it('a write guard: needs-you thread per template site with Approve/Deny on the newest request', () => {
    const draft = writeConfirmDraft(confirm());
    expect(draft).toMatchObject({
      type: 'attention',
      kind: 'site_pack.write_confirm',
      severity: 'warn',
      state: 'open',
      thread: siteConfirmThread(TID, 'site-a.test'),
      title: 'Job Hunt: 1 write needs approval on Site A',
      target: '/attention',
      group: { key: `site-confirm:${TID}:site-a.test` },
    });
    const content = draft?.content(1);
    expect(content?.actions.map((a) => a.id)).toEqual(['approve', 'deny', 'review']);
    expect(content?.actions[0]).toMatchObject({
      command: {
        op: 'attention.resolve',
        args: { request_id: 'a-000000000001', decision: 'resolve' },
      },
    });
    expect(draft?.group?.title(7)).toBe('Job Hunt: 1 write needs approval on Site A');
    expect(writeConfirmDraft(confirm({ open: 3 }))?.title).toBe(
      'Job Hunt: 3 writes need approval on Site A',
    );
  });

  it.each(['logout', 'account', 'credential', 'destructive'] as const)(
    'a %s guard is approved on /attention only (no act buttons)',
    (kind) => {
      const draft = writeConfirmDraft(confirm({ guard: { pack_id: 'p.test', id: 'g', kind } }));
      expect(draft?.content(1).actions.map((a) => a.id)).toEqual(['review']);
    },
  );

  it('resolves when none is open; a settle with others open and an opening revise nothing', () => {
    expect(writeConfirmRevision(confirm({ phase: 'settled', open: 0 }))).toMatchObject({
      thread: `site-confirm:${TID}:site-a.test`,
      kinds: ['site_pack.write_confirm'],
      change: { state: 'resolved' },
    });
    expect(writeConfirmRevision(confirm({ phase: 'settled', open: 2 }))).toBeNull();
    expect(writeConfirmRevision(confirm())).toBeNull();
    expect(writeConfirmDraft(confirm({ phase: 'settled', open: 0 }))).toBeNull();
  });

  it('a security intercept never becomes "Attention requested" nor revises an attention thread', () => {
    const request = toOperatorRequestRow(
      {
        requestId: 'a-000000000002',
        kind: 'security_intercept',
        sessionId: 'demo-00000001',
        owner: 'agent-1',
        reason: 'Site A security check',
        mode: 'takeover',
        entryName: null,
        tool: null,
        toolEventId: null,
        pageUrl: null,
        options: null,
        idempotencyKey: null,
        status: 'resolved',
        message: null,
        resolvedBy: 'admin',
        resolutionReason: null,
        createdAt: 1,
        deadlineAt: null,
        resolvedAt: 2,
        templateId: TID,
      },
      'demo',
    );
    expect(
      draftFor({
        name: 'attention.created',
        at: 1,
        payload: { type: 'attention.created', request },
      }),
    ).toBeNull();
    expect(
      revisionFor({
        name: 'attention.resolved',
        at: 2,
        payload: { type: 'attention.resolved', request },
      }),
    ).toBeNull();
  });
});

describe('site_pack.write_confirm — through NotificationService', () => {
  it('coalesces into one row that grows, then resolves; every message is contract-valid', async () => {
    const { repo, service } = setup();
    const [first] = await service.produce(event(confirm()));
    const [grown] = await service.produce(
      event(confirm({ open: 2, request_id: 'a-000000000003' })),
    );
    expect(repo.rows.size).toBe(1);
    expect(grown?.notification_id).toBe(first?.notification_id);
    const message = messageOf(repo, first?.notification_id);
    expect(message.title).toBe('Job Hunt: 2 writes need approval on Site A');
    expect(message.actions[0]).toMatchObject({
      command: { args: { request_id: 'a-000000000003' } },
    });
    await service.produce(
      event(confirm({ phase: 'settled', open: 1, request_id: 'a-000000000001' })),
    );
    expect(messageOf(repo, first?.notification_id).state).toBe('open');
    await service.produce(
      event(confirm({ phase: 'settled', open: 0, request_id: 'a-000000000003' })),
    );
    expect(messageOf(repo, first?.notification_id).state).toBe('resolved');
  });

  it('a registered sentinel in the URL or template name never reaches the notification', async () => {
    const secret = ['sentinel', 'value', 'for', 'tests'].join('-');
    const clock = new FakeClock();
    const registry = new SecretRegistry({ now: () => clock.now() });
    registry.add(secret);
    const { repo, service } = setup(createRedactor(registry));
    await service.produce(
      event(
        confirm({
          template_name: `Jobs ${secret}`,
          url: `https://www.site-a.test/api/${secret}`,
          tool: `t-${secret}`.slice(0, 40),
        }),
      ),
    );
    expect(repo.rows.size).toBe(1);
    expect(JSON.stringify([...repo.rows.values()])).not.toContain(secret);
    for (const row of repo.rows.values()) messageOf(repo, row.notificationId);
  });
});
