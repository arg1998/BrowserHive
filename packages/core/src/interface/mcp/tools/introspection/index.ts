/** @module interface/mcp/tools/introspection — server_status, session_info. */

import { safeCurrentUrl } from '../../../../app/sessions/metadata.ts';
import { requireSession } from '../../context.ts';
import { defineTool, json, type ToolPack } from '../../definition.ts';
import { sessionOwnership } from '../../policies.ts';

/** `server_status`: uptime, version, transport, real session limit, vault, persistence (+ additive `driver`). */
export const serverStatus = defineTool('server_status', {
  policies: [],
  async handler(ctx) {
    const { runtime, sessions, clock } = ctx.services;
    const status = sessions.serverStatus();
    return json({
      uptime_ms: Math.max(0, clock.now() - runtime.startedAt),
      version: runtime.version,
      transport: runtime.transport,
      sessions: { count: status.count, limit: status.limit },
      vault: {
        enabled: runtime.vault.enabled,
        backend: runtime.vault.backend,
        // Dashboard warning trigger: vault configured while evaluate is globally allowed.
        evaluate_warning: runtime.vault.enabled && runtime.allowEvaluate,
      },
      persistence_mode: runtime.persistenceMode,
      driver: status.driver,
    });
  },
});

/** `session_info`: one session's configuration and live state. */
export const sessionInfo = defineTool('session_info', {
  policies: [sessionOwnership],
  async handler(ctx) {
    const session = requireSession(ctx);
    const request = session.request;
    return json({
      session_id: session.id,
      config: {
        slug: session.slug,
        channel: request.channel,
        headless: request.headless,
        incognito: request.incognito,
        persistence_mode: request.persistenceMode,
        disable_evaluate: request.disableEvaluate,
        vault_enabled: request.vaultEnabled,
        stealth: request.stealth,
        fingerprint: request.fingerprint,
        humanize: request.humanize,
        owner: session.owner,
      },
      page_count: session.tabs.size(),
      current_url: safeCurrentUrl(session),
      created_at: session.createdAt,
      last_tool_at: session.lastToolAt,
      lease_expires_at: session.lease.expiresAt,
      navigation_count: session.counts.navigations,
    });
  },
});

/** The introspection pack. */
export const introspectionPack: ToolPack = {
  id: 'introspection',
  tools: [serverStatus, sessionInfo],
};
