/** @module app/notifications/message.test — the contract builders (D-32): every producer's first revision validates against `NotificationMessage` with the documented kind, category, severity, state, thread, actions and entities; lifecycle revisions; redaction and the stored-JSON codec. */

import { describe, expect, it } from 'bun:test';
import { NotificationMessage } from '@browserhive/contracts/notifications';
import { createRedactor, REDACTED, SecretRegistry } from '../../kernel/redact.ts';
import {
  buildMessage,
  clip,
  decodeMessage,
  encodeMessage,
  formatDuration,
  reviseMessage,
  scrubMessage,
} from './message.ts';
import { draftFor, type ProducedEvent, revisionFor } from './producers.ts';
import {
  attentionCreated,
  attentionResolved,
  SESSION,
  sessionClosed,
  systemDegraded,
  systemRecovered,
  toolCalled,
  vaultConfirmCreated,
  vaultConfirmResolved,
} from './test-fixtures.ts';

/** First revision of a producer's draft, as the service builds it. */
function first(event: ProducedEvent, count = 1): NotificationMessage {
  const draft = draftFor(event);
  if (draft === null) throw new Error('silent event');
  return buildMessage({
    id: 'n-000000000001',
    revision: count,
    thread: draft.thread,
    kind: draft.kind,
    severity: draft.severity,
    state: draft.state,
    alert: count === 1,
    createdAt: 10,
    updatedAt: 10,
    title: draft.group?.title(count) ?? draft.title,
    summary: draft.body ?? '',
    ...draft.content(count),
  });
}

describe('producer messages', () => {
  const cases: ReadonlyArray<
    readonly [
      string,
      ProducedEvent,
      {
        kind: string;
        category: string;
        severity: string;
        state: string;
        thread: string;
        actions: string[];
      },
    ]
  > = [
    [
      'attention takeover',
      attentionCreated('a-000000000001', 'takeover', {
        page_url: 'https://shop.example/checkout?token=abc#x',
        tool: 'click',
      }),
      {
        kind: 'attention.requested',
        category: 'needs-you',
        severity: 'warn',
        state: 'open',
        thread: 'attention:a-000000000001',
        actions: ['take-over', 'resolve', 'reject'],
      },
    ],
    [
      'attention notify',
      attentionCreated('a-000000000002', 'notify'),
      {
        kind: 'attention.requested',
        category: 'needs-you',
        severity: 'warn',
        state: 'open',
        thread: 'attention:a-000000000002',
        actions: ['open-live', 'resolve', 'reject'],
      },
    ],
    [
      'vault confirm',
      vaultConfirmCreated('a-000000000003', 'github'),
      {
        kind: 'vault.confirm',
        category: 'needs-you',
        severity: 'warn',
        state: 'open',
        thread: 'vault:a-000000000003',
        actions: ['approve', 'deny', 'review'],
      },
    ],
    [
      'session crash',
      sessionClosed('crash'),
      {
        kind: 'session.crashed',
        category: 'problems',
        severity: 'error',
        state: 'final',
        thread: `session:${SESSION}`,
        actions: ['open-session'],
      },
    ],
    [
      'lease reap',
      sessionClosed('lease_expired'),
      {
        kind: 'session.reaped',
        category: 'problems',
        severity: 'warn',
        state: 'final',
        thread: `session:${SESSION}`,
        actions: ['open-session'],
      },
    ],
    [
      'tool errors',
      toolCalled(1, { ok: false }),
      {
        kind: 'tool.errors',
        category: 'problems',
        severity: 'warn',
        state: 'open',
        thread: `tool-errors:${SESSION}`,
        actions: ['open-errors'],
      },
    ],
    [
      'session-less tool errors',
      toolCalled(2, {
        ok: false,
        tool: 'launch_session',
        code: 'BROWSER_NOT_INSTALLED',
        sessionId: null,
      }),
      {
        kind: 'tool.errors',
        category: 'problems',
        severity: 'warn',
        state: 'open',
        thread: 'tool-errors:none',
        actions: [],
      },
    ],
    [
      'degradation',
      systemDegraded('error'),
      {
        kind: 'system.degraded',
        category: 'system',
        severity: 'error',
        state: 'open',
        thread: `system:e-${'1'.padStart(26, '0')}`,
        actions: ['open-system'],
      },
    ],
  ];
  for (const [name, event, expected] of cases) {
    it(name, () => {
      const message = NotificationMessage.parse(first(event));
      expect(message).toMatchObject({
        schema: 1,
        kind: expected.kind,
        category: expected.category,
        severity: expected.severity,
        state: expected.state,
        thread: expected.thread,
        alert: true,
        privacy: { level: 'full', has_image: false },
      });
      expect(message.actions.map((a) => a.id)).toEqual(expected.actions);
    });
  }

  it('sanitizes the page URL and names the domain and request', () => {
    const message = first(
      attentionCreated('a-000000000001', 'takeover', {
        page_url: 'https://shop.example/checkout?token=abc#x',
      }),
    );
    const json = JSON.stringify(message);
    expect(json).toContain('https://shop.example/checkout');
    expect(json).not.toContain('token=abc');
    expect(message.entities).toMatchObject({
      session_id: SESSION,
      session_slug: 'shop',
      domain: 'shop.example',
      request_id: 'a-000000000001',
      owner: 'local',
    });
  });

  it('a one-shot fact carries its actions even though it is final', () => {
    expect(first(sessionClosed('crash')).actions).toHaveLength(1);
  });

  it('tool error groups carry the count and the harness', () => {
    const message = first(toolCalled(3, { ok: false }), 7);
    expect(message.title).toBe('shop · 7 tool errors');
    expect(message.alert).toBe(false);
    expect(JSON.stringify(message.blocks)).toContain('"7"');
    expect(message.entities).toMatchObject({
      tool: 'navigate',
      error_code: 'NAVIGATION_TIMEOUT',
      harness: 'unknown',
    });
  });

  it('silent events and revision-only events produce no draft', () => {
    expect(draftFor(sessionClosed('user'))).toBeNull();
    expect(draftFor(attentionResolved('a-000000000001', 'resolved'))).toBeNull();
    expect(draftFor(systemRecovered())).toBeNull();
  });
});

describe('revisions', () => {
  const table = [
    [
      'attention resolved',
      attentionResolved('a-000000000001', 'resolved'),
      'resolved',
      'Resolved by local after 2m 10s',
    ],
    [
      'attention rejected',
      attentionResolved('a-000000000001', 'rejected'),
      'resolved',
      'Rejected by local after 2m 10s',
    ],
    [
      'attention timeout',
      attentionResolved('a-000000000001', 'timeout'),
      'expired',
      'Timed out after 2m 10s',
    ],
    [
      'attention cancelled',
      attentionResolved('a-000000000001', 'cancelled'),
      'final',
      'Cancelled after 2m 10s: the agent stopped waiting',
    ],
    [
      'vault approved',
      vaultConfirmResolved('a-000000000002', 'resolved'),
      'resolved',
      'Approved by local after 5 s',
    ],
    [
      'vault denied',
      vaultConfirmResolved('a-000000000002', 'rejected'),
      'resolved',
      'Denied by local after 5 s',
    ],
  ] as const;
  for (const [name, event, state, summary] of table) {
    it(name, () => {
      const revision = revisionFor(event);
      expect(revision?.change).toMatchObject({ state, summary });
    });
  }

  it('a recovered degradation resolves its thread', () => {
    expect(revisionFor(systemRecovered())).toMatchObject({
      thread: `system:e-${'1'.padStart(26, '0')}`,
      change: { state: 'resolved' },
    });
  });

  it('reviseMessage is the next silent full state without buttons', () => {
    const prev = first(attentionCreated('a-000000000001', 'takeover'));
    const change = revisionFor(attentionResolved('a-000000000001', 'resolved'))?.change;
    if (change === undefined) throw new Error('no change');
    const next = NotificationMessage.parse(reviseMessage(prev, change, 500));
    expect(next).toMatchObject({
      revision: 2,
      state: 'resolved',
      alert: false,
      actions: [],
      summary: 'Resolved by local after 2m 10s',
      at: { created: 10, updated: 500 },
      title: prev.title,
    });
    const fields = next.blocks.find((b) => b.type === 'fields');
    expect(fields?.type === 'fields' && fields.items.map((i) => i.label)).toContain('Outcome');
    // Applying the same change again replaces the field instead of duplicating it.
    const again = reviseMessage(next, change, 600);
    const again_fields = again.blocks.find((b) => b.type === 'fields');
    expect(
      again_fields?.type === 'fields' &&
        again_fields.items.filter((i) => i.label === 'Outcome').length,
    ).toBe(1);
  });
});

describe('redaction and codec', () => {
  it('scrubs registered secrets from every string leaf and keeps the limits', () => {
    const secret = 's3cr3t-value';
    const registry = new SecretRegistry({ now: () => 0 });
    registry.add(secret);
    const redactor = createRedactor(registry);
    const message = first(
      attentionCreated('a-000000000001', 'takeover', {
        reason: `${'x'.repeat(230)} ${secret}`,
        page_url: `https://example.com/${secret}`,
      }),
    );
    const scrubbed = scrubMessage(message, redactor);
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain(secret);
    expect(json).toContain(REDACTED);
    expect(scrubbed.summary.length).toBeLessThanOrEqual(240);
    expect(NotificationMessage.safeParse(scrubbed).success).toBe(true);
  });

  it('round-trips through JSON and refuses garbage', () => {
    const message = first(sessionClosed('crash'));
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
    expect(decodeMessage(null)).toBeNull();
    expect(decodeMessage('{')).toBeNull();
    expect(decodeMessage('{"schema":2}')).toBeNull();
  });

  it('clip and formatDuration', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(130_000)).toBe('2m 10s');
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 05m');
  });
});
