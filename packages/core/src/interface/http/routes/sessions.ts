/** @module interface/http/routes/sessions — session list, detail, bulk and lifecycle verbs (spec 03 §4.2). */

import { ERROR_REGISTRY } from '@browserhive/contracts/errors';
import {
  ArchiveSessionResponse,
  BulkSessionsRequest,
  BulkSessionsResponse,
  DeleteSessionResponse,
  IdempotencyKey,
  SessionDetail,
  SessionIdParams,
  SessionsPage,
  SessionsQuery,
  TerminateSessionResponse,
} from '@browserhive/contracts/http';
import { z } from 'zod';
import { AppError, isAppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, reply } from '../define-route.ts';
import { envelope } from '../serializers/page.ts';
import {
  countsOf,
  facetsToWire,
  overlayLive,
  sessionRowToSummary,
  sessionsQueryToRepo,
} from '../serializers/sessions.ts';
import type { HttpServices } from '../services.ts';
import { type KnownSession, requirePrincipal, requireSession } from './common.ts';
import {
  archiveSession,
  deleteSession,
  runBulkSessionAction,
  terminateSession,
  unarchiveSession,
} from './session-ops.ts';

const tags = ['sessions'];
const IdempotencyHeaders = z.object({ 'idempotency-key': IdempotencyKey });

/** The one summary of a known session (live aggregate wins over the stored row). */
export function summaryOf(services: HttpServices, known: KnownSession, now: number) {
  const viewers = services.realtime.hasViewers(known.id);
  if (known.live !== undefined) {
    return overlayLive(services.sessions.summary(known.live), known.row, viewers);
  }
  if (known.row === null) {
    throw new AppError('INTERNAL_ERROR', { ref: 'session-summary' }, { message: 'no row' });
  }
  return sessionRowToSummary(known.row, now, viewers);
}

/** Session list, detail and lifecycle routes. */
export const SESSION_ROUTES = [
  defineRoute({
    operationId: 'listSessions',
    tags,
    summary: 'List sessions with facets; the live registry overlays stored rows.',
    request: { query: SessionsQuery },
    responses: { 200: SessionsPage },
    async handler({ input, services, ctx }) {
      const query = sessionsQueryToRepo(input.query);
      const [page, facets] = await Promise.all([
        services.repos.sessions.list(query),
        services.repos.sessions.facets(query),
      ]);
      const body = envelope(
        page,
        (row) => {
          const live = services.sessions.peek(row.sessionId);
          const viewers = services.realtime.hasViewers(row.sessionId);
          return live === undefined
            ? sessionRowToSummary(row, ctx.now, viewers)
            : overlayLive(services.sessions.summary(live), row, viewers);
        },
        input.query,
        ctx.now,
        'created_at',
      );
      return reply(200, { ...body, facets: facetsToWire(facets) });
    },
  }),
  defineRoute({
    operationId: 'bulkSessions',
    tags,
    summary: 'Archive, unarchive, terminate or delete up to 100 sessions (per-item results).',
    request: { body: BulkSessionsRequest, headers: IdempotencyHeaders },
    responses: { 200: BulkSessionsResponse },
    idempotent: true,
    async handler({ input, principal, services, ctx }) {
      const caller = requirePrincipal(principal);
      const results = [];
      for (const sessionId of input.body.session_ids) {
        try {
          await runBulkSessionAction(services, caller, input.body.action, sessionId, ctx.now);
          results.push({ session_id: sessionId, ok: true });
        } catch (error) {
          if (!isAppError(error)) throw error;
          const title = ERROR_REGISTRY[error.code].title;
          results.push({ session_id: sessionId, ok: false, error: { code: error.code, title } });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return reply(200, { results, ok_count: okCount, error_count: results.length - okCount });
    },
  }),
  defineRoute({
    operationId: 'getSession',
    tags,
    summary: 'One session with trace/data-dir descriptors and counters (no embedded arrays).',
    request: { params: SessionIdParams },
    responses: { 200: SessionDetail },
    errors: ['SESSION_NOT_FOUND'],
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const session = summaryOf(services, known, ctx.now);
      const dirs = services.sessionDirs.forSession(known.id);
      const trace = await services.files.stat(dirs.traceZip);
      return reply(200, {
        session,
        trace: {
          enabled: services.system.facts().traceEnabled,
          path: dirs.traceZip,
          viewer_available: services.traceViewerAvailable,
          ...(trace?.isFile === true && { size_bytes: trace.size }),
        },
        data_dir: { path: dirs.root, persistent: session.persistence_mode === 'persistent' },
        counts: known.row === null ? session.counts : countsOf(known.row),
        now: ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'terminateSession',
    tags,
    summary: 'Close a live session (operator reason).',
    request: { params: SessionIdParams },
    responses: { 200: TerminateSessionResponse },
    errors: ['SESSION_NOT_FOUND', 'SESSION_NOT_LIVE'],
    async handler({ input, principal, services, ctx }) {
      const id = input.params.session_id;
      const closed = await terminateSession(services, requirePrincipal(principal), id, ctx.now);
      return reply(200, { ok: true, closed });
    },
  }),
  defineRoute({
    operationId: 'archiveSession',
    tags,
    summary: 'Archive a finished session (exempt from retention).',
    request: { params: SessionIdParams },
    responses: { 200: ArchiveSessionResponse },
    errors: ['SESSION_NOT_FOUND', 'SESSION_LIVE'],
    async handler({ input, principal, services, ctx }) {
      await archiveSession(services, requirePrincipal(principal), input.params.session_id, ctx.now);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'unarchiveSession',
    tags,
    summary: 'Unarchive a session.',
    request: { params: SessionIdParams },
    responses: { 200: ArchiveSessionResponse },
    errors: ['SESSION_NOT_FOUND'],
    async handler({ input, principal, services, ctx }) {
      const id = input.params.session_id;
      await unarchiveSession(services, requirePrincipal(principal), id, ctx.now);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'deleteSession',
    tags,
    summary: 'Terminate if live, then delete rows and artifacts.',
    request: { params: SessionIdParams },
    responses: { 200: DeleteSessionResponse },
    errors: ['SESSION_NOT_FOUND'],
    async handler({ input, principal, services, ctx }) {
      const id = input.params.session_id;
      const deleted = await deleteSession(services, requirePrincipal(principal), id, ctx.now);
      return reply(200, { ok: true, deleted });
    },
  }),
];
