/** @module interface/mcp/tools/vault — vault_list_available, vault_fill (delegating to VaultService; failures are returned statuses). */

import type { Page } from 'playwright';
import { safeCurrentUrl } from '../../../../app/sessions/metadata.ts';
import type { VaultPage } from '../../../../domain/vault/types.ts';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership, vaultEnabled } from '../../policies.ts';
import { pageOf } from '../shared.ts';

/** Adapts a Playwright page to the broker's `VaultPage` (callbacks pass straight through). */
export function vaultPage(page: Page): VaultPage {
  return {
    url: () => page.url(),
    fill: (selector, value, options) => page.fill(selector, value, options),
    click: (selector, options) => page.click(selector, options),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    $eval: (selector, fn) => page.$eval(selector, fn),
  };
}

/** `vault_list_available`: scoped to the session's real page; `url` is the honesty probe. */
export const vaultListAvailable = defineTool('vault_list_available', {
  requires: { vault: true },
  policies: [vaultEnabled, sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const result = await ctx.services.vault.listAvailable(
      { principal: ctx.principal.subject, slug: session.slug },
      {
        currentUrl: safeCurrentUrl(session) ?? '',
        sessionId: session.id,
        toolEventId: ctx.eventId,
        ...(args.url !== undefined && { declaredUrl: args.url }),
      },
      ctx.signal,
    );
    return json({
      entries: result.entries.map((e) => ({
        entry_name: e.entryName,
        allowed_origins: [...e.allowedOrigins],
        redact_username: e.redactUsername,
        require_no_evaluate: e.requireNoEvaluate,
      })),
      scope: result.scope,
      scoped_to: result.scopedTo,
      ...(result.mismatch !== undefined && {
        mismatch: { declared: result.mismatch.declared, actual: result.mismatch.actual },
      }),
      ...(result.note !== undefined && { note: result.note }),
    });
  },
});

/** `vault_fill`: one-shot atomic credential injection; non-success is a returned status. */
export const vaultFill = defineTool('vault_fill', {
  requires: { vault: true },
  policies: [vaultEnabled, sessionOwnership],
  async handler(ctx, args) {
    const session = requireSession(ctx);
    const page = pageOf(ctx, session, args.tab_id);
    const result = await ctx.services.vault.fill(
      {
        entryName: args.entry_name,
        usernameSelector: args.username_selector,
        passwordSelector: args.password_selector,
        ...(args.submit_selector !== undefined && { submitSelector: args.submit_selector }),
        ...(args.after_submit_wait_ms !== undefined && {
          afterSubmitWaitMs: args.after_submit_wait_ms,
        }),
        ...(args.clear_after_fill !== undefined && { clearAfterFill: args.clear_after_fill }),
        ...(args.tab_id !== undefined && { tabId: args.tab_id }),
      },
      {
        session: {
          sessionId: session.id,
          slug: session.slug,
          disableEvaluate: session.request.disableEvaluate,
          vaultEnabled: session.request.vaultEnabled,
          humanize: session.request.humanize,
        },
        page: vaultPage(page),
        tracing: session.handle?.tracing ?? null,
        principal: ctx.principal.subject,
        toolEventId: ctx.eventId,
        signal: ctx.signal,
      },
    );
    return json({
      status: result.status,
      redacted: true as const,
      ...(result.reason !== undefined && { reason: result.reason }),
    });
  },
});

/** The vault pack. */
export const vaultPack: ToolPack = {
  id: 'vault',
  tools: [vaultListAvailable, vaultFill],
};
