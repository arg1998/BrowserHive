/** @module lib/api/rest-health.test — REST health follows request outcomes: silence never fails it; network errors, timeouts and daemon 5xx do; 4xx, typed operation failures and realtime cache writes do not; the watcher (lib/daemon-help/watcher.test) follows the cache and probes (issue #50) */
import { describe, expect, it } from 'bun:test';
import { AppError, appErrorFromResponse, networkError, timeoutError } from './errors.ts';
import { isRestOutage, nextRestHealth } from './rest-health.ts';

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
