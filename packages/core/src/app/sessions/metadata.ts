/** @module app/sessions/metadata — wire and storage projections of a Session: tool SessionMetadata, HTTP/WS SessionSummary, DB SessionRecord/SessionPatch. */

import type { StealthDriverName } from '@browserhive/contracts/enums';
import type { SessionSummary } from '@browserhive/contracts/http';
import { SessionId } from '@browserhive/contracts/ids';
import type {
  SessionMetadata,
  AppliedIdentity as WireIdentity,
} from '@browserhive/contracts/tools';
import type { SessionClientInfo } from '../../domain/session/client-info.ts';
import type { Session } from '../../domain/session/session.ts';
import { isOpen } from '../../domain/session/state.ts';
import { redactKeys } from '../../kernel/redact.ts';
import type { AppliedIdentity } from '../../ports/browser-driver.ts';
import type { JsonObject, SessionPatch, SessionRecord } from '../../ports/persistence/records.ts';

/** `SessionMetadata` plus the extra `driver` key (`patchright`/`playwright`, D-13). */
export type SessionMetadataWithDriver = SessionMetadata & {
  readonly driver: StealthDriverName | null;
};

/**
 * `page.url()` can throw "Target closed" once the connection dropped. Defensive: `null` instead,
 * since metadata is read from listings where one dead session must not poison the whole list.
 */
export function safeCurrentUrl(session: Session): string | null {
  if (session.dead) return null;
  try {
    return session.tabs.activePage()?.url() ?? session.currentUrl;
  } catch {
    return null;
  }
}

/** Deep copy of the applied identity in the (mutable-array) wire shape; camelCase keys are frozen by D-12. */
export function toWireIdentity(identity: AppliedIdentity | null): WireIdentity | null {
  if (identity === null) return null;
  return {
    userAgent: identity.userAgent,
    brands: identity.brands.map((b) => ({ brand: b.brand, version: b.version })),
    platform: identity.platform,
    deviceMemory: identity.deviceMemory,
    chromeMajor: identity.chromeMajor,
    geo:
      identity.geo === null
        ? null
        : {
            locale: identity.geo.locale,
            languages: [...identity.geo.languages],
            countryCode: identity.geo.countryCode,
            timezoneId: identity.geo.timezoneId,
            source: identity.geo.source,
          },
    display:
      identity.display === null
        ? null
        : {
            screen: { ...identity.display.screen },
            viewport: { ...identity.display.viewport },
            deviceScaleFactor: identity.display.deviceScaleFactor,
          },
  };
}

function identityJson(session: Session): JsonObject | null {
  const wire = toWireIdentity(session.identity);
  return wire === null ? null : { ...wire };
}

/** The `launch_session`/`list_sessions` shape (session metadata plus `proxy_label` and `driver`). */
export function toSessionMetadata(session: Session): SessionMetadataWithDriver {
  const request = session.request;
  return {
    session_id: session.id,
    slug: session.slug,
    channel: request.channel,
    incognito: request.incognito,
    headless: request.headless,
    persistence_mode: request.persistenceMode,
    current_url: safeCurrentUrl(session),
    created_at: session.createdAt,
    owner: session.owner,
    lease_expires_at: session.lease.expiresAt,
    lease_paused_at: session.lease.pausedAt,
    disable_evaluate: request.disableEvaluate,
    vault_enabled: request.vaultEnabled,
    stealth: request.stealth,
    fingerprint: request.fingerprint,
    humanize: request.humanize,
    identity: toWireIdentity(session.identity),
    proxy_label: session.proxyLabel,
    driver: session.driver,
  };
}

/** `SessionSummary.client`: the self-reported client that launched the session, or `null`. */
export function toWireClient(client: SessionClientInfo | null): SessionSummary['client'] {
  if (client === null) return null;
  return {
    name: client.name,
    version: client.version,
    ...(client.agentName !== null && { agent_name: client.agentName }),
    ...(client.model !== null && { model: client.model }),
  };
}

/** The one HTTP/WS shape (spec 03 §4.2). `has_live_viewers` is enriched by the interface layer. */
export function toSessionSummary(session: Session, now: number): SessionSummary {
  const request = session.request;
  return {
    session_id: SessionId.parse(session.id),
    slug: session.slug,
    owner: session.owner,
    tenant_id: request.tenantId,
    channel: request.channel,
    engine: 'chromium',
    headless: request.headless,
    incognito: request.incognito,
    persistence_mode: request.persistenceMode,
    current_url: safeCurrentUrl(session),
    created_at: session.createdAt,
    last_activity_at: session.lastActivityAt,
    closed_at: session.closedAt,
    closed_reason: session.closedReason,
    archived_at: null,
    lease_expires_at: session.lease.expiresAt,
    lease_paused_at: session.lease.pausedAt,
    lease_remaining_ms: session.leaseRemainingMs(now),
    state: session.state.kind,
    live: isOpen(session.state),
    disable_evaluate: request.disableEvaluate,
    vault_enabled: request.vaultEnabled,
    stealth: request.stealth,
    fingerprint: request.fingerprint,
    humanize: request.humanize,
    stealth_recorded: request.stealth && session.identity !== null,
    identity: identityJson(session),
    proxy_label: session.proxyLabel,
    counts: {
      tool_calls: session.counts.toolCalls,
      errors: session.counts.errors,
      pages: session.counts.pages,
      blocked: session.counts.blocked,
      attention_open: session.counts.attentionOpen,
      vault_access: session.counts.vaultAccess,
    },
    has_live_viewers: false,
    client: toWireClient(request.client),
  };
}

/** The launch configuration snapshot stored in `sessions.config_json` (key-redacted). */
export function configJson(session: Session): JsonObject {
  const request = session.request;
  const snapshot: JsonObject = {
    slug: request.slug,
    channel: request.channel,
    incognito: request.incognito,
    headless: request.headless,
    persistence_mode: request.persistenceMode,
    restore_profile: request.restoreProfile,
    storage_state: request.storageStateName,
    launch_options: request.launchOptions ?? null,
    context_options: request.contextOptions ?? null,
    disable_evaluate: request.disableEvaluate,
    vault_enabled: request.vaultEnabled,
    stealth: request.stealth,
    fingerprint: request.fingerprint,
    humanize: request.humanize,
  };
  const redacted: unknown = redactKeys(snapshot);
  return redacted !== null && typeof redacted === 'object' ? { ...redacted } : snapshot;
}

/** The `sessions` row for a freshly reserved session. */
export function toSessionRecord(session: Session): SessionRecord {
  const request = session.request;
  return {
    sessionId: session.id,
    slug: session.slug,
    owner: session.owner,
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    engine: 'chromium',
    channel: request.channel,
    headless: request.headless,
    incognito: request.incognito,
    persistenceMode: request.persistenceMode,
    disableEvaluate: request.disableEvaluate,
    vaultEnabled: request.vaultEnabled,
    stealth: request.stealth,
    fingerprint: request.fingerprint,
    humanize: request.humanize,
    identity: identityJson(session),
    proxyLabel: session.proxyLabel,
    state: session.state.kind,
    createdAt: session.createdAt,
    launchedAt: session.launchedAt,
    lastActivityAt: session.lastActivityAt,
    leaseExpiresAt: session.lease.expiresAt,
    leasePausedAt: session.lease.pausedAt,
    closedAt: session.closedAt,
    closedReason: session.closedReason,
    archivedAt: null,
    lastUrl: safeCurrentUrl(session),
    launchMs: session.launchMs,
    config: configJson(session),
  };
}

/** The mutable columns as they stand now (`session.updated` carries this so the recorder patches blindly). */
export function toSessionPatch(session: Session): SessionPatch {
  return {
    identity: identityJson(session),
    proxyLabel: session.proxyLabel,
    state: session.state.kind,
    launchedAt: session.launchedAt,
    lastActivityAt: session.lastActivityAt,
    leaseExpiresAt: session.lease.expiresAt,
    leasePausedAt: session.lease.pausedAt,
    lastUrl: safeCurrentUrl(session),
    launchMs: session.launchMs,
    closedAt: session.closedAt,
    closedReason: session.closedReason,
  };
}
