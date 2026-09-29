/** @module contracts/test/notifications.test — the notification contract (D-32): message schema, dashboard paths, the kind taxonomy, the legacy classification mirrored by migration v5, channel rules and secret references (D-33), the published JSON Schema */
import { describe, expect, it } from 'bun:test';
import { NotificationKind } from '../src/enums/index.ts';
import {
  classifyLegacy,
  DashboardPath,
  IN_APP_ONLY_KINDS,
  KIND_CATEGORY,
  KIND_LABEL,
  KIND_SEVERITY,
  NOTIFICATION_MESSAGE_SCHEMA_ID,
  NotificationChannelRules,
  NotificationMessage,
  notificationMessageJsonSchema,
  SecretEnvName,
  StartupNotificationChannel,
} from '../src/notifications/index.ts';

const MESSAGE = {
  schema: 1,
  id: 'n-k3j4h5g6f7d8',
  revision: 1,
  thread: 'attention:a-k3j4h5g6f7d8',
  kind: 'attention.requested',
  category: 'needs-you',
  severity: 'warn',
  state: 'open',
  alert: true,
  at: { created: 1, updated: 1 },
  title: 'Attention requested',
  summary: 'captcha — agent blocked',
  blocks: [
    { type: 'quote', content: [{ type: 'text', text: 'solve it' }], collapsible: true },
    {
      type: 'fields',
      items: [
        {
          label: 'Session',
          value: [{ type: 'link', text: 'shop', path: '/sessions/shop-a1b2c3d4' }],
        },
      ],
    },
    { type: 'table', columns: ['Tool'], rows: [[[{ type: 'code', text: 'click' }]]] },
    { type: 'image', ref: 'shot', alt: 'page', captured_at: 1, masked: false, path: null },
    { type: 'code', text: 'x', language: null },
    { type: 'divider' },
    { type: 'footer', content: [{ type: 'time', at: 1, style: 'relative' }] },
  ],
  actions: [
    {
      kind: 'open',
      id: 'take-over',
      label: 'Take over',
      style: 'primary',
      path: '/sessions/shop-a1b2c3d4?live=1',
    },
    {
      kind: 'act',
      id: 'reject',
      label: 'Reject',
      style: 'danger',
      command: {
        op: 'attention.resolve',
        args: { request_id: 'a-k3j4h5g6f7d8', decision: 'reject' },
      },
      confirm: 'Reject?',
      fallback: { label: 'Open in BrowserHive', path: '/attention' },
    },
  ],
  entities: { session_id: 'shop-a1b2c3d4', session_slug: 'shop' },
  privacy: { level: 'full', has_image: true },
};

describe('NotificationMessage', () => {
  it('accepts a full message and rejects another schema version', () => {
    expect(NotificationMessage.safeParse(MESSAGE).success).toBe(true);
    expect(NotificationMessage.safeParse({ ...MESSAGE, schema: 2 }).success).toBe(false);
    expect(NotificationMessage.safeParse({ ...MESSAGE, title: 'x'.repeat(121) }).success).toBe(
      false,
    );
    expect(
      NotificationMessage.safeParse({ ...MESSAGE, actions: Array(6).fill(MESSAGE.actions[0]) })
        .success,
    ).toBe(false);
  });

  it('links only to dashboard paths', () => {
    expect(DashboardPath.safeParse('/sessions/x?live=1').success).toBe(true);
    for (const bad of ['https://evil.example/', '//evil.example/x', 'sessions/x', '/a b']) {
      expect(DashboardPath.safeParse(bad).success).toBe(false);
    }
  });

  it('publishes a draft 2020-12 JSON Schema with every top-level field required', () => {
    const schema = notificationMessageJsonSchema();
    expect(schema['$id']).toBe(NOTIFICATION_MESSAGE_SCHEMA_ID);
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect([...((schema['required'] as string[] | undefined) ?? [])].sort()).toEqual(
      Object.keys(MESSAGE).sort(),
    );
  });
});

describe('taxonomy', () => {
  it('maps every kind to a category, a severity and a label', () => {
    for (const kind of NotificationKind.options) {
      expect(KIND_CATEGORY[kind]).toBeDefined();
      expect(KIND_SEVERITY[kind]).toBeDefined();
      expect(KIND_LABEL[kind].length).toBeGreaterThan(0);
    }
    expect([...IN_APP_ONLY_KINDS]).toEqual(['channel.broken']);
  });

  it('classifies legacy rows as migration v5 does (state aside)', () => {
    const base = {
      notificationId: 'n-1',
      groupKey: null,
      sessionId: 'shop-a1b2c3d4',
      sourceEventId: 'a-1',
    };
    const rows = [
      [
        { type: 'attention', title: 'Attention requested' },
        'attention.requested',
        'needs-you',
        'warn',
        'final',
        'attention:a-1',
      ],
      [
        { type: 'vault', title: 'Vault fill awaiting confirm' },
        'vault.confirm',
        'needs-you',
        'warn',
        'final',
        'vault:a-1',
      ],
      [
        { type: 'lifecycle', title: 'Session reaped (lease expired)' },
        'session.reaped',
        'problems',
        'warn',
        'final',
        'session:shop-a1b2c3d4',
      ],
      [{ type: 'system', title: 'm' }, 'system.degraded', 'system', 'error', 'final', 'system:a-1'],
      [
        { type: 'error', title: 'Session crashed' },
        'session.crashed',
        'problems',
        'error',
        'final',
        'session:shop-a1b2c3d4',
      ],
      [
        { type: 'error', title: 'shop · 2 tool errors' },
        'tool.errors',
        'problems',
        'warn',
        'open',
        'tool-errors:shop-a1b2c3d4',
      ],
    ] as const;
    for (const [row, kind, category, severity, state, thread] of rows) {
      expect(classifyLegacy({ ...base, ...row })).toEqual({
        kind,
        category,
        severity,
        state,
        thread,
      });
    }
    expect(
      classifyLegacy({ ...base, type: 'attention', title: 't', sourceEventId: null }).thread,
    ).toBe('notification:n-1');
  });
});

describe('channel configuration', () => {
  it('secrets are environment variable names, never BROWSERHIVE_*', () => {
    expect(SecretEnvName.safeParse('BH_TG_TOKEN').success).toBe(true);
    for (const bad of ['BROWSERHIVE_TOKEN', 'bad-name', '1ABC', '']) {
      expect(SecretEnvName.safeParse(bad).success).toBe(false);
    }
  });

  it('rules are optional per key and unknown keys are dropped', () => {
    expect(NotificationChannelRules.parse({})).toEqual({});
    expect(
      NotificationChannelRules.parse({
        categories: ['needs-you'],
        ttl_ms: { 'needs-you': 7_200_000 },
        quiet_hours: { start: '22:00', end: '07:00' },
        future_rule: true,
      }),
    ).toEqual({
      categories: ['needs-you'],
      ttl_ms: { 'needs-you': 7_200_000 },
      quiet_hours: { start: '22:00', end: '07:00' },
    });
    expect(
      NotificationChannelRules.safeParse({ quiet_hours: { start: '25:00', end: '07:00' } }).success,
    ).toBe(false);
  });

  it('a startup channel is external and names its secrets', () => {
    const channel = {
      name: 'phone',
      kind: 'telegram',
      mode: null,
      target: { chat: '123456' },
      secret_refs: { token: 'BH_TG_TOKEN' },
      rules: {},
    };
    expect(StartupNotificationChannel.safeParse(channel).success).toBe(true);
    expect(StartupNotificationChannel.safeParse({ ...channel, kind: 'in-app' }).success).toBe(
      false,
    );
    expect(StartupNotificationChannel.safeParse({ ...channel, name: 'Phone!' }).success).toBe(
      false,
    );
    expect(
      StartupNotificationChannel.safeParse({ ...channel, secret_refs: { token: '123:abc' } })
        .success,
    ).toBe(false);
  });
});
