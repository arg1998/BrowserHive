/** @module lib/status-registry.test — every contracts enum value has a registry entry (spec 04 §14) */

import { describe, expect, it } from 'bun:test';
import {
  BlockedSource,
  ClosedReason,
  LogLevel,
  NotificationType,
  OperatorRequestStatus,
  SessionStatus,
  UrlCategory,
} from '@browserhive/contracts/enums';
import { OriginCheck, type SessionSummary, VaultAccessResult } from '@browserhive/contracts/http';
import {
  BLOCKED_SOURCE,
  CLOSED_REASON_STATE,
  LOG_LEVEL,
  leaseTone,
  NOTIFICATION_TYPE,
  ORIGIN_CHECK,
  REQUEST_STATUS,
  SESSION_STATE,
  sessionDisplayState,
  statusEntry,
  URL_CATEGORY,
  VAULT_RESULT,
} from './status-registry.ts';

const TONES = new Set(['accent', 'success', 'warn', 'danger', 'vault', 'info', 'neutral', 'muted']);

function expectCovers(
  registry: Record<string, { label: string; tone: string }>,
  values: readonly string[],
) {
  for (const value of values) {
    const entry = registry[value];
    expect(entry, `missing ${value}`).toBeDefined();
    expect(entry?.label.length).toBeGreaterThan(0);
    expect(TONES.has(entry?.tone ?? '')).toBe(true);
  }
}

describe('status registry', () => {
  it('covers every enum value', () => {
    expectCovers(SESSION_STATE, SessionStatus.options);
    expectCovers(REQUEST_STATUS, OperatorRequestStatus.options);
    expectCovers(VAULT_RESULT, VaultAccessResult.options);
    expectCovers(ORIGIN_CHECK, OriginCheck.options);
    expectCovers(URL_CATEGORY, UrlCategory.options);
    expectCovers(BLOCKED_SOURCE, BlockedSource.options);
    expectCovers(NOTIFICATION_TYPE, NotificationType.options);
    expectCovers(LOG_LEVEL, LogLevel.options);
    for (const reason of ClosedReason.options)
      expect(SESSION_STATE[CLOSED_REASON_STATE[reason]]).toBeDefined();
  });

  it('keeps the URL category hints exact', () => {
    expect(URL_CATEGORY.ip.hint).toBe('addressed a host by raw IP, not a domain');
    expect(URL_CATEGORY.local.hint).toBe('file://, localhost, loopback');
    expect(URL_CATEGORY.other.hint).toBe('data:, blob:, chrome:, about:, …');
  });

  it('derives the display state of a session', () => {
    const base = {
      archived_at: null,
      state: 'live',
      closed_reason: null,
      has_live_viewers: false,
      counts: { attention_open: 0 },
    } as unknown as SessionSummary;
    expect(sessionDisplayState(base)).toBe('live');
    expect(sessionDisplayState({ ...base, has_live_viewers: true })).toBe('streaming');
    expect(sessionDisplayState({ ...base, counts: { ...base.counts, attention_open: 1 } })).toBe(
      'attention',
    );
    expect(sessionDisplayState({ ...base, state: 'closed', closed_reason: 'lease_expired' })).toBe(
      'lease_expired',
    );
    expect(sessionDisplayState({ ...base, state: 'closed', closed_reason: 'crash' })).toBe(
      'crashed',
    );
    expect(sessionDisplayState({ ...base, archived_at: 1 })).toBe('archived');
  });

  it('looks up entries by domain and applies lease thresholds', () => {
    expect(statusEntry('request', 'pending').tone).toBe('warn');
    expect(leaseTone(60_000)).toBe('danger');
    expect(leaseTone(5 * 60_000)).toBe('warn');
    expect(leaseTone(30 * 60_000)).toBe('neutral');
  });
});
