/** @module interface/mcp/policies — the pre-execution tool policies: session ownership, URL blocklist, evaluate gate, path sandbox, http-only transport, vault configured (spec 02 §2.3). */

import { assertAttentionTransport } from '../../domain/operator-requests/heartbeat.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { PolicyContext, ToolPolicy } from './definition.ts';
import { resolveScreenshotSavePath, resolveUploadPath } from './sandbox.ts';

function stringArg(args: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = args[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolves `args.session_id` through `sessions.get(id, principal)` — the one ownership check (also
 * resets the lease and stamps `last_tool_at`) — and attaches the session to the call.
 *
 * @throws `SESSION_NOT_FOUND`, `SESSION_ACCESS_DENIED` (identical text), `SESSION_DEAD`, `SESSION_NOT_AVAILABLE`
 */
export const sessionOwnership: ToolPolicy = {
  name: 'sessionOwnership',
  apply(ctx: PolicyContext, args) {
    const sessionId = stringArg(args, 'session_id') ?? '';
    ctx.attachSession(ctx.services.sessions.get(sessionId, ctx.principal));
  },
};

/**
 * Refuses a blocklisted URL before the browser is touched (only when `field` is present).
 *
 * @throws `URL_BLOCKED`
 */
export function urlBlocklist(field: string): ToolPolicy {
  return {
    name: `urlBlocklist(${field})`,
    apply(ctx, args) {
      const url = stringArg(args, field);
      if (url === undefined) return;
      ctx.services.blocklist.assertAllowed(url, {
        sessionId: ctx.session?.id,
        tool: ctx.tool,
        toolEventId: ctx.eventId,
      });
    },
  };
}

/** Public text of `EVALUATE_DISABLED` for both scopes (stable wire text agents may match on). */
export function evaluateDisabledMessage(sessionId: string): string {
  return `The 'evaluate' tool is disabled for session '${sessionId}'.`;
}

/**
 * `evaluate` is refused when the session was launched with `disable_evaluate` **or** the server
 * runs with `allowEvaluate=false` (D-12), so the server-wide switch is enforced, not advisory. Must run after `sessionOwnership`.
 *
 * @throws `EVALUATE_DISABLED` `{ session_id, scope }`
 */
export const evaluateAllowed: ToolPolicy = {
  name: 'evaluateAllowed',
  apply(ctx) {
    const session = ctx.session;
    const sessionId = session?.id ?? '';
    const scope =
      session?.request.disableEvaluate === true
        ? 'session'
        : ctx.services.runtime.allowEvaluate
          ? null
          : 'server';
    if (scope === null) return;
    throw new AppError(
      'EVALUATE_DISABLED',
      { session_id: sessionId, scope },
      { publicMessage: evaluateDisabledMessage(sessionId) },
    );
  },
};

/**
 * Validates a tool-supplied path against the data-dir sandbox before the browser is touched:
 * `screenshot` destinations (session dir or uploads) and `upload` sources (uploads only). A string
 * field and a string-array field are both accepted. Must run after `sessionOwnership`.
 *
 * @throws `PATH_NOT_ALLOWED`
 */
export function sandboxPath(field: string, kind: 'screenshot' | 'upload'): ToolPolicy {
  return {
    name: `sandboxPath(${field})`,
    async apply(ctx, args) {
      const raw = args[field];
      const paths = Array.isArray(raw)
        ? raw.filter((p): p is string => typeof p === 'string')
        : typeof raw === 'string'
          ? [raw]
          : [];
      const dataDir = ctx.services.runtime.dataDir;
      for (const path of paths) {
        if (kind === 'upload') await resolveUploadPath(dataDir, path);
        else await resolveScreenshotSavePath(dataDir, ctx.session?.id ?? '', path);
      }
    },
  };
}

/**
 * Attention tools stay registered under stdio and refuse first, before any session lookup.
 *
 * @throws `ATTENTION_REQUIRES_HTTP`
 */
export const transportHttp: ToolPolicy = {
  name: 'transportHttp',
  apply(ctx) {
    const transport = ctx.services.attention === null ? 'stdio' : ctx.services.runtime.transport;
    assertAttentionTransport(transport, ctx.tool);
  },
};

/**
 * Vault tools raise `VAULT_NOT_CONFIGURED` before the session lookup when no backend is configured.
 *
 * @throws `VAULT_NOT_CONFIGURED`
 */
export const vaultEnabled: ToolPolicy = {
  name: 'vaultEnabled',
  apply(ctx) {
    ctx.services.vault.assertConfigured();
  },
};
