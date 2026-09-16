/** @module interface/http/routes/search — command-palette search and the client error sink (spec 03 §4.8–4.9). */

import { ClientErrorReport, SearchQuery, SearchResponse } from '@browserhive/contracts/http';
import { ALL_TOOL_NAMES } from '@browserhive/contracts/tools';
import type { Logger } from '../../../ports/logger.ts';
import { defineRoute, raw, reply } from '../define-route.ts';

/** Search and client-error routes; `logger` receives dashboard error reports. */
export function searchRoutes(logger: Logger) {
  const clientLog = logger.child({ module: 'dashboard' });
  return [
    defineRoute({
      operationId: 'search',
      tags: ['search'],
      summary: 'Entity search for the command palette.',
      request: { query: SearchQuery },
      responses: { 200: SearchResponse },
      async handler({ input, services }) {
        const needle = input.query.q.toLowerCase();
        const limit = input.query.limit;
        const [sessions, bindings] = await Promise.all([
          services.repos.sessions.list({ q: input.query.q, limit, archived: 'include' }),
          services.vault.configured
            ? services.vault.admin.listBindings({ q: input.query.q, limit })
            : Promise.resolve({ items: [], nextCursor: null }),
        ]);
        return reply(200, {
          sessions: sessions.items.map((s) => ({ session_id: s.sessionId, slug: s.slug })),
          tools: ALL_TOOL_NAMES.filter((t) => t.includes(needle)).slice(0, limit),
          vault_handles: bindings.items.map((b) => b.handle),
          patterns: services.blocklist
            .patterns()
            .map((p) => p.pattern)
            .filter((p) => p.includes(needle))
            .slice(0, limit),
        });
      },
    }),
    defineRoute({
      operationId: 'reportClientError',
      tags: ['search'],
      summary: 'Record an uncaught dashboard error (rate-limited 30/min).',
      request: { body: ClientErrorReport },
      responses: {},
      raw: [{ status: 204, contentType: 'none', description: 'Recorded.' }],
      rateLimit: { limit: 30, windowMs: 60_000, key: 'principal' },
      async handler({ input }) {
        clientLog.warn('client error reported', {
          message: input.body.message,
          route: input.body.route,
          build: input.body.build,
          user_agent: input.body.user_agent,
          ...(input.body.stack !== undefined && { stack: input.body.stack }),
        });
        return raw(new Response(null, { status: 204 }));
      },
    }),
  ];
}
