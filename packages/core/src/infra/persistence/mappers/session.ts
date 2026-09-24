/** @module infra/persistence/mappers/session — `sessions` row ↔ `SessionRecord`. */

import type { Selectable, Updateable } from 'kysely';
import {
  CLOSED_REASONS,
  PERSISTENCE_MODES,
  SESSION_CHANNELS,
  SESSION_ENGINES,
  SESSION_STATES,
} from '../../../ports/persistence/enums.ts';
import type { SessionPatch, SessionRecord } from '../../../ports/persistence/records.ts';
import type { Sessions } from '../generated/db.d.ts';
import {
  boolToInt,
  intToBool,
  parseEnum,
  parseEnumOrNull,
  parseJsonObject,
  parseJsonObjectOrNull,
  toJson,
  toJsonOrNull,
} from './codec.ts';

/** Row → record (total: throws `INTERNAL_ERROR` on a corrupt row). */
export function sessionFromRow(row: Selectable<Sessions>): SessionRecord {
  const where = `sessions.${row.session_id}`;
  return {
    sessionId: row.session_id,
    slug: row.slug,
    owner: row.owner,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    engine: parseEnum(SESSION_ENGINES, row.engine, where),
    channel: parseEnum(SESSION_CHANNELS, row.channel, where),
    headless: intToBool(row.headless),
    incognito: intToBool(row.incognito),
    persistenceMode: parseEnum(PERSISTENCE_MODES, row.persistence_mode, where),
    disableEvaluate: intToBool(row.disable_evaluate),
    vaultEnabled: intToBool(row.vault_enabled),
    stealth: intToBool(row.stealth),
    fingerprint: intToBool(row.fingerprint),
    humanize: intToBool(row.humanize),
    identity: parseJsonObjectOrNull(row.identity_json, where),
    proxyLabel: row.proxy_label,
    state: parseEnum(SESSION_STATES, row.state, where),
    createdAt: row.created_at,
    launchedAt: row.launched_at,
    lastActivityAt: row.last_activity_at,
    leaseExpiresAt: row.lease_expires_at,
    leasePausedAt: row.lease_paused_at,
    closedAt: row.closed_at,
    closedReason: parseEnumOrNull(CLOSED_REASONS, row.closed_reason, where),
    archivedAt: row.archived_at,
    lastUrl: row.last_url,
    launchMs: row.launch_ms,
    config: parseJsonObject(row.config_json, where),
    harness: row.harness,
  };
}

/** Record → insert row. */
export function sessionToRow(record: SessionRecord): Selectable<Sessions> {
  return {
    session_id: record.sessionId,
    slug: record.slug,
    owner: record.owner,
    tenant_id: record.tenantId,
    connection_id: record.connectionId,
    engine: record.engine,
    channel: record.channel,
    headless: boolToInt(record.headless),
    incognito: boolToInt(record.incognito),
    persistence_mode: record.persistenceMode,
    disable_evaluate: boolToInt(record.disableEvaluate),
    vault_enabled: boolToInt(record.vaultEnabled),
    stealth: boolToInt(record.stealth),
    fingerprint: boolToInt(record.fingerprint),
    humanize: boolToInt(record.humanize),
    identity_json: toJsonOrNull(record.identity),
    proxy_label: record.proxyLabel,
    state: record.state,
    created_at: record.createdAt,
    launched_at: record.launchedAt,
    last_activity_at: record.lastActivityAt,
    lease_expires_at: record.leaseExpiresAt,
    lease_paused_at: record.leasePausedAt,
    closed_at: record.closedAt,
    closed_reason: record.closedReason,
    archived_at: record.archivedAt,
    last_url: record.lastUrl,
    launch_ms: record.launchMs,
    config_json: toJson(record.config),
    harness: record.harness,
  };
}

/** Patch → update row (only present keys are written). */
export function sessionPatchToRow(patch: SessionPatch): Updateable<Sessions> {
  return {
    ...(patch.connectionId !== undefined && { connection_id: patch.connectionId }),
    ...(patch.identity !== undefined && { identity_json: toJsonOrNull(patch.identity) }),
    ...(patch.proxyLabel !== undefined && { proxy_label: patch.proxyLabel }),
    ...(patch.state !== undefined && { state: patch.state }),
    ...(patch.launchedAt !== undefined && { launched_at: patch.launchedAt }),
    ...(patch.lastActivityAt !== undefined && { last_activity_at: patch.lastActivityAt }),
    ...(patch.leaseExpiresAt !== undefined && { lease_expires_at: patch.leaseExpiresAt }),
    ...(patch.leasePausedAt !== undefined && { lease_paused_at: patch.leasePausedAt }),
    ...(patch.lastUrl !== undefined && { last_url: patch.lastUrl }),
    ...(patch.launchMs !== undefined && { launch_ms: patch.launchMs }),
    ...(patch.closedAt !== undefined && { closed_at: patch.closedAt }),
    ...(patch.closedReason !== undefined && { closed_reason: patch.closedReason }),
  };
}
