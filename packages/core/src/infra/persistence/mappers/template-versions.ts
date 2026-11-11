/** @module infra/persistence/mappers/template-versions — `template_versions` rows ↔ records (spec 13 §2.5, §3.9). JSON columns hold the snake_case wire shapes; cookie names only, never a value (D-20). */

import type { Insertable, Selectable } from 'kysely';
import { z } from 'zod';
import {
  TEMPLATE_HEALTH_STATES,
  TEMPLATE_VERSION_REASONS,
} from '../../../ports/persistence/enums.ts';
import type {
  TemplateVersionHealthRecord,
  TemplateVersionRecord,
  TemplateVersionSummaryRecord,
} from '../../../ports/persistence/records-templates.ts';
import type { TemplateVersions } from '../generated/db.d.ts';
import { boolToInt, intToBool, parseEnum, toJson } from './codec.ts';
import { parseWith } from './templates.ts';

const summaryJson = z.object({
  domains: z.array(
    z.object({
      domain: z.string(),
      cookies: z.number().int().nonnegative(),
      sign_in_cookies: z.array(z.string()),
      earliest_expiry: z.number().nullable(),
      session_cookie: z.boolean(),
    }),
  ),
  storage_origins: z.number().int().nonnegative(),
});

const healthJson = z.array(
  z.object({
    site_id: z.string(),
    state: z.enum(TEMPLATE_HEALTH_STATES),
    enabled: z.boolean(),
    sign_in_complete: z.boolean().nullable().optional(),
  }),
);

function summaryFromJson(text: string, where: string): TemplateVersionSummaryRecord {
  const j = parseWith(summaryJson, text, `${where}.summary_json`);
  return {
    domains: j.domains.map((d) => ({
      domain: d.domain,
      cookies: d.cookies,
      signInCookies: d.sign_in_cookies,
      earliestExpiry: d.earliest_expiry,
      sessionCookie: d.session_cookie,
    })),
    storageOrigins: j.storage_origins,
  };
}

function summaryToJson(summary: TemplateVersionSummaryRecord): string {
  return toJson({
    domains: summary.domains.map((d) => ({
      domain: d.domain,
      cookies: d.cookies,
      sign_in_cookies: [...d.signInCookies],
      earliest_expiry: d.earliestExpiry,
      session_cookie: d.sessionCookie,
    })),
    storage_origins: summary.storageOrigins,
  });
}

function healthFromJson(text: string, where: string): readonly TemplateVersionHealthRecord[] {
  return parseWith(healthJson, text, `${where}.health_json`).map((h) => ({
    siteId: h.site_id,
    state: h.state,
    enabled: h.enabled,
    signInComplete: h.sign_in_complete ?? null,
  }));
}

function healthToJson(health: readonly TemplateVersionHealthRecord[]): string {
  return toJson(
    health.map((h) => ({
      site_id: h.siteId,
      state: h.state,
      enabled: h.enabled,
      sign_in_complete: h.signInComplete,
    })),
  );
}

/** `template_versions` row → record. */
export function templateVersionFromRow(row: Selectable<TemplateVersions>): TemplateVersionRecord {
  const where = `template_versions.${row.template_id}.${row.version}`;
  return {
    templateId: row.template_id,
    version: row.version,
    reason: parseEnum(TEMPLATE_VERSION_REASONS, row.reason, where),
    restoredFrom: row.restored_from,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    keyId: row.key_id,
    structureSha256: row.structure_sha256,
    summary: summaryFromJson(row.summary_json, where),
    health: healthFromJson(row.health_json, where),
    pinned: intToBool(row.pinned),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Record → `template_versions` row. */
export function templateVersionToRow(record: TemplateVersionRecord): Insertable<TemplateVersions> {
  return {
    template_id: record.templateId,
    version: record.version,
    reason: record.reason,
    restored_from: record.restoredFrom,
    size_bytes: record.sizeBytes,
    sha256: record.sha256,
    key_id: record.keyId,
    structure_sha256: record.structureSha256,
    summary_json: summaryToJson(record.summary),
    health_json: healthToJson(record.health),
    pinned: boolToInt(record.pinned),
    created_by: record.createdBy,
    created_at: record.createdAt,
  };
}
