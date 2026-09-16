/** @module domain/session/session.test — the Session aggregate: seeding, lease, transitions, attachment, counters, terminal facts. */

import { describe, expect, it } from 'bun:test';
import { FakeSessionHandle } from '../../../test/helpers/fake-session-handle.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { validateCreateRequest } from './create-request.ts';
import { LOCAL_PRINCIPAL } from './principal.ts';
import { Session } from './session.ts';

const WINDOW = 60_000;

function session(): Session {
  const request = validateCreateRequest(
    { slug: 'shop' },
    {
      headless: true,
      channel: 'chromium',
      persistence: 'memory',
      stealth: false,
      fingerprint: false,
      humanize: false,
    },
    LOCAL_PRINCIPAL,
  );
  let n = 0;
  return new Session({
    id: 'shop-00000001',
    request,
    createdAt: 1_000,
    leaseWindowMs: WINDOW,
    tabId: () => `t-${++n}`,
  });
}

describe('Session', () => {
  it('starts reserved with a lease seeded at createdAt + window', () => {
    const s = session();
    expect(s.state).toEqual({ kind: 'reserved', at: 1_000 });
    expect(s.lease).toEqual({ expiresAt: 1_000 + WINDOW, pausedAt: null });
    expect(s.owner).toBe('local');
    expect(s.slug).toBe('shop');
    expect(s.handle).toBeNull();
    expect(s.driver).toBeNull();
    expect(s.identity).toBeNull();
    expect(s.lastToolAt).toBe(1_000);
    expect(s.closedReason).toBeNull();
    expect(s.closedAt).toBeNull();
    expect(s.dead).toBe(false);
  });

  it('touch resets the lease and stamps lastToolAt/lastActivityAt', () => {
    const s = session();
    s.touch(5_000, WINDOW);
    expect(s.lease.expiresAt).toBe(5_000 + WINDOW);
    expect(s.lastToolAt).toBe(5_000);
    expect(s.lastActivityAt).toBe(5_000);
    s.pauseLease(6_000);
    s.touch(7_000, WINDOW);
    expect(s.lease.expiresAt).toBe(5_000 + WINDOW);
    expect(s.lastToolAt).toBe(7_000);
    expect(s.isLeaseExpired(Number.MAX_SAFE_INTEGER)).toBe(false);
    s.resumeLease(100_000);
    expect(s.leaseRemainingMs(100_000)).toBe(5_000 + WINDOW - 6_000);
  });

  it('apply drives the machine and throws typed errors for illegal moves', () => {
    const s = session();
    s.apply({ type: 'launch', phase: 'launch', at: 2_000 });
    s.apply({ type: 'launched', at: 3_000 });
    expect(s.state.kind).toBe('live');
    expect(s.lastActivityAt).toBe(3_000);
    try {
      s.apply({ type: 'resume', at: 4_000 });
      throw new Error('expected throw');
    } catch (err) {
      expect(isAppError(err, 'SESSION_NOT_LIVE')).toBe(true);
      if (isAppError(err, 'SESSION_NOT_LIVE')) {
        expect(err.publicMessage).toBe("Session 'shop-00000001' is not live.");
        expect(err.details).toEqual({ session_id: 'shop-00000001' });
      }
    }
    try {
      s.apply({ type: 'launched', at: 4_000 });
      throw new Error('expected throw');
    } catch (err) {
      expect(isAppError(err, 'INTERNAL_ERROR')).toBe(true);
    }
    expect(s.tryApply({ type: 'closed', at: 1 }).ok).toBe(false);
    expect(s.state.kind).toBe('live');
  });

  it('attach records handle facts and identity; detach drops the handle', () => {
    const s = session();
    const handle = new FakeSessionHandle(s.id, {
      driver: 'patchright',
      identity: {
        userAgent: 'ua',
        brands: [],
        platform: 'Linux',
        deviceMemory: 8,
        chromeMajor: '120',
        geo: null,
        display: null,
      },
    });
    s.attach({ handle, driver: handle.driver, launchedAt: 5_000, launchMs: 4_000 });
    expect(s.handle).toBe(handle);
    expect(s.driver).toBe('patchright');
    expect(s.launchedAt).toBe(5_000);
    expect(s.launchMs).toBe(4_000);
    expect(s.identity?.userAgent).toBe('ua');
    s.setIdentity(null);
    expect(s.identity).toBeNull();
    expect(s.identitySeed).toBe(s.id);
    s.setIdentitySeed('shop-restored1');
    expect(s.identitySeed).toBe('shop-restored1');
    s.setProxyLabel('proxy.example:8080');
    expect(s.proxyLabel).toBe('proxy.example:8080');
    s.detach();
    expect(s.handle).toBeNull();
    expect(s.driver).toBeNull();
  });

  it('counters never go negative; warnings and url are recorded', () => {
    const s = session();
    s.bump('toolCalls');
    s.bump('toolCalls', 2);
    s.bump('errors', -5);
    expect(s.counts.toolCalls).toBe(3);
    expect(s.counts.errors).toBe(0);
    s.addWarning({ code: 'TRACE_START_FAILED', sessionId: s.id, message: 'm' });
    expect(s.warnings).toHaveLength(1);
    s.setCurrentUrl('https://a.test/', 9_000);
    expect(s.currentUrl).toBe('https://a.test/');
    expect(s.lastActivityAt).toBe(9_000);
  });

  it('exposes closedReason/closedAt per terminal state', () => {
    const closed = session();
    closed.apply({ type: 'drain', reason: 'lease_expired', at: 2_000 });
    expect(closed.closedReason).toBe('lease_expired');
    expect(closed.closedAt).toBeNull();
    closed.apply({ type: 'closed', at: 3_000 });
    expect(closed.closedReason).toBe('lease_expired');
    expect(closed.closedAt).toBe(3_000);
    const crashed = session();
    crashed.apply({ type: 'launch', phase: 'launch', at: 1 });
    crashed.apply({ type: 'crash', detail: 'boom', at: 2_500 });
    expect(crashed.dead).toBe(true);
    expect(crashed.closedReason).toBe('crash');
    expect(crashed.closedAt).toBe(2_500);
  });
});
