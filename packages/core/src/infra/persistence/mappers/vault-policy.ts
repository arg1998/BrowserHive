/** @module infra/persistence/mappers/vault-policy — `vault_bindings` / `vault_group_policies` rows ↔ records. */

import type { Selectable } from 'kysely';
import { VAULT_ACCESS_MODES } from '../../../ports/persistence/enums.ts';
import type {
  VaultBindingRecord,
  VaultGroupPolicyRecord,
} from '../../../ports/persistence/records.ts';
import type { VaultBindings, VaultGroupPolicies } from '../generated/db.d.ts';
import { boolToInt, intToBool, parseEnum, parseStringArray, toJson } from './codec.ts';

/** `harnesses_json` → list (`NULL` = every harness, D-48). */
function harnessesFromJson(raw: string | null, where: string): readonly string[] | null {
  return raw === null ? null : parseStringArray(raw, where);
}

/** List → `harnesses_json` (`null` stays `NULL`). */
function harnessesToJson(list: readonly string[] | null): string | null {
  return list === null ? null : toJson(list);
}

/** `vault_bindings` row → record. */
export function vaultBindingFromRow(row: Selectable<VaultBindings>): VaultBindingRecord {
  const where = `vault_bindings.${row.handle}`;
  return {
    handle: row.handle,
    tenantId: row.tenant_id,
    title: row.title,
    itemName: row.item_name,
    itemId: row.item_id,
    groupId: row.group_id,
    allowedOrigins: parseStringArray(row.allowed_origins_json, where),
    authorizedPrincipals: parseStringArray(row.authorized_principals_json, where),
    authorizedSessionSlugs: parseStringArray(row.authorized_session_slugs_json, where),
    allowAllSessions: intToBool(row.allow_all_sessions),
    redactUsername: intToBool(row.redact_username),
    requireNoEvaluate: intToBool(row.require_no_evaluate),
    dashboardConfirm: intToBool(row.dashboard_confirm),
    harnesses: harnessesFromJson(row.harnesses_json, where),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record → `vault_bindings` insert row. */
export function vaultBindingToRow(record: VaultBindingRecord): Selectable<VaultBindings> {
  return {
    handle: record.handle,
    tenant_id: record.tenantId,
    title: record.title,
    item_name: record.itemName,
    item_id: record.itemId,
    group_id: record.groupId,
    allowed_origins_json: toJson(record.allowedOrigins),
    authorized_principals_json: toJson(record.authorizedPrincipals),
    authorized_session_slugs_json: toJson(record.authorizedSessionSlugs),
    allow_all_sessions: boolToInt(record.allowAllSessions),
    redact_username: boolToInt(record.redactUsername),
    require_no_evaluate: boolToInt(record.requireNoEvaluate),
    dashboard_confirm: boolToInt(record.dashboardConfirm),
    harnesses_json: harnessesToJson(record.harnesses),
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

/** `vault_group_policies` row → record. */
export function vaultGroupPolicyFromRow(
  row: Selectable<VaultGroupPolicies>,
): VaultGroupPolicyRecord {
  const where = `vault_group_policies.${row.group_key}`;
  return {
    groupKey: row.group_key,
    groupId: row.group_id,
    tenantId: row.tenant_id,
    accessMode: parseEnum(VAULT_ACCESS_MODES, row.access_mode, where),
    allowAllSessions: intToBool(row.allow_all_sessions),
    sessionSlugGlobs: parseStringArray(row.session_slug_globs_json, where),
    authorizedPrincipals: parseStringArray(row.authorized_principals_json, where),
    dashboardConfirm: intToBool(row.dashboard_confirm),
    requireNoEvaluate: intToBool(row.require_no_evaluate),
    redactUsername: intToBool(row.redact_username),
    harnesses: harnessesFromJson(row.harnesses_json, where),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Record → `vault_group_policies` insert row. */
export function vaultGroupPolicyToRow(
  record: VaultGroupPolicyRecord,
): Selectable<VaultGroupPolicies> {
  return {
    group_key: record.groupKey,
    group_id: record.groupId,
    tenant_id: record.tenantId,
    access_mode: record.accessMode,
    allow_all_sessions: boolToInt(record.allowAllSessions),
    session_slug_globs_json: toJson(record.sessionSlugGlobs),
    authorized_principals_json: toJson(record.authorizedPrincipals),
    dashboard_confirm: boolToInt(record.dashboardConfirm),
    require_no_evaluate: boolToInt(record.requireNoEvaluate),
    redact_username: boolToInt(record.redactUsername),
    harnesses_json: harnessesToJson(record.harnesses),
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}
