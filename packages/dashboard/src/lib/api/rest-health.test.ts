/** @module lib/api/rest-health.test — REST health follows request outcomes: silence never fails it; network errors, timeouts and daemon 5xx do; 4xx, typed operation failures and realtime cache writes do not; a probe clears a blip (issue #50) */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { AppError, appErrorFromResponse, networkError, timeoutError } from './errors.ts';
import {
  isRestOutage,
  nextRestHealth,
  REST_HEALTH_UNKNOWN,
  type RestHealth,
  watchRestHealth,
} from './rest-health.ts';

const headers = new Headers();
const problem = (status: number, code: string) =>
  appErrorFromResponse(
    status,
    { type: 'about:blank', title: code, status, code, retryable: 'never' },
    headers,
  );

describe('isRestOutage', () => {
  it('counts network errors, timeouts and 5xx that are not the daemon answering', () => {
    expect(isRestOutage(networkError(new TypeError('Failed to fetch')))).toBe(true);
    expect(isRestOutage(timeoutError(10_000))).toBe(true);
    expect(isRestOutage(problem(500, 'INTERNAL_ERROR'))).toBe(true);
    // A proxy in front of a stopped daemon answers 502 with an HTML page.
    expect(isRestOutage(appErrorFromResponse(502, '<html>Bad Gateway</html>', headers))).toBe(true);
    expect(isRestOutage(appErrorFromResponse(504, undefined, headers))).toBe(true);
  });

  it('ignores 4xx, aborts, malformed bodies, typed operation failures and a degraded /health', () => {
    expect(isRestOutage(problem(404, 'NOT_FOUND'))).toBe(false);
    expect(isRestOutage(problem(429, 'RATE_LIMITED'))).toBe(false);
    expect(isRestOutage(problem(502, 'CHANNEL_PLATFORM_ERROR'))).toBe(false);
    expect(isRestOutage(problem(504, 'NAVIGATION_TIMEOUT'))).toBe(false);
    expect(
      isRestOutage(new AppError({ code: 'ABORTED', status: 0, title: 'x', retryable: 'never' })),
    ).toBe(false);
    expect(
      isRestOutage(
        new AppError({ code: 'MALFORMED_RESPONSE', status: 0, title: 'x', retryable: 'never' }),
      ),
    ).toBe(false);
    expect(isRestOutage(appErrorFromResponse(503, { status: 'degraded' }, headers))).toBe(false);
    expect(isRestOutage(new TypeError('a bug in a component'))).toBe(false);
  });
});

describe('nextRestHealth', () => {
  const down = networkError(null);
  it('a failure keeps the last answer time; a success clears it; a 4xx is an answer, not a recovery', () => {
    const failing = nextRestHealth(
      { failure: null, lastAnswerAt: 5 },
      { ok: false, error: down },
      9,
    );
    expect(failing).toEqual({ failure: down, lastAnswerAt: 5 });
    expect(nextRestHealth(failing, { ok: false, error: problem(404, 'NOT_FOUND') }, 12)).toEqual({
      failure: down,
      lastAnswerAt: 12,
    });
    expect(nextRestHealth(failing, { ok: true }, 20)).toEqual({ failure: null, lastAnswerAt: 20 });
  });
});

describe('watchRestHealth', () => {
  afterEach(() => jest.useRealTimers());

  const client = () =>
    new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  function watch(queryClient: QueryClient, probe?: () => Promise<unknown>) {
    const changes: RestHealth[] = [];
    const watcher = watchRestHealth(queryClient, {
      onChange: (h) => changes.push(h),
      ...(probe !== undefined && { probe }),
      probeMs: 1000,
    });
    return { changes, watcher };
  }

  it('stays healthy through five idle minutes after the last answer', async () => {
    jest.useFakeTimers();
    const queryClient = client();
    const { changes, watcher } = watch(queryClient);
    await queryClient.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 });
    jest.advanceTimersByTime(5 * 60_000);
    expect(watcher.current().failure).toBeNull();
    expect(changes).toEqual([]);
    watcher.dispose();
  });

  it('a failed query fails it, a 4xx changes nothing, a later success recovers', async () => {
    const queryClient = client();
    const { changes, watcher } = watch(queryClient);
    const down = networkError(null);
    await queryClient
      .fetchQuery({ queryKey: ['a'], queryFn: () => Promise.reject(down) })
      .catch(() => 0);
    expect(watcher.current().failure).toBe(down);
    await queryClient
      .fetchQuery({ queryKey: ['b'], queryFn: () => Promise.reject(problem(404, 'NOT_FOUND')) })
      .catch(() => 0);
    expect(watcher.current().failure).toBe(down);
    await queryClient.fetchQuery({ queryKey: ['c'], queryFn: async () => 1 });
    expect(watcher.current().failure).toBeNull();
    expect(changes.map((c) => c.failure)).toEqual([down, null]);
    watcher.dispose();
  });

  it('counts failed mutations; ignores realtime cache writes', async () => {
    const queryClient = client();
    const { watcher } = watch(queryClient);
    const down = timeoutError(1);
    await queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => Promise.reject(down) })
      .execute(undefined)
      .catch(() => 0);
    expect(watcher.current().failure).toBe(down);
    queryClient.setQueryData(['ws'], { patched: true });
    expect(watcher.current().failure).toBe(down);
    watcher.dispose();
  });

  it('while failing, probes until the daemon answers (a degraded 503 /health counts)', async () => {
    jest.useFakeTimers();
    const queryClient = client();
    const answers = [
      networkError(null),
      appErrorFromResponse(503, { status: 'degraded' }, headers),
    ];
    let probes = 0;
    const { watcher } = watch(queryClient, () => {
      probes += 1;
      return Promise.reject(answers.shift());
    });
    await queryClient
      .fetchQuery({ queryKey: ['a'], queryFn: () => Promise.reject(networkError(null)) })
      .catch(() => 0);
    expect(probes).toBe(0);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(probes).toBe(1);
    expect(watcher.current().failure).not.toBeNull();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(probes).toBe(2);
    expect(watcher.current().failure).toBeNull();
    jest.advanceTimersByTime(10_000);
    expect(probes).toBe(2);
    watcher.dispose();
  });

  it('starts from what the cache already shows', async () => {
    jest.useFakeTimers();
    const queryClient = client();
    const down = networkError(null);
    await queryClient.fetchQuery({ queryKey: ['a'], queryFn: async () => 1 });
    jest.advanceTimersByTime(10);
    await queryClient
      .fetchQuery({ queryKey: ['b'], queryFn: () => Promise.reject(down) })
      .catch(() => 0);
    const { watcher } = watch(queryClient);
    expect(watcher.current().failure).toBe(down);
    expect(watcher.current().lastAnswerAt).not.toBeNull();
    watcher.dispose();
    expect(watch(client()).watcher.current()).toEqual(REST_HEALTH_UNKNOWN);
  });
});
