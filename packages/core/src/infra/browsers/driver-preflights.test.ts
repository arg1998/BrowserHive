/** @module infra/browsers/driver-preflights.test — the driver hook's checks without a browser (D-66, review F1): the verified `_onRequest` source, and a preflight of a hooked context never handed back to the driver. */

import { afterEach, describe, expect, it } from 'bun:test';
import { isVerifiedOnRequest, PREFLIGHT_BRANCH_MARKERS, takeOver } from './driver-preflights.ts';
import { PreflightCache } from './preflight-cache.ts';
import {
  preflightEnforcement,
  resetPreflightEnforcementForTests,
  sharedPreflightState,
} from './preflight-enforcement.ts';
import type { PreflightHook } from './preflight-relay.ts';

afterEach(() => resetPreflightEnforcementForTests());

describe('isVerifiedOnRequest', () => {
  it("accepts the driver's 4-parameter _onRequest holding the preflight branch, nothing else", () => {
    const verified = new Function(
      'a',
      'b',
      'c',
      'd',
      `if (d.request.method === "OPTIONS" && b.initiator.type === "preflight" && x.needsRequestInterception()) {
        s.send("Fetch.fulfillRequest"); s.send("Fetch.continueRequest"); }`,
    );
    expect(isVerifiedOnRequest(verified)).toBe(true);
    // The preflight branch moved elsewhere: same signature, but wrapping it would enforce nothing.
    const moved = new Function('a', 'b', 'c', 'd', 'return this._other(a, b, c, d);');
    expect(isVerifiedOnRequest(moved)).toBe(false);
    for (const marker of PREFLIGHT_BRANCH_MARKERS) {
      const missing = new Function(
        'a',
        'b',
        'c',
        'd',
        PREFLIGHT_BRANCH_MARKERS.filter((m) => m !== marker).join(';'),
      );
      expect([marker, isVerifiedOnRequest(missing)]).toEqual([marker, false]);
    }
    expect(isVerifiedOnRequest(new Function('a', PREFLIGHT_BRANCH_MARKERS.join(';')))).toBe(false);
    expect(isVerifiedOnRequest('not a function')).toBe(false);
  });
});

describe('takeOver', () => {
  /** A driver session recording what is sent to it. */
  function session() {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    return {
      sent,
      _sendMayFail: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params });
      },
      on: () => undefined,
    };
  }

  const context = {};
  const hook: PreflightHook = {
    decide: async () => ({ kind: 'continue' }),
    cache: new PreflightCache({ now: () => 0 }),
  };
  const manager = (ctx: object) => ({
    _page: { browserContext: ctx, mainFrame: () => ({ url: () => 'https://site.test/' }) },
    _alreadyTrackedNetworkIds: new Set<string>(),
  });
  const args = (
    s: ReturnType<typeof session>,
    over: { method?: string; initiator?: string; pausedId?: unknown } = {},
  ) => [
    { session: s },
    { requestId: 'net-1', initiator: { type: over.initiator ?? 'preflight' } },
    { session: s },
    {
      requestId: 'pausedId' in over ? over.pausedId : 'fetch-1',
      request: {
        method: over.method ?? 'OPTIONS',
        url: 'https://api.test/w',
        headers: { Origin: 'https://site.test', 'Access-Control-Request-Method': 'POST' },
      },
    },
  ];

  it('leaves everything but a preflight of a hooked context to the driver', () => {
    const s = session();
    sharedPreflightState().hooks.set(context, hook);
    // A page's own OPTIONS (initiator `script`) goes through the route like any request (review M8).
    expect(takeOver(manager(context), args(s, { initiator: 'script' }))).toBe(false);
    expect(takeOver(manager(context), args(s, { method: 'POST' }))).toBe(false);
    expect(takeOver(manager({}), args(s))).toBe(false);
    expect(takeOver(manager(context), [args(s)[0], args(s)[1], undefined, undefined])).toBe(false);
    expect(s.sent).toEqual([]);
    expect(preflightEnforcement().state).toBe('pending');
  });

  it('continues a readable preflight of a hooked context to the network', async () => {
    const s = session();
    sharedPreflightState().hooks.set(context, hook);
    expect(takeOver(manager(context), args(s))).toBe(true);
    await Bun.sleep(0);
    expect(s.sent.map((c) => c.method)).toEqual(['Fetch.continueRequest']);
  });

  it('fails a preflight of a hooked context it cannot read and refuses enforcement (never the driver)', () => {
    const s = session();
    sharedPreflightState().hooks.set(context, hook);
    const broken = args(s);
    (broken[1] as Record<string, unknown>)['requestId'] = 42;
    expect(takeOver(manager(context), broken)).toBe(true);
    expect(s.sent).toEqual([
      { method: 'Fetch.failRequest', params: { requestId: 'fetch-1', errorReason: 'Failed' } },
    ]);
    expect(preflightEnforcement()).toMatchObject({
      state: 'refused',
      reason: 'unexpected_preflight',
    });
  });

  it('when even the paused request cannot be failed, refuses enforcement so the chain fails closed', () => {
    const s = session();
    sharedPreflightState().hooks.set(context, hook);
    expect(takeOver(manager(context), args(s, { pausedId: 7 }))).toBe(false);
    expect(s.sent).toEqual([]);
    expect(preflightEnforcement().state).toBe('refused');
  });
});
