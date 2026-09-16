/** @module interface/http/routes/session-artifacts — screenshot bytes, trace.zip (Range, grants), trace info, data-dir reveal and timeline export (spec 03 §4.2). */

import {
  EXPORT_MEDIA_TYPES,
  GrantQuery,
  RevealDataDirResponse,
  SCREENSHOT_CACHE_CONTROL,
  SESSION_EXPORT_MAX_ROWS,
  SessionEventParams,
  SessionExportQuery,
  SessionIdParams,
  SessionTraceInfo,
} from '@browserhive/contracts/http';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { isWithin } from '../../../kernel/paths.ts';
import type { TimelineItem } from '../../../ports/persistence/analytics.ts';
import { parseByteRange } from '../byte-range.ts';
import { defineRoute, raw, reply } from '../define-route.ts';
import { timelineItemToWire } from '../serializers/timeline.ts';
import type { HttpServices } from '../services.ts';
import { requireSession } from './common.ts';

const tags = ['sessions'];

async function traceZip(
  services: HttpServices,
  sessionId: string,
  method: string,
  rangeHeader: string | undefined,
): Promise<Response> {
  const known = await requireSession(services, sessionId);
  const path = services.sessionDirs.forSession(known.id).traceZip;
  const stat = await services.files.stat(path);
  if (stat === null || !stat.isFile) {
    throw new AppError('TRACE_UNAVAILABLE', { enabled: services.system.facts().traceEnabled });
  }
  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...headers, 'content-length': String(stat.size) },
    });
  }
  const range = parseByteRange(rangeHeader, stat.size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${stat.size}` },
    });
  }
  if (range === null) {
    return new Response(services.files.stream(path), {
      status: 200,
      headers: { ...headers, 'content-length': String(stat.size) },
    });
  }
  return new Response(services.files.stream(path, range), {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
    },
  });
}

const CSV_HEADER = 'kind,ts,id,data';

function csvCell(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportLine(item: TimelineItem, format: (typeof EXPORT_MEDIA_TYPES)[number]): string {
  const wire = timelineItemToWire(item);
  if (format === 'application/x-ndjson') return `${JSON.stringify(wire)}\n`;
  return `${[wire.kind, String(wire.ts), item.id, JSON.stringify(wire.row)].map(csvCell).join(',')}\n`;
}

/** Picks the export format from `Accept`; `*\/*` or absent → NDJSON; nothing acceptable → 406. */
export function negotiateExport(accept: string | undefined): (typeof EXPORT_MEDIA_TYPES)[number] {
  if (accept === undefined || accept.trim() === '') return 'application/x-ndjson';
  const wanted = accept.split(',').map((part) => part.split(';')[0]?.trim().toLowerCase() ?? '');
  for (const media of wanted) {
    if (media === '*/*' || media === 'application/*') return 'application/x-ndjson';
    const found = EXPORT_MEDIA_TYPES.find((m) => m === media);
    if (found !== undefined) return found;
  }
  throw new AppError('NOT_ACCEPTABLE', { supported: [...EXPORT_MEDIA_TYPES] });
}

/** Artifact routes. */
export const SESSION_ARTIFACT_ROUTES = [
  defineRoute({
    operationId: 'getScreenshotImage',
    tags,
    summary: 'Screenshot bytes (cookie, bearer or `?grant=` for route `screenshot` = event id).',
    request: { params: SessionEventParams, query: GrantQuery },
    responses: {},
    raw: [{ status: 200, contentType: 'image/*', description: 'The image bytes.' }],
    errors: ['NOT_FOUND', 'SCREENSHOT_UNAVAILABLE'],
    grantRoute: 'screenshot',
    async handler({ input, services }) {
      const row = await services.repos.screenshots.get(input.params.event_id);
      if (row === null || row.sessionId !== input.params.session_id) {
        throw new AppError('NOT_FOUND', {});
      }
      const root = services.sessionDirs.forSession(row.sessionId).root;
      const bytes = isWithin(root, row.path) ? await services.files.read(row.path) : null;
      if (bytes === null) throw new AppError('SCREENSHOT_UNAVAILABLE', { event_id: row.eventId });
      return raw(
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': row.contentType, 'cache-control': SCREENSHOT_CACHE_CONTROL },
        }),
      );
    },
  }),
  defineRoute({
    operationId: 'getTraceZip',
    tags,
    summary:
      'The session trace (single `Range` supported; `?grant=` for route `trace` = session id).',
    request: { params: SessionIdParams, query: GrantQuery },
    responses: {},
    raw: [
      { status: 200, contentType: 'application/zip', description: 'Whole trace.' },
      { status: 206, contentType: 'application/zip', description: 'Requested byte range.' },
      { status: 416, contentType: 'application/zip', description: 'Range not satisfiable.' },
    ],
    errors: ['SESSION_NOT_FOUND', 'TRACE_UNAVAILABLE'],
    grantRoute: 'trace',
    async handler({ input, services, ctx }) {
      return raw(
        await traceZip(services, input.params.session_id, ctx.method, ctx.header('range')),
      );
    },
  }),
  defineRoute({
    operationId: 'headTraceZip',
    tags,
    summary: 'Trace size probe.',
    request: { params: SessionIdParams, query: GrantQuery },
    responses: {},
    raw: [{ status: 200, contentType: 'application/zip', description: 'Headers only.' }],
    errors: ['SESSION_NOT_FOUND', 'TRACE_UNAVAILABLE'],
    grantRoute: 'trace',
    async handler({ input, services }) {
      return raw(await traceZip(services, input.params.session_id, 'HEAD', undefined));
    },
  }),
  defineRoute({
    operationId: 'getSessionTrace',
    tags,
    summary:
      'Trace descriptor. `viewer_url` embeds the trace.zip URL; the client appends `?grant=` to that inner URL.',
    request: { params: SessionIdParams },
    responses: { 200: SessionTraceInfo },
    errors: ['SESSION_NOT_FOUND'],
    async handler({ input, services }) {
      const known = await requireSession(services, input.params.session_id);
      const path = services.sessionDirs.forSession(known.id).traceZip;
      const stat = await services.files.stat(path);
      const exists = stat?.isFile === true;
      const zipUrl = `/api/v1/sessions/${encodeURIComponent(known.id)}/trace.zip`;
      return reply(200, {
        enabled: services.system.facts().traceEnabled,
        viewer_available: services.traceViewerAvailable,
        path,
        size_bytes: exists && stat !== null ? stat.size : null,
        command: `npx playwright show-trace ${path}`,
        viewer_url:
          services.traceViewerAvailable && exists
            ? `/trace-viewer/index.html?trace=${encodeURIComponent(zipUrl)}`
            : null,
      });
    },
  }),
  defineRoute({
    operationId: 'revealSessionDataDir',
    tags,
    summary: "Open the session's data directory in the host file manager (honest result).",
    request: { params: SessionIdParams },
    responses: { 200: RevealDataDirResponse },
    errors: ['SESSION_NOT_FOUND'],
    async handler({ input, services }) {
      const known = await requireSession(services, input.params.session_id);
      const result = await services.desktop.reveal(services.sessionDirs.forSession(known.id).root);
      return reply(200, {
        path: result.path,
        exists: result.exists,
        desktop: result.desktop,
        opened: result.opened,
        ...(result.reason !== undefined && { reason: result.reason }),
        ...(result.detail !== undefined && { detail: result.detail }),
      });
    },
  }),
  defineRoute({
    operationId: 'exportSession',
    tags,
    summary: 'Streamed timeline export (NDJSON or CSV by `Accept`), capped at 100k rows.',
    request: { params: SessionIdParams, query: SessionExportQuery },
    responses: {},
    raw: [
      { status: 200, contentType: 'application/x-ndjson', description: 'One item per line.' },
      { status: 200, contentType: 'text/csv', description: 'kind,ts,id,data rows.' },
    ],
    errors: ['SESSION_NOT_FOUND', 'NOT_ACCEPTABLE'],
    async handler({ input, services, ctx }) {
      const known = await requireSession(services, input.params.session_id);
      const format = negotiateExport(ctx.header('accept'));
      const items: TimelineItem[] = [];
      let cursor: string | null = null;
      let truncated = false;
      do {
        const page = await services.analytics.timeline(known.id, {
          limit: 500,
          ...(cursor !== null && { cursor }),
          ...(input.query.kinds !== undefined && { kinds: input.query.kinds }),
        });
        for (const item of page.items) {
          if (items.length === SESSION_EXPORT_MAX_ROWS) {
            truncated = true;
            break;
          }
          items.push(item);
        }
        cursor = truncated ? null : page.nextCursor;
      } while (cursor !== null);
      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (format === 'text/csv') controller.enqueue(encoder.encode(`${CSV_HEADER}\n`));
        },
        pull(controller) {
          const batch = items.slice(index, index + 500);
          index += batch.length;
          if (batch.length === 0) {
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(batch.map((item) => exportLine(item, format)).join('')),
          );
        },
      });
      const headers: Record<string, string> = {
        'content-type': format === 'text/csv' ? 'text/csv; charset=utf-8' : format,
        'content-disposition': `attachment; filename="${known.id}.${format === 'text/csv' ? 'csv' : 'ndjson'}"`,
      };
      if (truncated) headers['x-truncated'] = 'true';
      return raw(new Response(stream, { status: 200, headers }));
    },
  }),
];
