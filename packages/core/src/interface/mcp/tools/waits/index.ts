/** @module interface/mcp/tools/waits — wait_for_selector, wait_for_load_state (typed `WAIT_TIMEOUT`). */

import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';
import { drive, pageOf } from '../shared.ts';

/** `wait_for_selector`. */
export const waitForSelector = defineTool('wait_for_selector', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const what = `selector '${args.selector}' to be ${args.state}`;
    await drive(ctx, { what, timeoutMs: args.timeout, sessionId: session.id }, () =>
      page.waitForSelector(args.selector, { state: args.state, timeout: args.timeout }),
    );
    return json({ session_id: session.id, selector: args.selector, state: args.state });
  },
});

/** `wait_for_load_state`. */
export const waitForLoadState = defineTool('wait_for_load_state', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const what = `load state '${args.state}'`;
    await drive(ctx, { what, timeoutMs: args.timeout, sessionId: session.id }, () =>
      page.waitForLoadState(args.state, { timeout: args.timeout }),
    );
    return json({ session_id: session.id, state: args.state });
  },
});

/** The waits pack. */
export const waitsPack: ToolPack = { id: 'waits', tools: [waitForSelector, waitForLoadState] };
