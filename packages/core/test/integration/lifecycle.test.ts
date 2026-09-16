/** @module test/integration/lifecycle — launch / list / close cycle through the tools against real Chromium. */

import { describe, expect, it } from 'bun:test';
import { useMcpStack } from './mcp-fixture.ts';

describe('session lifecycle (real Chromium)', () => {
  const { state } = useMcpStack();

  it('launch + navigate + close', async () => {
    const h = state.harness;
    const id = await h.launch({ slug: 'lifecycle' });
    await h.callJson('navigate', {
      session_id: id,
      url: 'data:text/html,<h1>hello from browserhive</h1>',
    });
    const content = await h.callJson<{ html: string }>('get_content', { session_id: id });
    expect(content.html).toContain('hello from browserhive');
    expect(
      (await h.callJson<{ closed: boolean }>('close_session', { session_id: id })).closed,
    ).toBe(true);
    expect(await h.callJson<unknown>('list_sessions')).toEqual([]);
  });

  it('list reflects live sessions', async () => {
    const h = state.harness;
    const a = await h.launch({ slug: 'one' });
    const b = await h.launch({ slug: 'two' });
    const listed = await h.callJson<{ session_id: string }[]>('list_sessions');
    expect(new Set(listed.map((m) => m.session_id))).toEqual(new Set([a, b]));
  });
});
