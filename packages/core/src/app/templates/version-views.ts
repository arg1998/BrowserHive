/** @module app/templates/version-views — version records → `TemplateVersionRow` (spec 13 §11.1) and the versions page with its keyset cursor (newest first). */

import type { TemplateVersionRow, TemplateVersionsPage } from '@browserhive/contracts/http';
import { z } from 'zod';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { TemplateVersionRecord } from '../../ports/persistence/index.ts';

/** One version for operators. */
export function toVersionRow(
  record: TemplateVersionRecord,
  facts: { readonly lastGood: number | null; readonly readable: boolean },
): TemplateVersionRow {
  return {
    version: record.version,
    reason: record.reason,
    restored_from: record.restoredFrom,
    size_bytes: record.sizeBytes,
    summary: {
      domains: record.summary.domains.map((d) => ({
        domain: d.domain,
        cookies: d.cookies,
        sign_in_cookies: [...d.signInCookies],
        earliest_expiry: d.earliestExpiry,
        session_cookie: d.sessionCookie,
      })),
      storage_origins: record.summary.storageOrigins,
    },
    health: record.health.map((h) => ({ site_id: h.siteId, state: h.state, enabled: h.enabled })),
    pinned: record.pinned,
    last_good: facts.lastGood === record.version,
    readable: facts.readable,
    created_by: record.createdBy,
    created_at: record.createdAt,
  };
}

const RESOURCE = 'template_versions';
const cursorSchema = z.object({ r: z.literal(RESOURCE), v: z.number().int().positive() });

function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ r: RESOURCE, v: version }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    raw = undefined;
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      issues: [
        { path: 'cursor', message: `cursor is not valid for ${RESOURCE}`, code: 'invalid_cursor' },
      ],
    });
  }
  return parsed.data.v;
}

/** One page of rows (already newest first) after `cursor`. */
export function pageVersions(
  rows: readonly TemplateVersionRow[],
  query: { readonly cursor?: string | undefined; readonly limit: number },
  checkpoint: TemplateVersionsPage['checkpoint'],
  now: number,
): TemplateVersionsPage {
  const after = decodeCursor(query.cursor);
  const rest = after === null ? rows : rows.filter((r) => r.version < after);
  const data = rest.slice(0, query.limit);
  const last = data[data.length - 1];
  return {
    data,
    page: {
      next_cursor:
        rest.length > data.length && last !== undefined ? encodeCursor(last.version) : null,
      limit: query.limit,
    },
    applied: { filters: {}, sort: { key: 'version', dir: 'desc' } },
    meta: { now },
    checkpoint,
  };
}
