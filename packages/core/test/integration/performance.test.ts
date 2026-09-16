/** @module test/integration/performance — 10 parallel sessions launch through the tools, each serves a navigation, isolation holds under load. Skip with BROWSERHIVE_SKIP_LOAD_TEST=1. */

import { describe, expect, it } from 'bun:test';
import { useMcpStack } from './mcp-fixture.ts';

const SESSION_COUNT = 10;
const SKIP = process.env['BROWSERHIVE_SKIP_LOAD_TEST'] === '1';

describe.skipIf(SKIP)('performance under load (real Chromium)', () => {
  const { state } = useMcpStack({ maxSessions: SESSION_COUNT });

  it(`stands up ${SESSION_COUNT} parallel isolated sessions and serves a tool on each`, async () => {
    const h = state.harness;
    const started = performance.now();
    const ids = await Promise.all(
      Array.from({ length: SESSION_COUNT }, (_, i) => h.launch({ slug: `load-${i}` })),
    );
    const launchMs = performance.now() - started;
    expect(new Set(ids).size).toBe(SESSION_COUNT);
    const urls = await Promise.all(
      ids.map((id) =>
        h.callJson<{ url: string }>('navigate', { session_id: id, url: state.fixture.url('/') }),
      ),
    );
    for (const { url } of urls) expect(url.startsWith(state.fixture.origin)).toBe(true);
    const status = await h.callJson<{ sessions: { count: number; limit: number } }>(
      'server_status',
    );
    expect(status.sessions).toEqual({ count: SESSION_COUNT, limit: SESSION_COUNT });
    await h.callJson('evaluate', {
      session_id: ids[0],
      expression: "() => localStorage.setItem('canary', 'load-0')",
    });
    const leaked = await Promise.all(
      ids.slice(1).map((id) =>
        h.callJson<{ result: string | null }>('evaluate', {
          session_id: id,
          expression: "() => localStorage.getItem('canary')",
        }),
      ),
    );
    for (const { result } of leaked) expect(result).toBeNull();
    const over = await h.call('launch_session', { slug: 'overflow' });
    expect(over.isError).toBe(true);
    expect(launchMs).toBeGreaterThan(0);
  }, 120_000);
});
