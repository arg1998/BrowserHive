/** @module interface/mcp/window-raising.test — only tools that can restore a minimized headed window are wrapped in `SessionView.aroundAction` (D-77, review #89 F4): a click is, a screenshot or `request_attention` is not; every listed name is a real tool. */

import { afterEach, describe, expect, it } from 'bun:test';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';
import { createToolHarness, type ToolHarness } from '../../../test/helpers/fake-transport.ts';
import { executeTool } from '../../../test/helpers/tool-run.ts';
import { WINDOW_RAISING_TOOLS } from './window-raising.ts';

let h: ToolHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('tools wrapped to keep headed windows minimized', () => {
  it('lists only real tools, and never a wait or a read-only tool', () => {
    const names: readonly string[] = ALL_TOOL_NAMES;
    for (const name of WINDOW_RAISING_TOOLS) expect(names).toContain(name);
    for (const name of ['request_attention', 'wait_for_selector', 'screenshot', 'snapshot']) {
      expect(WINDOW_RAISING_TOOLS.has(name)).toBe(false);
    }
    expect(WINDOW_RAISING_TOOLS.has('click')).toBe(true);
  });

  it('the dispatcher wraps a click in the view’s aroundAction, not a screenshot', async () => {
    const harness = await createToolHarness();
    h = harness;
    const id = await harness.launch();
    const view = harness.services.sessions.peek(id)?.view;
    if (view == null) throw new Error('no view');
    const wrapped: number[] = [];
    Object.assign(view, {
      aroundAction: async <T>(run: () => Promise<T>): Promise<T> => {
        wrapped.push(1);
        return await run();
      },
    });
    await executeTool(harness, 'screenshot', { session_id: id });
    expect(wrapped).toHaveLength(0);
    await executeTool(harness, 'click', { session_id: id, selector: '#go' });
    expect(wrapped).toHaveLength(1);
  });
});
