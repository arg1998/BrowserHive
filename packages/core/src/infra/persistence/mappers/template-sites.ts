/** @module infra/persistence/mappers/template-sites — `template_sites` rows ↔ records (spec 13 §2.3). JSON columns hold the snake_case wire shapes. */

import type { Insertable, Selectable } from 'kysely';
import { z } from 'zod';
import { SITE_WRITE_POLICIES, TEMPLATE_HEALTH_STATES } from '../../../ports/persistence/enums.ts';
import type {
  TemplateSiteFormRecord,
  TemplateSiteRecord,
} from '../../../ports/persistence/records-templates.ts';
import type { TemplateSites } from '../generated/db.d.ts';
import {
  boolToInt,
  intToBool,
  parseEnum,
  parseEnumOrNull,
  parseStringArray,
  toJson,
} from './codec.ts';
import { parseWith } from './templates.ts';

const formJson = z.object({
  username: z.string(),
  password: z.string(),
  submit: z.string().optional(),
  next: z.string().optional(),
});

function formFromJson(text: string | null, where: string): TemplateSiteFormRecord | null {
  if (text === null) return null;
  const j = parseWith(formJson, text, `${where}.form_json`);
  return {
    username: j.username,
    password: j.password,
    ...(j.submit !== undefined && { submit: j.submit }),
    ...(j.next !== undefined && { next: j.next }),
  };
}

/** `template_sites` row → record. */
export function templateSiteFromRow(row: Selectable<TemplateSites>): TemplateSiteRecord {
  const where = `template_sites.${row.template_id}.${row.site_id}`;
  return {
    templateId: row.template_id,
    siteId: row.site_id,
    packId: row.pack_id,
    packVersion: row.pack_version,
    enabled: intToBool(row.enabled),
    writePolicy: parseEnumOrNull(SITE_WRITE_POLICIES, row.write_policy, where),
    vaultHandle: row.vault_handle,
    autoRelogin: intToBool(row.auto_relogin),
    form: formFromJson(row.form_json, where),
    learnedCookieNames: parseStringArray(row.learned_cookie_names_json, where),
    health: {
      state: parseEnum(TEMPLATE_HEALTH_STATES, row.health_state, where),
      reason: row.health_reason,
      checkedAt: row.health_checked_at,
      changedAt: row.health_changed_at,
      consecutiveInconclusive: row.consecutive_inconclusive,
    },
    stoppedAt: row.stopped_at,
    deviceBound: intToBool(row.device_bound),
    addedAt: row.added_at,
  };
}

/** Record → `template_sites` insert row. */
export function templateSiteToRow(record: TemplateSiteRecord): Insertable<TemplateSites> {
  return {
    template_id: record.templateId,
    site_id: record.siteId,
    pack_id: record.packId,
    pack_version: record.packVersion,
    enabled: boolToInt(record.enabled),
    write_policy: record.writePolicy,
    vault_handle: record.vaultHandle,
    auto_relogin: boolToInt(record.autoRelogin),
    form_json: record.form === null ? null : toJson(record.form),
    learned_cookie_names_json: toJson(record.learnedCookieNames),
    health_state: record.health.state,
    health_reason: record.health.reason,
    health_checked_at: record.health.checkedAt,
    health_changed_at: record.health.changedAt,
    consecutive_inconclusive: record.health.consecutiveInconclusive,
    stopped_at: record.stoppedAt,
    device_bound: boolToInt(record.deviceBound),
    added_at: record.addedAt,
  };
}
