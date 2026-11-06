/** @module lib/daemon-help/watcher.test — the reachability watcher (04 §6.1, §18.7): REST health from how requests ended, 15 s rechecks while REST fails that never count toward the banner, the 5 s outage cadence from the socket's first `offline`, the banner after 3 consecutive failures with the 15 s gap reset, and hiding on any daemon answer */
import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { appErrorFromResponse, networkError, timeoutError } from '@/lib/api/errors.ts';
import { manualTimers } from '../../../test/helpers/manual-timers.ts';
import { PROBE_TIMEOUT_MS } from './probe.ts';
import {
  BANNER_AFTER_PROBES,
  DaemonReachability,
  OUTAGE_GAP_RESET_MS,
  OUTAGE_PROBE_MS,
} from './watcher.ts';

type Answer = 'refused' | 'hang' | 'marked' | 'marked-503' | 'proxy-502';

function response(answer: Answer): Promise<Response> {
  switch (answer) {
    case 'refused':
      return Promise.reject(new TypeError('Failed to fetch'));
    case 'hang':
      return new Promise<Response>(() => undefined);
    case 'marked':
      return Promise.resolve(
        new Response('{"status":"ready","version":"1.0.0"}', {
          headers: { 'x-browserhive-version': '1.0.0' },
        }),
      );
    case 'marked-503':
      return Promise.resolve(
        new Response('{"status":"degraded","version":"1.0.0"}', {
          status: 503,
          headers: { 'x-browserhive-version': '1.0.0' },
        }),
      );
    case 'proxy-502':
      return Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }));
  }
}

function setup(options: { answer?: Answer; online?: boolean } = {}) {
  const timers = manualTimers(1_000_000);
  let skew = 0;
  const env = { answer: options.answer ?? 'refused', online: options.online ?? true };
  const starts: number[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const watcher = new DaemonReachability({
    client,
    timers,
    clock: () => timers.clock() + skew,
    wallClock: () => timers.clock() + skew,
    online: () => env.online,
    fetch: (input) => {
      expect(input).toBe('/health');
      starts.push(timers.clock() + skew);
      return response(env.answer);
    },
  });
  watcher.start();
  return {
    client,
    watcher,
    timers,
    env,
    starts,
    /** Moves the watcher's clock without firing timers (sleep, a throttled tab). */
    jump: (ms: number) => {
      skew += ms;
    },
    banner: () => watcher.getSnapshot().banner,
    failure: () => watcher.getSnapshot().restFailure,
  };
}

const failQuery = (client: QueryClient, error: unknown, key = 'a') =>
  client.fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(error) }).catch(() => 0);

describe('DaemonReachability: REST health (§6.1)', () => {
  it('stays healthy through five idle minutes after the last answer, and never probes', async () => {
    const t = setup();
    await t.client.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 });
    await t.timers.advance(5 * 60_000);
    expect(t.failure()).toBeNull();
    expect(t.watcher.lastAnswerAt()).not.toBeNull();
    expect(t.starts).toEqual([]);
  });

  it('a failed query fails it, a 4xx changes nothing, a later success recovers', async () => {
    const t = setup();
    const down = networkError(null);
    await failQuery(t.client, down);
    expect(t.failure()).toBe(down);
    await failQuery(
      t.client,
      appErrorFromResponse(
        404,
        { type: 'about:blank', title: 'x', status: 404, code: 'NOT_FOUND', retryable: 'never' },
        new Headers(),
      ),
      'b',
    );
    expect(t.failure()).toBe(down);
    await t.client.fetchQuery({ queryKey: ['c'], queryFn: async () => 1 });
    expect(t.failure()).toBeNull();
  });

  it('counts failed mutations; ignores realtime cache writes', async () => {
    const t = setup();
    const down = timeoutError(1);
    await t.client
      .getMutationCache()
      .build(t.client, { mutationFn: () => Promise.reject(down) })
      .execute(undefined)
      .catch(() => 0);
    expect(t.failure()).toBe(down);
    t.client.setQueryData(['ws'], { patched: true });
    expect(t.failure()).toBe(down);
  });

  it('while failing, rechecks /health every 15 s until the daemon answers (a marked 503 counts)', async () => {
    const t = setup({ answer: 'proxy-502' });
    await failQuery(t.client, networkError(null));
    await t.timers.advance(14_999);
    expect(t.starts.length).toBe(0);
    await t.timers.advance(1);
    expect(t.starts.length).toBe(1);
    // A proxy's unmarked 502 is not the daemon: still failing.
    expect(t.failure()).not.toBeNull();
    t.env.answer = 'marked-503';
    await t.timers.advance(15_000);
    expect(t.starts.length).toBe(2);
    expect(t.failure()).toBeNull();
    await t.timers.advance(60_000);
    expect(t.starts.length).toBe(2);
  });

  it('starts from what the cache already shows', async () => {
    const timers = manualTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const down = networkError(null);
    await failQuery(client, down, 'b');
    const watcher = new DaemonReachability({ client, timers, clock: timers.clock });
    watcher.start();
    expect(watcher.getSnapshot().restFailure).toBe(down);
    expect(watcher.lastAnswerAt()).not.toBeNull();
    watcher.stop();
  });

  it('REST rechecks never count toward the banner', async () => {
    const t = setup({ answer: 'refused' });
    await failQuery(t.client, networkError(null));
    await t.timers.advance(15_000 * 6);
    expect(t.starts.length).toBe(6);
    expect(t.banner()).toBeNull();
  });
});

describe('DaemonReachability: outage cadence and banner (§18.7)', () => {
  it('probes at once on the first offline, then every 5 s; the banner shows after the third failure', async () => {
    expect([OUTAGE_PROBE_MS, BANNER_AFTER_PROBES, OUTAGE_GAP_RESET_MS]).toEqual([5_000, 3, 15_000]);
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('connecting', null);
    expect(t.starts.length).toBe(0);
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(0);
    expect(t.starts.length).toBe(1);
    await t.timers.advance(5_000);
    expect(t.starts.length).toBe(2);
    expect(t.banner()).toBeNull();
    await t.timers.advance(5_000);
    expect(t.starts.length).toBe(3);
    expect(t.banner()).toBe('not-running');
    // The socket store reporting offline again (each retry) does not restart the cadence.
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(5_000);
    expect(t.starts.length).toBe(4);
    expect(t.starts.slice(1).map((at, i) => at - (t.starts[i] ?? 0))).toEqual([
      5_000, 5_000, 5_000,
    ]);
  });

  it('a hung daemon: one probe at a time, each timing out, and the banner says not-responding', async () => {
    const t = setup({ answer: 'hang' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(PROBE_TIMEOUT_MS * 3 - 1);
    expect(t.starts.length).toBe(3);
    expect(t.banner()).toBeNull();
    await t.timers.advance(1);
    expect(t.banner()).toBe('not-responding');
  });

  it('counts a proxy whose upstream is down', async () => {
    const t = setup({ answer: 'proxy-502' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(10_000);
    expect(t.banner()).toBe('proxy-unreachable');
  });

  it('a gap over 15 s between probes (sleep, a throttled tab) restarts the count', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(5_000);
    expect(t.starts.length).toBe(2);
    t.jump(OUTAGE_GAP_RESET_MS + 1);
    await t.timers.advance(5_000);
    expect(t.starts.length).toBe(3);
    // Two failures before the gap, one after: no banner.
    expect(t.banner()).toBeNull();
    await t.timers.advance(5_000);
    expect(t.banner()).toBeNull();
    await t.timers.advance(5_000);
    expect(t.banner()).toBe('not-running');
  });

  it('a probe that is not a counted failure breaks the streak', async () => {
    const t = setup({ answer: 'refused', online: false });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(15_000);
    expect(t.starts.length).toBe(4);
    expect(t.banner()).toBeNull();
    t.env.online = true;
    await t.timers.advance(10_000);
    expect(t.banner()).toBeNull();
    await t.timers.advance(5_000);
    expect(t.banner()).toBe('not-running');
    // Once shown, it follows the latest probe.
    t.env.online = false;
    await t.timers.advance(5_000);
    expect(t.banner()).toBe('device-offline');
  });

  it('hides on a marked probe answer and stops probing', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(10_000);
    expect(t.banner()).toBe('not-running');
    t.env.answer = 'marked-503';
    await t.timers.advance(5_000);
    expect(t.banner()).toBeNull();
    const probes = t.starts.length;
    await t.timers.advance(60_000);
    expect(t.starts.length).toBe(probes);
  });

  it('hides when the socket connects again', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(10_000);
    expect(t.banner()).toBe('not-running');
    t.watcher.socketChanged('connected', null);
    expect(t.banner()).toBeNull();
    const probes = t.starts.length;
    await t.timers.advance(60_000);
    expect(t.starts.length).toBe(probes);
  });

  it('hides on a successful REST request', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(10_000);
    expect(t.banner()).toBe('not-running');
    await t.client.fetchQuery({ queryKey: ['ok'], queryFn: async () => 1 });
    expect(t.banner()).toBeNull();
  });

  it('a REST failure during the outage does not start a second poller', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(0);
    await failQuery(t.client, networkError(null));
    await t.timers.advance(15_000);
    expect(t.starts.length).toBe(4);
  });

  it('offline for a reason other than the network (signed out, protocol) is no outage', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'unauthorized');
    await t.timers.advance(30_000);
    expect(t.starts).toEqual([]);
  });

  it('notifies subscribers once per visible change, not per request', async () => {
    const t = setup({ answer: 'refused' });
    let calls = 0;
    t.watcher.subscribe(() => {
      calls += 1;
    });
    await failQuery(t.client, networkError(null));
    expect(calls).toBe(1);
    await t.client.fetchQuery({ queryKey: ['b'], queryFn: async () => 1 });
    await t.client.fetchQuery({ queryKey: ['c'], queryFn: async () => 1 });
    expect(calls).toBe(2);
  });

  it('stop() cancels the schedule', async () => {
    const t = setup({ answer: 'refused' });
    t.watcher.socketChanged('offline', 'network');
    await t.timers.advance(0);
    t.watcher.stop();
    await t.timers.advance(60_000);
    expect(t.starts.length).toBe(1);
  });
});
