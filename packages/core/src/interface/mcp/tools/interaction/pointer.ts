/** @module interface/mcp/tools/interaction/pointer — click, type_text, fill, press_key, hover. */

import { requireSession } from '../../context.ts';
import { defineTool, json } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';
import { pageOf } from '../shared.ts';
import { act, humanized } from './act.ts';

/** Headroom added to the typing estimate when a humanized type raises the timeout. */
export const TYPING_HEADROOM_MS = 5_000;

/** `click` (humanized path when the session has `humanize`). */
export const click = defineTool('click', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const native = async (): Promise<void> =>
      page.click(args.selector, {
        button: args.button,
        clickCount: args.click_count,
        ...(args.modifiers !== undefined && { modifiers: args.modifiers }),
        ...(args.position !== undefined && { position: args.position }),
        timeout: args.timeout,
      });
    await act(ctx, session, args.selector, args.timeout, () =>
      humanized(session)
        ? ctx.services.pageActions.humanClick(session.id, {
            page,
            timeout: args.timeout,
            selector: args.selector,
            button: args.button,
            clickCount: args.click_count,
            ...(args.modifiers !== undefined && { modifiers: args.modifiers }),
            ...(args.position !== undefined && { position: args.position }),
            native,
          })
        : native(),
    );
    return json({ session_id: session.id, selector: args.selector, ok: true as const });
  },
});

/** `type_text`: humanized typing raises the timeout to fit the estimate and reports progress. */
export const typeText = defineTool('type_text', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const native = async (): Promise<void> =>
      page.type(args.selector, args.text, { delay: args.delay, timeout: args.timeout });
    const actions = ctx.services.pageActions;
    if (!humanized(session)) {
      await act(ctx, session, args.selector, args.timeout, native);
    } else {
      // Human cadence can outlast the caller's timeout on a long string; a self-inflicted overrun
      // would surface as ELEMENT_NOT_ACTIONABLE, blaming the page. `0` means "no timeout".
      const estimated = actions.estimateTypingMs(args.text);
      const budget =
        args.timeout === 0 ? 0 : Math.max(args.timeout, estimated + TYPING_HEADROOM_MS);
      await act(ctx, session, args.selector, budget, () =>
        actions.humanType(session.id, {
          page,
          timeout: budget,
          selector: args.selector,
          text: args.text,
          focus: () =>
            actions.humanClick(session.id, {
              page,
              timeout: args.timeout,
              selector: args.selector,
              native: async () => page.click(args.selector, { timeout: args.timeout }),
            }),
          native,
          onProgress: (typed, total) => {
            void ctx.reportProgress({ progress: typed, total }).catch(() => undefined);
          },
        }),
      );
    }
    return json({ session_id: session.id, selector: args.selector, ok: true as const });
  },
});

/** `fill`: always native. */
export const fill = defineTool('fill', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    await act(ctx, session, args.selector, args.timeout, () =>
      page.fill(args.selector, args.value, { timeout: args.timeout }),
    );
    return json({ session_id: session.id, selector: args.selector, ok: true as const });
  },
});

/** `press_key`: with a selector it focuses first; without, `keyboard.press` (no timeout, not wrapped). */
export const pressKey = defineTool('press_key', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const selector = args.selector;
    if (selector !== undefined) {
      await act(ctx, session, selector, args.timeout, () =>
        page.press(selector, args.key, { timeout: args.timeout }),
      );
    } else {
      await page.keyboard.press(args.key);
    }
    return json({ session_id: session.id, key: args.key, ok: true as const });
  },
});

/** `hover` (humanized path when the session has `humanize`). */
export const hover = defineTool('hover', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const native = async (): Promise<void> => page.hover(args.selector, { timeout: args.timeout });
    await act(ctx, session, args.selector, args.timeout, () =>
      humanized(session)
        ? ctx.services.pageActions.humanHover(session.id, {
            page,
            timeout: args.timeout,
            selector: args.selector,
            native,
          })
        : native(),
    );
    return json({ session_id: session.id, selector: args.selector, ok: true as const });
  },
});
