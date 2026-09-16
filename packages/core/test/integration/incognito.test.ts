/** @module test/integration/incognito — a relaunched session under the same slug starts with clean storage. */

import { describe, expect, it } from 'bun:test';
import { useMcpStack } from './mcp-fixture.ts';

describe('incognito / fresh-session storage (real Chromium)', () => {
  const { state } = useMcpStack();

  it('a new session starts with clean localStorage', async () => {
    const h = state.harness;
    const get = "() => window.localStorage.getItem('foo')";
    const first = await h.launch({ slug: 'incog', channel: 'chromium', incognito: true });
    await h.callJson('navigate', { session_id: first, url: state.fixture.url('/') });
    expect(
      (
        await h.callJson<{ result: string | null }>('evaluate', {
          session_id: first,
          expression: get,
        })
      ).result,
    ).toBeNull();
    await h.callJson('evaluate', {
      session_id: first,
      expression: "() => window.localStorage.setItem('foo', 'bar')",
    });
    expect(
      (await h.callJson<{ result: string }>('evaluate', { session_id: first, expression: get }))
        .result,
    ).toBe('bar');
    expect(
      (await h.callJson<{ closed: boolean }>('close_session', { session_id: first })).closed,
    ).toBe(true);
    const second = await h.launch({ slug: 'incog', channel: 'chromium', incognito: true });
    await h.callJson('navigate', { session_id: second, url: state.fixture.url('/') });
    expect(
      (
        await h.callJson<{ result: string | null }>('evaluate', {
          session_id: second,
          expression: get,
        })
      ).result,
    ).toBeNull();
  });
});
