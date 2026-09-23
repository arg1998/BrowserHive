/** @module interface/http/serializers/serializers.test — record → wire mappers parse with the contracts schemas and preserve every field. */

import { describe, expect, it } from 'bun:test';
import {
  BlockedRequestRow,
  FleetToolCallRow,
  Notification,
  PageRow,
  ScreenshotRow,
  SessionSummary,
  SystemConfigKey,
  SystemEvent,
  TimelineItem,
  ToolCallRow,
  VaultBinding,
  VaultGroupPolicy,
  VaultOverview,
} from '@browserhive/contracts/http';
import { NOW } from '../../../../test/helpers/http-fakes.ts';
import { sessionRecord } from '../../../../test/helpers/http-fixtures.ts';
import { configView } from '../../../app/config/provenance-view.ts';
import { resolveOk } from '../../../app/config/test-support.ts';
import {
  blockedToWire,
  fleetToolCallToWire,
  pageToWire,
  screenshotToWire,
  toolCallToWire,
} from './facts.ts';
import { envelope } from './page.ts';
import { sessionRowToSummary, sessionsQueryToRepo } from './sessions.ts';
import { configKeysToWire, notificationToWire, systemEventToWire } from './system.ts';
import { timelineItemToWire } from './timeline.ts';
import { bindingInputFromWire, bindingToWire, overviewToWire, policyToWire } from './vault.ts';

const counts = { toolCalls: 2, errors: 1, pages: 1, blocked: 0, attentionOpen: 0, vaultAccess: 1 };
const call = {
  eventId: 'e-00000000000000000000000001',
  sessionId: 'shop-0000000a',
  connectionId: null,
  tool: 'navigate',
  tabId: 't-000001',
  args: { url: 'x' },
  ok: true,
  errorCode: null,
  errorMessage: null,
  resultText: 'ok',
  resultSizeBytes: 2,
  durationMs: 3,
  ts: NOW,
  traceId: 'abc',
  spanId: null,
  seq: 7,
  sessionSlug: 'shop',
  hasScreenshot: true,
};

describe('serializers', () => {
  it('session rows', () => {
    const wire = sessionRowToSummary({ ...sessionRecord(), counts, client: null }, NOW, true);
    const parsed = SessionSummary.parse(wire);
    expect(parsed).toMatchObject({
      session_id: 'shop-0000000a',
      live: false,
      lease_remaining_ms: 0,
      has_live_viewers: true,
      counts: { tool_calls: 2, errors: 1, vault_access: 1 },
      client: null,
    });
    const open = sessionRowToSummary(
      {
        ...sessionRecord({
          state: 'live',
          closedAt: null,
          closedReason: null,
          leaseExpiresAt: NOW + 500,
        }),
        counts,
        client: { name: 'claude-code', version: '2.1.0', agentName: null, model: 'claude-opus-5' },
      },
      NOW,
      false,
    );
    expect(open.live).toBe(true);
    expect(open.lease_remaining_ms).toBe(500);
    // Header fields the client did not send are omitted, never `null` (the contract has them optional).
    expect(SessionSummary.parse(open).client).toEqual({
      name: 'claude-code',
      version: '2.1.0',
      model: 'claude-opus-5',
    });
  });

  it('session query mapping keeps only supplied filters', () => {
    const repo = sessionsQueryToRepo({
      limit: 10,
      dir: 'desc',
      total: false,
      sort: 'slug',
      view: 'all',
      archived: 'exclude',
      state: ['live'],
      q: 'sh',
    });
    expect(repo).toEqual({
      limit: 10,
      dir: 'desc',
      total: false,
      sort: 'slug',
      view: 'all',
      archived: 'exclude',
      states: ['live'],
      q: 'sh',
    });
  });

  it('facts', () => {
    expect(ToolCallRow.parse(toolCallToWire(call, false))).not.toHaveProperty('args_json');
    expect(FleetToolCallRow.parse(fleetToolCallToWire(call, true))).toMatchObject({
      args_json: { url: 'x' },
      result_text: 'ok',
      session_slug: 'shop',
    });
    const page = {
      eventId: 'e-00000000000000000000000003',
      sessionId: 'shop-0000000a',
      tabId: 't-000001',
      url: 'https://a/',
      title: null,
      domain: 'a',
      category: 'public' as const,
      ts: NOW,
      sessionSlug: 'shop',
    };
    expect(PageRow.parse(pageToWire(page))).toEqual(pageToWire(page) as never);
    const shot = {
      eventId: call.eventId,
      sessionId: call.sessionId ?? '',
      path: '/x.png',
      kind: 'tool' as const,
      contentType: 'image/png',
      width: 1,
      height: 1,
      sizeBytes: 1,
      ts: NOW,
      tool: null,
    };
    expect(ScreenshotRow.parse(screenshotToWire(shot)).url).toBe(
      `/api/v1/sessions/shop-0000000a/screenshots/${call.eventId}`,
    );
    const blocked = {
      eventId: 'e-00000000000000000000000004',
      sessionId: null,
      toolEventId: null,
      url: 'u',
      domain: null,
      pattern: 'p',
      source: 'tool' as const,
      tool: 'navigate',
      ts: NOW,
      sessionSlug: null,
    };
    expect(BlockedRequestRow.parse(blockedToWire(blocked)).tool).toBe('navigate');
    expect(
      TimelineItem.parse(
        timelineItemToWire({ kind: 'tool', ts: NOW, id: call.eventId, item: call }),
      ).seq,
    ).toBe(7);
  });

  it('vault', () => {
    const binding = {
      handle: 'work.github',
      tenantId: null,
      title: 'T',
      itemName: 'I',
      itemId: 'i',
      groupId: null,
      allowedOrigins: ['https://a'],
      authorizedPrincipals: [],
      authorizedSessionSlugs: ['shop'],
      allowAllSessions: false,
      redactUsername: true,
      requireNoEvaluate: false,
      dashboardConfirm: false,
      version: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(VaultBinding.parse(bindingToWire(binding))).toMatchObject({
      item_name: 'I',
      redact_username: true,
      version: 2,
    });
    const policy = {
      groupKey: '__ungrouped__',
      groupId: null,
      tenantId: null,
      accessMode: 'manual' as const,
      allowAllSessions: false,
      sessionSlugGlobs: [],
      authorizedPrincipals: [],
      dashboardConfirm: true,
      requireNoEvaluate: false,
      redactUsername: false,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(VaultGroupPolicy.parse(policyToWire(policy)).dashboard_confirm).toBe(true);
    const overview = overviewToWire({
      backend: 'bitwarden',
      capabilities: {
        unlock: 'passphrase',
        grouping: true,
        writable: false,
        totp: true,
        sync: true,
      },
      unlock: { required: false, mode: 'passphrase', hint: null },
      unlocked: true,
      bindingsCount: 1,
      policiesCount: 0,
      now: NOW,
    });
    expect(VaultOverview.parse(overview).backend.capabilities.grouping).toBe('flat');
    expect(bindingInputFromWire({ item_name: 'X', allow_all_sessions: true })).toEqual({
      itemName: 'X',
      allowAllSessions: true,
    });
  });

  it('system and notifications', () => {
    const event = {
      seq: 1,
      eventId: 'e-1',
      code: 'X',
      severity: 'warn' as const,
      message: 'm',
      details: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      count: 2,
      resolvedAt: null,
    };
    expect(SystemEvent.parse(systemEventToWire(event)).count).toBe(2);
    const notification = {
      notificationId: 'n-000000000001',
      principalId: null,
      type: 'error' as const,
      title: 't',
      body: null,
      sessionId: null,
      target: null,
      sourceEventId: null,
      createdAt: NOW,
      updatedAt: NOW,
      count: 1,
      groupKey: null,
      readAt: null,
      dismissedAt: null,
    };
    expect(Notification.parse(notificationToWire(notification)).title).toBe('t');
    const bundle = resolveOk({ env: { BROWSERHIVE_AUTH_TOKENS: `bot:${'a'.repeat(32)}` } });
    const keys = configKeysToWire(configView(bundle.config, bundle.provenance));
    for (const key of keys) SystemConfigKey.parse(key);
    const secret = keys.find((k) => k.key === 'authTokens');
    expect(secret).toMatchObject({ secret: true, value: '[REDACTED]', source: 'env' });
  });

  it('envelope echoes applied filters and sort', () => {
    const query = {
      limit: 5,
      dir: 'asc' as const,
      sort: 'ts',
      cursor: 'x',
      total: true,
      state: ['live'],
      q: undefined,
    };
    const body = envelope(
      { items: [1], nextCursor: 'c', total: 1 },
      (n) => n * 2,
      query,
      NOW,
      'created_at',
    );
    expect(body).toEqual({
      data: [2],
      page: { next_cursor: 'c', limit: 5, total: 1 },
      applied: { filters: { state: ['live'] }, sort: { key: 'ts', dir: 'asc' } },
      meta: { now: NOW },
    });
  });
});
