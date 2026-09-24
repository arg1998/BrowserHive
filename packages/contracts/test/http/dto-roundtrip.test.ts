/// <reference types="bun-types" />
/** @module contracts/test/http/dto-roundtrip.test — one representative DTO per resource parses, round-trips through JSON, and rejects damage */
import { describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import {
  ActivityResponse,
  AttentionPage,
  BlockedAttemptsPage,
  BlocklistOverview,
  HealthResponse,
  LoginResponse,
  LogsPage,
  MeResponse,
  NotificationsPage,
  PagesPage,
  ScreenshotsPage,
  SessionDetail,
  SessionsPage,
  SystemConfigResponse,
  SystemEventsPage,
  TimelinePage,
  ToolCallDetail,
  ToolCallsPage,
  VaultBindingsPage,
  VaultExportDocument,
  VaultLogPage,
  VaultOverview,
} from '../../src/http/index.ts';
import * as fx from './fixtures.ts';

const cases: ReadonlyArray<readonly [string, z.ZodType, unknown]> = [
  [
    'health',
    HealthResponse,
    {
      status: 'ready',
      phase: 'ready',
      version: '1.0.0',
      uptime_ms: 12_000,
      checks: { db: 'ok', browser: 'ok', listeners: 'ok' },
    },
  ],
  [
    'auth/login',
    LoginResponse,
    {
      ok: true,
      must_change_password: false,
      session: { id_prefix: 'abcd1234', expires_at: fx.NOW },
    },
  ],
  [
    'auth/me',
    MeResponse,
    {
      principal: {
        subject: 'p-k3j4h5g6f7d8',
        kind: 'operator',
        display: 'admin',
        scopes: ['sessions:read', 'sessions:write'],
        must_change_password: false,
      },
      session: {
        id_prefix: 'abcd1234',
        created_at: fx.NOW - 1,
        last_seen_at: fx.NOW,
        expires_at: fx.NOW + 1,
      },
    },
  ],
  [
    'sessions list',
    SessionsPage,
    {
      ...fx.envelope([fx.sessionSummary()], 'created_at'),
      facets: {
        owners: [{ value: 'p-k3j4h5g6f7d8', count: 1 }],
        channels: [{ value: 'chromium', count: 1 }],
        persistence_modes: [{ value: 'memory', count: 1 }],
        states: [{ value: 'live', count: 1 }],
        harnesses: [{ value: 'claude-code', count: 1 }],
      },
    },
  ],
  [
    'sessions detail',
    SessionDetail,
    {
      session: fx.sessionSummary(),
      trace: {
        enabled: true,
        path: '/data/sessions/shop-a1b2c3d4/trace.zip',
        viewer_available: true,
      },
      data_dir: { path: '/data/sessions/shop-a1b2c3d4', persistent: false },
      counts: fx.sessionSummary().counts,
      now: fx.NOW,
    },
  ],
  ['tool-calls list', ToolCallsPage, fx.envelope([{ ...fx.toolCallRow(), session_slug: 'shop' }])],
  [
    'tool-calls detail',
    ToolCallDetail,
    {
      ...fx.toolCallRow(),
      args_json: { url: 'https://example.com/' },
      result_text: 'ok',
      screenshot: fx.screenshotRow(),
    },
  ],
  [
    'pages',
    PagesPage,
    {
      ...fx.envelope([{ ...fx.pageRow(), session_slug: 'shop' }]),
      facets: { category: [{ value: 'public', count: 1 }] },
    },
  ],
  [
    'attention',
    AttentionPage,
    {
      ...fx.envelope([fx.operatorRequestRow()], 'created_at'),
      open_count: 1,
      facets: { status: [{ value: 'pending', count: 1 }], mode: [{ value: 'takeover', count: 1 }] },
    },
  ],
  [
    'vault overview',
    VaultOverview,
    {
      backend: {
        id: 'bitwarden',
        capabilities: {
          unlock: 'passphrase',
          grouping: 'flat',
          writable: false,
          totp: true,
          sync: true,
        },
      },
      unlock: { required: true, mode: 'passphrase', hint: 'backend passphrase' },
      unlocked: false,
      bindings_count: 1,
      policies_count: 1,
      now: fx.NOW,
    },
  ],
  ['vault bindings', VaultBindingsPage, fx.envelope([fx.vaultBinding()], 'handle')],
  ['vault log', VaultLogPage, fx.envelope([fx.vaultAccessRow()])],
  [
    'vault export',
    VaultExportDocument,
    {
      version: 3,
      bindings: [
        (() => {
          const { created_at: _c, updated_at: _u, version: _v, ...rest } = fx.vaultBinding();
          return rest;
        })(),
      ],
      policies: [
        (() => {
          const { created_at: _c, updated_at: _u, version: _v, ...rest } = fx.vaultGroupPolicy();
          return rest;
        })(),
      ],
    },
  ],
  [
    'blocklist overview',
    BlocklistOverview,
    {
      configured: true,
      path: '/etc/browserhive/blocklist.txt',
      loaded_at: fx.NOW - 10_000,
      patterns: [{ pattern: '*.example.net', line: 1, hits: 3, last_ts: fx.NOW - 1_500 }],
      skipped: [{ line: 2, text: '[[', reason: 'invalid glob' }],
      stats: {
        attempts: 3,
        sessions: 1,
        domains: 1,
        total_all_time: 10,
        top_patterns: [{ pattern: '*.example.net', count: 3 }],
        top_domains: [{ domain: 'ads.example.net', count: 3 }],
      },
      window: { since: fx.NOW - 604_800_000, until: null },
      now: fx.NOW,
    },
  ],
  ['blocklist attempts', BlockedAttemptsPage, fx.envelope([fx.blockedRequestRow()])],
  [
    'system config',
    SystemConfigResponse,
    {
      keys: [
        {
          key: 'port',
          value: 3000,
          source: 'cli',
          shadowed: [{ source: 'env', value: 4000 }],
          secret: false,
        },
        { key: 'vaultToken', value: '[REDACTED]', source: 'env', shadowed: [], secret: true },
      ],
    },
  ],
  ['system events', SystemEventsPage, fx.envelope([fx.systemEvent()], 'last_seen_at')],
  ['logs', LogsPage, { ...fx.envelope([fx.logRecord()]), latest_seq: 7 }],
  [
    'notifications',
    NotificationsPage,
    { ...fx.envelope([fx.notification()], 'created_at'), unread_count: 1 },
  ],
  [
    'activity',
    ActivityResponse,
    {
      buckets: [
        {
          ts: fx.NOW - 3_600_000,
          tool_calls: 3,
          errors: 1,
          sessions_started: 1,
          sessions_closed: 0,
          blocked: 0,
          attention: 1,
        },
      ],
      summary: {
        sessions_total: 1,
        sessions_live: 1,
        sessions_window: 1,
        tool_calls_window: 3,
        tool_calls_total: 3,
        errors_window: 1,
        errors_total: 1,
        blocked_window: 0,
        blocked_total: 0,
        attention_open: 1,
        active_screencasts: 0,
      },
      window: { since: fx.NOW - 604_800_000, until: fx.NOW, bucket_ms: 3_600_000 },
      now: fx.NOW,
    },
  ],
  ['screenshots', ScreenshotsPage, fx.envelope([fx.screenshotRow()])],
  [
    'timeline',
    TimelinePage,
    fx.envelope([
      { kind: 'tool', id: 'tool:e-1', ts: fx.NOW - 5_000, seq: 1, row: fx.toolCallRow() },
      { kind: 'page', id: 'page:e-1', ts: fx.NOW - 5_000, seq: 2, row: fx.pageRow() },
      {
        kind: 'attention',
        id: 'attention:a-1',
        ts: fx.NOW - 3_000,
        seq: 3,
        row: fx.operatorRequestRow(),
      },
      { kind: 'vault', id: 'vault:e-2', ts: fx.NOW - 2_000, seq: 4, row: fx.vaultAccessRow() },
      {
        kind: 'blocked',
        id: 'blocked:e-3',
        ts: fx.NOW - 1_500,
        seq: 5,
        row: fx.blockedRequestRow(),
      },
    ]),
  ],
];

describe('http DTO round-trips', () => {
  for (const [name, schema, fixture] of cases) {
    it(`${name}: parses, survives JSON, and equals its input`, () => {
      const parsed = schema.parse(fixture);
      expect(parsed).toEqual(fixture);
      const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(again).toEqual(parsed);
    });
    it(`${name}: rejects the fixture with its first key removed`, () => {
      const record: Record<string, unknown> = { ...(fixture as Record<string, unknown>) };
      const [firstKey] = Object.keys(record);
      if (firstKey === undefined) throw new Error('fixture has no keys');
      delete record[firstKey];
      expect(schema.safeParse(record).success).toBe(false);
    });
  }
});
