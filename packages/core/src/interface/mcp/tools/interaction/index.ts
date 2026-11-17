/** @module interface/mcp/tools/interaction — select_option, scroll, drag_and_drop, and the interaction pack. */

import { z } from 'zod';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';
import { pageOf } from '../shared.ts';
import { act, humanized, isolatedEvaluate } from './act.ts';
import { click, fill, hover, pressKey, typeText } from './pointer.ts';
import { type ScrollScriptArgs, scrollExpression } from './scroll.ts';

/** What the in-page scroll script reports (validated: it runs in the page). */
const ScrollReport = z.object({
  x: z.number(),
  y: z.number(),
  target: z.enum(['window', 'element']),
  element: z.string().optional(),
  point: z.object({ x: z.number(), y: z.number() }).optional(),
});

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
 * event), `to` an absolute position, or a `selector` into view. `by` and `to` move the document, or
 * when the document does not scroll, the page's main scroll container (workload test B4,
 * `scroll.ts`). Returns the resulting offset of what scrolled, and what that was.
 */
export const scroll = defineTool('scroll', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const actions = ctx.services.pageActions;
    const isolated = isolatedEvaluate(session);
    const script = (mode: ScrollScriptArgs['mode']) =>
      scrollExpression({
        mode,
        dx: args.dx,
        dy: args.dy,
        x: args.x ?? 0,
        y: args.y ?? 0,
        behavior: args.behavior,
      });
    const report = async (mode: ScrollScriptArgs['mode']) => {
      const parsed = ScrollReport.safeParse(await actions.evaluate(page, isolated, script(mode)));
      return parsed.success ? parsed.data : null;
    };
    let done: z.infer<typeof ScrollReport> | null = null;
    // `superRefine` guarantees the mode-specific fields; the guards narrow the optionals.
    if (args.mode === 'selector' && args.selector !== undefined) {
      const selector = args.selector;
      await act(ctx, session, selector, args.timeout, () =>
        page.locator(selector).scrollIntoViewIfNeeded({ timeout: args.timeout }),
      );
    } else if (args.mode === 'to') {
      done = await report('to');
    } else if (humanized(ctx, session, page)) {
      // The wheel scrolls what is under the pointer: point it at the container when it is one.
      const before = await report('read');
      await actions.humanScroll(session.id, {
        page,
        deltaX: args.dx,
        deltaY: args.dy,
        ...(before?.point !== undefined && { at: before.point }),
      });
    } else {
      done = await report('by');
    }
    const after = done ?? (await report('read'));
    if (after === null) return json({ session_id: session.id, x: 0, y: 0 });
    return json({
      session_id: session.id,
      x: after.x,
      y: after.y,
      target: after.target,
      ...(after.element !== undefined && { element: after.element }),
    });
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
