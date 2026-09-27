/** @module app/sessions/metadata.test — golden SessionMetadata/SessionSummary/SessionRecord projections. */
import { describe, expect, it } from 'bun:test';
import { SessionSummary } from '@browserhive/contracts/http';
import { SessionMetadata } from '@browserhive/contracts/tools';
import { FakeSessionHandle } from '../../../test/helpers/fake-session-handle.ts';
import type { AppliedIdentity, SessionBrowserInfo } from '../../ports/browser-driver.ts';
import {
  configJson,
  toSessionMetadata,
  toSessionPatch,
  toSessionRecord,
  toSessionSummary,
} from './metadata.ts';
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

  describe('the launch record of the browser (D-31)', () => {
    function launched(info?: SessionBrowserInfo) {
      const session = testSession();
      session.apply({ type: 'launch', phase: 'launch', at: T0 + 1 });
      const handle = new FakeSessionHandle(session.id, {
        ...(info !== undefined && { browserInfo: info }),
      });
      session.attach({ handle, driver: 'playwright', launchedAt: T0 + 2, launchMs: 2 });
      session.apply({ type: 'launched', at: T0 + 2 });
      return { session, handle };
    }

    it('a reserved session records nothing and its patch leaves the columns alone', () => {
      const session = testSession();
      const record = toSessionRecord(session);
      expect(record.sandboxed).toBeNull();
      expect(record.browserVersion).toBeNull();
      expect(toSessionPatch(session)).not.toHaveProperty('sandboxed');
      expect(toSessionPatch(session)).not.toHaveProperty('browserVersion');
      expect(toSessionSummary(session, T0)).not.toHaveProperty('browser');
    });

    it('a launched session writes what the handle reported and serves it', () => {
      const { session } = launched({ version: '154.0.8037.57', sandboxed: true });
      expect(toSessionPatch(session)).toMatchObject({
        sandboxed: true,
        browserVersion: '154.0.8037.57',
      });
      const summary = toSessionSummary(session, T0 + 3);
      expect(summary.browser).toEqual({ version: '154.0.8037.57', sandboxed: true });
      expect(SessionSummary.parse(summary)).toEqual(summary);
    });

    it('keeps the record after teardown, so a closed aggregate still serves it', () => {
      const { session } = launched({ version: '153.0.8010.12', sandboxed: false });
      session.apply({ type: 'drain', reason: 'user', at: T0 + 5 });
      session.apply({ type: 'closed', at: T0 + 6 });
      session.detach();
      expect(session.handle).toBeNull();
      expect(toSessionSummary(session, T0 + 7).browser).toEqual({
        version: '153.0.8010.12',
        sandboxed: false,
      });
      expect(toSessionPatch(session)).toMatchObject({
        sandboxed: false,
        browserVersion: '153.0.8010.12',
      });
    });

    it('the latest launch wins', () => {
      const { session } = launched({ version: '153.0.8010.12', sandboxed: false });
      session.attach({
        handle: new FakeSessionHandle(session.id, {
          browserInfo: { version: '154.0.8037.57', sandboxed: true },
        }),
        driver: 'playwright',
        launchedAt: T0 + 9,
        launchMs: 9,
      });
      expect(toSessionPatch(session)).toMatchObject({
        sandboxed: true,
        browserVersion: '154.0.8037.57',
      });
    });

    it('a launch without a readable version records its verdict with a null version', () => {
      const { session } = launched({ version: null, sandboxed: true });
      expect(toSessionPatch(session)).toMatchObject({ sandboxed: true, browserVersion: null });
      expect(toSessionSummary(session, T0 + 3).browser).toEqual({ version: null, sandboxed: true });
    });

    it('a driver that reports nothing records nothing', () => {
      const { session } = launched();
      expect(toSessionPatch(session)).not.toHaveProperty('sandboxed');
      expect(toSessionSummary(session, T0 + 3)).not.toHaveProperty('browser');
    });
  });
});
