/** @module app/sessions/metadata.test — golden SessionMetadata/SessionSummary/SessionRecord projections. */
import { describe, expect, it } from 'bun:test';
import { SessionSummary } from '@browserhive/contracts/http';
import { SessionMetadata } from '@browserhive/contracts/tools';
import type { AppliedIdentity } from '../../ports/browser-driver.ts';
import { configJson, toSessionMetadata, toSessionRecord, toSessionSummary } from './metadata.ts';
import { testSession } from './test-support.ts';

const T0 = 1_700_000_000_000;

const identity: AppliedIdentity = {
  userAgent: 'Mozilla/5.0 Chrome/131.0.0.0',
  brands: [{ brand: 'Chromium', version: '131' }],
  platform: 'Linux',
  deviceMemory: 8,
  chromeMajor: '131',
  geo: {
    locale: 'en-US',
    languages: ['en-US', 'en'],
    countryCode: 'US',
    timezoneId: 'UTC',
    source: 'host',
  },
  display: {
    screen: { width: 1920, height: 1080 },
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  },
};

describe('session metadata projections', () => {
  it('golden: launch_session metadata for a fixed session', () => {
    const session = testSession({
      request: {
        stealth: true,
        fingerprint: true,
        humanize: false,
        launchOptions: { proxy: { server: 'http://u:p@proxy.example:8080' } },
      },
    });
    session.setIdentity(identity);
    session.setProxyLabel('proxy.example:8080');
    const metadata = toSessionMetadata(session);
    expect(metadata).toEqual({
      session_id: 'shop-00000001',
      slug: 'shop',
      channel: 'chromium',
      incognito: false,
      headless: true,
      persistence_mode: 'memory',
      current_url: null,
      created_at: T0,
      owner: 'local',
      lease_expires_at: T0 + 7_200_000,
      lease_paused_at: null,
      disable_evaluate: false,
      vault_enabled: true,
      stealth: true,
      fingerprint: true,
      humanize: false,
      identity: {
        userAgent: 'Mozilla/5.0 Chrome/131.0.0.0',
        brands: [{ brand: 'Chromium', version: '131' }],
        platform: 'Linux',
        deviceMemory: 8,
        chromeMajor: '131',
        geo: {
          locale: 'en-US',
          languages: ['en-US', 'en'],
          countryCode: 'US',
          timezoneId: 'UTC',
          source: 'host',
        },
        display: {
          screen: { width: 1920, height: 1080 },
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor: 1,
        },
      },
      proxy_label: 'proxy.example:8080',
      driver: null,
    });
    // The contracts schema accepts it (driver is an extra key and is stripped).
    expect(SessionMetadata.parse(metadata)).not.toHaveProperty('driver');
  });

  it('summary satisfies the HTTP/WS schema and reports lease remaining / live flags', () => {
    const session = testSession();
    session.apply({ type: 'launch', phase: 'launch', at: T0 + 1 });
    session.apply({ type: 'launched', at: T0 + 2 });
    session.touch(T0 + 1000, 7_200_000);
    const summary = toSessionSummary(session, T0 + 2000);
    expect(SessionSummary.parse(summary)).toEqual(summary);
    expect(summary.state).toBe('live');
    expect(summary.live).toBe(true);
    expect(summary.lease_remaining_ms).toBe(7_200_000 - 1000);
    expect(summary.last_activity_at).toBe(T0 + 1000);
    expect(summary.stealth_recorded).toBe(false);
    expect(summary.counts).toEqual({
      tool_calls: 0,
      errors: 0,
      pages: 0,
      blocked: 0,
      attention_open: 0,
      vault_access: 0,
    });
  });

  it('record snapshot redacts secrets in the launch config and mirrors the state', () => {
    const session = testSession({
      request: { launchOptions: { proxy: { server: 'http://proxy', password: 'hunter2' } } },
    });
    const record = toSessionRecord(session);
    expect(record.state).toBe('reserved');
    expect(record.config['slug']).toBe('shop');
    expect(JSON.stringify(configJson(session))).not.toContain('hunter2');
    expect(record.closedAt).toBeNull();
    session.apply({ type: 'drain', reason: 'user', at: T0 + 5 });
    session.apply({ type: 'closed', at: T0 + 6 });
    const closed = toSessionRecord(session);
    expect(closed.closedReason).toBe('user');
    expect(closed.closedAt).toBe(T0 + 6);
  });
});
