/** @module interface/mcp/tools/dialogs — accept_next_dialog, dismiss_next_dialog (one-shot, auto-disarmed). */

import type { Dialog, Page } from 'playwright';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';
import { pageOf } from '../shared.ts';

/** The one-shot handler removes itself after this long without a dialog. */
export const DIALOG_ARM_TIMEOUT_MS = 60_000;

/**
 * Arms a handler for exactly the next dialog on `page`. Playwright auto-dismisses dialogs with no
 * handler; a 60 s (unref'd) timer removes a stale arm so it cannot linger for the session's life.
 */
export function armOneShot(page: Page, respond: (dialog: Dialog) => Promise<void>): void {
  const handler = (dialog: Dialog): void => {
    clearTimeout(timer);
    void respond(dialog).catch(() => undefined);
  };
  const timer = setTimeout(() => page.off('dialog', handler), DIALOG_ARM_TIMEOUT_MS);
  timer.unref?.();
  page.once('dialog', handler);
}

/** `accept_next_dialog`: a prompt receives `prompt_text` first. */
export const acceptNextDialog = defineTool('accept_next_dialog', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    armOneShot(page, (dialog) => dialog.accept(args.prompt_text));
    return json({ session_id: session.id, armed: true as const });
  },
});

/** `dismiss_next_dialog`. */
export const dismissNextDialog = defineTool('dismiss_next_dialog', {
  policies: [sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    armOneShot(page, (dialog) => dialog.dismiss());
    return json({ session_id: session.id, armed: true as const });
  },
});

/** The dialogs pack. */
export const dialogsPack: ToolPack = {
  id: 'dialogs',
  tools: [acceptNextDialog, dismissNextDialog],
};
