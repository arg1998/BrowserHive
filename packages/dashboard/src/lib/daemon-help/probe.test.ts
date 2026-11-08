/** @module lib/daemon-help/probe.test — `probeHealth` (request shape, timeout, timer cleanup), `isDaemonAnswer`, and every row of the `classifyProbe` table (04 §18.6.1) */
import { describe, expect, it } from 'bun:test';
import { HealthResponse, HealthStatus } from '@browserhive/contracts/http';
import { FakeTimers } from '../../../test/helpers/fake-socket.ts';
import {
  classifyProbe,
  HEALTH_PATH,
  isBrowserHiveHealth,
  isDaemonAnswer,
  MARKER_HEADER,
  PROBE_TIMEOUT_MS,
  type ProbeFetch,
  type ProbeOutcome,
  type ProbeState,
  probeHealth,
} from './probe.ts';

const ONLINE = { online: true };
const OFFLINE = { online: false };

function answer(status: number, marked: boolean, body: unknown): ProbeOutcome {
  return { kind: 'response', status, marked, body };
}

function health(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status,
    phase: status === 'stopping' ? 'stopping' : 'ready',
    version: '0.2.2',
    uptime_ms: 1_000,
    checks: { db: 'ok', browser: 'ok', listeners: 'ok' },
    ...extra,
  };
}

/** Lets the probe's internal awaits run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('probeHealth', () => {
  it('fetches /health with cache no-store and reports status, marker and JSON body', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetch: ProbeFetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json(health('ready'), { headers: { [MARKER_HEADER]: '0.2.2' } });
    };
    const timers = new FakeTimers();
    const outcome = await probeHealth({ fetch, timers });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(HEALTH_PATH);
    expect(calls[0]?.init.cache).toBe('no-store');
    expect(outcome).toEqual(answer(200, true, health('ready')));
    expect(timers.pending()).toEqual([]);
  });

  it('a non-JSON body is undefined; an unmarked response is not marked', async () => {
    const fetch: ProbeFetch = async () =>
      new Response('<html>Bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      });
    expect(await probeHealth({ fetch, timers: new FakeTimers() })).toEqual(
      answer(502, false, undefined),
    );
  });

  it('a rejected fetch is `rejected` and clears the timer', async () => {
    const timers = new FakeTimers();
    const fetch: ProbeFetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await probeHealth({ fetch, timers })).toEqual({ kind: 'rejected' });
    expect(timers.pending()).toEqual([]);
  });

  it('times out after 5 s, aborts the request, and ignores a late answer', async () => {
    const timers = new FakeTimers();
    let signal: AbortSignal | undefined;
    let answerLate: ((response: Response) => void) | undefined;
    const fetch: ProbeFetch = (_input, init) => {
      signal = init.signal ?? undefined;
      return new Promise((resolve) => {
        answerLate = resolve;
      });
    };
    const pending = probeHealth({ fetch, timers });
    expect(timers.pending()).toEqual([PROBE_TIMEOUT_MS]);
    timers.advance(PROBE_TIMEOUT_MS - 1);
    await flush();
    timers.advance(1);
    expect(await pending).toEqual({ kind: 'timeout' });
    expect(signal?.aborted).toBe(true);
    answerLate?.(Response.json(health('ready')));
    await flush();
    expect(timers.pending()).toEqual([]);
  });

  it('a body that never finishes counts as a timeout', async () => {
    const timers = new FakeTimers();
    const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetch: ProbeFetch = async () =>
      new Response(stalled, { status: 200, headers: { [MARKER_HEADER]: '1' } });
    const pending = probeHealth({ fetch, timers });
    await flush();
    timers.advance(PROBE_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: 'timeout' });
  });

  it('uses the global fetch by default, read at call time', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        seen.push(String(input));
        return new Response('starting', { status: 503, headers: { [MARKER_HEADER]: '1' } });
      },
      { preconnect: original.preconnect },
    );
    try {
      expect(await probeHealth({ timers: new FakeTimers() })).toEqual(answer(503, true, undefined));
      expect(seen).toEqual(['/health']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('isDaemonAnswer', () => {
  it('is true only for marked responses, healthy or not', () => {
    expect(isDaemonAnswer(answer(200, true, health('ready')))).toBe(true);
    expect(isDaemonAnswer(answer(503, true, 'starting'))).toBe(true);
    expect(isDaemonAnswer(answer(421, true, { code: 'HOST_NOT_ALLOWED' }))).toBe(true);
    // A malformed but marked 200 still proves the daemon answered (04 §18.7).
    expect(isDaemonAnswer(answer(200, true, undefined))).toBe(true);
    expect(isDaemonAnswer(answer(200, false, health('ready')))).toBe(false);
    expect(isDaemonAnswer(answer(502, false, undefined))).toBe(false);
    expect(isDaemonAnswer({ kind: 'rejected' })).toBe(false);
    expect(isDaemonAnswer({ kind: 'timeout' })).toBe(false);
  });
});

describe('classifyProbe (04 §18.6.1)', () => {
  it.each([
    ['rejected, online', { kind: 'rejected' }, ONLINE, 'not-running'],
    ['rejected, navigator.onLine false', { kind: 'rejected' }, OFFLINE, 'device-offline'],
    ['timed out', { kind: 'timeout' }, ONLINE, 'not-responding'],
    ['timed out while offline', { kind: 'timeout' }, OFFLINE, 'not-responding'],
    ['BrowserHive ready', answer(200, true, health('ready')), ONLINE, 'ready'],
    ['BrowserHive degraded (503)', answer(503, true, health('degraded')), ONLINE, 'ready'],
    ['BrowserHive starting', answer(503, true, health('starting')), ONLINE, 'starting'],
    ['BrowserHive stopping', answer(503, true, health('stopping')), ONLINE, 'not-running'],
    [
      'an unmarked BrowserHive body (older daemon)',
      answer(200, false, health('ready')),
      ONLINE,
      'ready',
    ],
    ['marked plain-text 503 (pre-app fallback)', answer(503, true, undefined), ONLINE, 'starting'],
    [
      'marked 421 HOST_NOT_ALLOWED',
      answer(421, true, { code: 'HOST_NOT_ALLOWED' }),
      ONLINE,
      'refused',
    ],
    ['marked 404 problem', answer(404, true, { code: 'NOT_FOUND' }), ONLINE, 'refused'],
    ['marked 200 not a health body', answer(200, true, { ok: true }), ONLINE, 'refused'],
    ['unmarked 502 HTML', answer(502, false, undefined), ONLINE, 'proxy-unreachable'],
    ['unmarked 503', answer(503, false, undefined), ONLINE, 'proxy-unreachable'],
    ['unmarked 504', answer(504, false, undefined), ONLINE, 'proxy-unreachable'],
    ['unmarked 530 (Cloudflare)', answer(530, false, undefined), ONLINE, 'proxy-unreachable'],
    ['unmarked 200 non-BrowserHive JSON', answer(200, false, { status: 'ok' }), ONLINE, 'foreign'],
    ['unmarked 404 HTML', answer(404, false, undefined), ONLINE, 'foreign'],
    ['unmarked 302', answer(302, false, undefined), ONLINE, 'foreign'],
  ] as const)('%s → %s', (_label, outcome, context, state) => {
    expect(classifyProbe(outcome, context)).toBe(state);
  });

  it('a BrowserHive body without instance_id (older daemons) is recognised', () => {
    const body = health('ready');
    expect('instance_id' in body).toBe(false);
    expect(isBrowserHiveHealth(body)).toBe(true);
    expect(classifyProbe(answer(200, true, body), ONLINE)).toBe('ready');
  });

  it('recognises every HealthResponse fixture: each status, with and without instance_id', () => {
    const expected: Readonly<Record<HealthStatus, ProbeState>> = {
      starting: 'starting',
      ready: 'ready',
      degraded: 'ready',
      stopping: 'not-running',
    };
    for (const status of HealthStatus.options) {
      for (const extra of [{}, { instance_id: 'inst-1' }]) {
        const fixture = HealthResponse.parse(health(status, extra));
        expect(isBrowserHiveHealth(fixture)).toBe(true);
        expect({ status, state: classifyProbe(answer(200, true, fixture), ONLINE) }).toEqual({
          status,
          state: expected[status],
        });
      }
    }
  });

  it('the hand-written check rejects near misses', () => {
    expect(isBrowserHiveHealth(null)).toBe(false);
    expect(isBrowserHiveHealth([health('ready')])).toBe(false);
    expect(isBrowserHiveHealth({ status: 'ready' })).toBe(false);
    expect(isBrowserHiveHealth({ status: 'ready', version: 2 })).toBe(false);
    expect(isBrowserHiveHealth({ status: 'ok', version: '1.0.0' })).toBe(false);
    expect(isBrowserHiveHealth({ status: 'ready', version: '1.0.0' })).toBe(true);
  });
});
