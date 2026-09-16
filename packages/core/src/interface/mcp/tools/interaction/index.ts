/** @module interface/mcp/tools/interaction — select_option, scroll, drag_and_drop, and the interaction pack. */

import { z } from 'zod';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';
import { pageOf } from '../shared.ts';
import { act, humanized, isolatedEvaluate } from './act.ts';
import { click, fill, hover, pressKey, typeText } from './pointer.ts';

const ScrollOffset = z.object({ x: z.number(), y: z.number() });

/** `select_option`: always native. */
export const selectOption = defineTool('select_option', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const selected = await act(ctx, session, args.selector, args.timeout, () =>
      page.selectOption(args.selector, args.values, { timeout: args.timeout }),
    );
    return json({ session_id: session.id, selector: args.selector, selected });
  },
});

/**
 * `scroll`: `by` a delta (humanized wheel notches when on — `window.scrollBy` dispatches no `wheel`
 * event), `to` an absolute position, or a `selector` into view. Returns the resulting offset.
 */
export const scroll = defineTool('scroll', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const actions = ctx.services.pageActions;
    const isolated = isolatedEvaluate(session);
    const behavior = JSON.stringify(args.behavior);
    // `superRefine` guarantees the mode-specific fields; the guards narrow the optionals.
    if (args.mode === 'selector' && args.selector !== undefined) {
      const selector = args.selector;
      await act(ctx, session, selector, args.timeout, () =>
        page.locator(selector).scrollIntoViewIfNeeded({ timeout: args.timeout }),
      );
    } else if (args.mode === 'to' && args.x !== undefined && args.y !== undefined) {
      await actions.evaluate(
        page,
        isolated,
        `window.scrollTo({ left: ${JSON.stringify(args.x)}, top: ${JSON.stringify(args.y)}, behavior: ${behavior} })`,
      );
    } else if (humanized(session)) {
      await actions.humanScroll(session.id, { page, deltaX: args.dx, deltaY: args.dy });
    } else {
      await actions.evaluate(
        page,
        isolated,
        `window.scrollBy({ left: ${JSON.stringify(args.dx)}, top: ${JSON.stringify(args.dy)}, behavior: ${behavior} })`,
      );
    }
    const raw = await actions.evaluate(
      page,
      isolated,
      '({ x: window.scrollX, y: window.scrollY })',
    );
    const offset = ScrollOffset.safeParse(raw);
    const { x, y } = offset.success ? offset.data : { x: 0, y: 0 };
    return json({ session_id: session.id, x, y });
  },
});

/** `drag_and_drop`: always native; errors report `source → target`. */
export const dragAndDrop = defineTool('drag_and_drop', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const label = `${args.source_selector} → ${args.target_selector}`;
    await act(ctx, session, label, args.timeout, () =>
      page.dragAndDrop(args.source_selector, args.target_selector, { timeout: args.timeout }),
    );
    return json({ session_id: session.id, ok: true as const });
  },
});

/** The interaction pack (registration order pinned). */
export const interactionPack: ToolPack = {
  id: 'interaction',
  tools: [click, typeText, fill, pressKey, hover, selectOption, scroll, dragAndDrop],
};
