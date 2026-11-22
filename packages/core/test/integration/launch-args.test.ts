/** @module test/integration/launch-args — `launch_session` refuses deny-listed launch args in every switch spelling Chromium accepts, and an `ignoreDefaultArgs` that drops a protected default, before any browser spawns (real Chromium). */

import { describe, expect, it, spyOn } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { textOf } from '../helpers/fake-transport.ts';
import { useMcpStack } from './mcp-fixture.ts';

function errorOf(result: CallToolResult): { code?: unknown; details?: unknown } {
  const meta = result._meta?.['browserhive.ai/error'];
  if (typeof meta !== 'object' || meta === null) return {};
  const { code, details } = meta as { code?: unknown; details?: unknown };
  return { code, details };
}

describe('launch-arg deny-list (real Chromium)', () => {
  const { state } = useMcpStack();

  it('refuses single-dash, slash and case variants with UNSAFE_LAUNCH_ARG and spawns nothing', async () => {
    const h = state.harness;
    const launches = spyOn(h.driver, 'launch');
    for (const arg of [
      '-remote-debugging-port=0',
      '/no-sandbox',
      '--Remote-Debugging-Pipe',
      '--',
    ]) {
      const result = await h.call('launch_session', {
        slug: 'denied',
        launch_options: { args: ['--mute-audio', arg] },
      });
      expect({ arg, isError: result.isError, ...errorOf(result) }).toEqual({
        arg,
        isError: true,
        code: 'UNSAFE_LAUNCH_ARG',
        details: { arg },
      });
      expect(textOf(result)).toContain(`Launch arg '${arg}' is on the deny-list`);
    }
    expect(launches).toHaveBeenCalledTimes(0);
    expect(await h.callJson<unknown[]>('list_sessions')).toEqual([]);
  });

  it('refuses an ignoreDefaultArgs that drops a protected default and spawns nothing', async () => {
    const h = state.harness;
    const launches = spyOn(h.driver, 'launch');
    for (const ignoreDefaultArgs of [true, ['--remote-debugging-pipe'], ['-user-data-dir']]) {
      const result = await h.call('launch_session', {
        slug: 'denied',
        launch_options: { ignoreDefaultArgs },
      });
      expect({ ignoreDefaultArgs, isError: result.isError, ...errorOf(result) }).toEqual({
        ignoreDefaultArgs,
        isError: true,
        code: 'UNSAFE_LAUNCH_ARG',
        details: { arg: 'ignoreDefaultArgs' },
      });
    }
    expect(launches).toHaveBeenCalledTimes(0);
    expect(await h.callJson<unknown[]>('list_sessions')).toEqual([]);
  });

  it('still launches with harmless single-dash args and a droppable default', async () => {
    const h = state.harness;
    const launches = spyOn(h.driver, 'launch');
    const id = await h.launch({
      slug: 'allowed',
      launch_options: { args: ['-mute-audio'], ignoreDefaultArgs: ['--enable-automation'] },
    });
    expect(launches).toHaveBeenCalledTimes(1);
    expect(
      (await h.callJson<{ closed: boolean }>('close_session', { session_id: id })).closed,
    ).toBe(true);
  });
});
