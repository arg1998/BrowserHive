/** @module interface/http/routes/logs — ring-buffer log query and NDJSON export (spec 03 §4.7, spec 10 §10). */

import { LogsExportQuery, LogsPage, LogsQuery } from '@browserhive/contracts/http';
import { z } from 'zod';
import { defineRoute, raw, reply } from '../define-route.ts';
import { validationFailed } from '../problem.ts';
import { appliedFilters } from '../serializers/page.ts';
import { logEntryToWire } from '../serializers/system.ts';
import type { LogQueryLike } from '../services.ts';

const tags = ['logs'];

/** Scan direction of a logs page. */
type LogDir = 'asc' | 'desc';

/** Log cursors are the ring `seq` plus the direction, base64url-wrapped so they stay opaque. */
export function encodeLogCursor(seq: number, dir: LogDir = 'asc'): string {
  return Buffer.from(JSON.stringify({ r: 'logs', s: seq, d: dir })).toString('base64url');
}

function decodeLogCursor(cursor: string | undefined, dir: LogDir): number | undefined {
  if (cursor === undefined) return undefined;
  let json: unknown = null;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    json = null;
  }
  const parsed = z
    .object({
      r: z.literal('logs'),
      s: z.number().int().nonnegative(),
      d: z.enum(['asc', 'desc']).default('asc'),
    })
    .safeParse(json);
  if (!parsed.success || parsed.data.d !== dir) {
    const message = parsed.success
      ? `cursor was minted for dir=${parsed.data.d}`
      : 'invalid cursor';
    throw validationFailed([{ path: 'query.cursor', message, code: 'custom' }]);
  }
  return parsed.data.s;
}

function filtersOf(q: z.output<typeof LogsExportQuery>): LogQueryLike {
  return {
    ...(q.level !== undefined && { level: q.level }),
    ...(q.module !== undefined && { module: q.module }),
    ...(q.session_id !== undefined && { sessionId: q.session_id }),
    ...(q.trace_id !== undefined && { traceId: q.trace_id }),
    ...(q.request_id !== undefined && { requestId: q.request_id }),
    ...(q.q !== undefined && { q: q.q }),
    ...(q.since !== undefined && { since: q.since }),
    ...(q.until !== undefined && { until: q.until }),
  };
}

/** Log routes. */
export const LOG_ROUTES = [
  defineRoute({
    operationId: 'listLogs',
    tags,
    summary:
      'Records from the in-process ring buffer: newest first by default (`dir=desc`, the cursor pages to older records); `dir=asc` pages oldest to newest; `after_seq` bounds to newer records.',
    request: { query: LogsQuery },
    responses: { 200: LogsPage },
    async handler({ input, services, ctx }) {
      const { cursor, limit, dir, after_seq: afterSeq, ...filters } = input.query;
      const from = decodeLogCursor(cursor, dir);
      const page = services.logs.query({
        ...filtersOf(filters),
        limit,
        order: dir,
        ...(from !== undefined && { cursor: from }),
        ...(afterSeq !== undefined && { afterSeq }),
      });
      return reply(200, {
        data: page.items.map(logEntryToWire),
        page: {
          next_cursor: page.nextCursor === null ? null : encodeLogCursor(page.nextCursor, dir),
          limit,
        },
        applied: {
          filters: appliedFilters({
            ...filters,
            ...(afterSeq !== undefined && { after_seq: afterSeq }),
          }),
          sort: { key: 'seq', dir },
        },
        meta: { now: ctx.now },
        latest_seq: services.logs.latestSeq,
      });
    },
  }),
  defineRoute({
    operationId: 'exportLogs',
    tags,
    summary: 'Every matching ring-buffer record as NDJSON.',
    request: { query: LogsExportQuery },
    responses: {},
    raw: [
      { status: 200, contentType: 'application/x-ndjson', description: 'One record per line.' },
    ],
    async handler({ input, services }) {
      const lines: string[] = [];
      let cursor: number | undefined;
      for (;;) {
        const page = services.logs.query({
          ...filtersOf(input.query),
          limit: 1000,
          order: 'asc',
          ...(cursor !== undefined && { cursor }),
        });
        for (const entry of page.items) lines.push(`${JSON.stringify(logEntryToWire(entry))}\n`);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return raw(
        new Response(lines.join(''), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
      );
    },
  }),
];
