/** @module ports/persistence/site-packs — rows and repositories of schema v10 (`0010-site-packs`, spec 13 §9.9): the per-pack approval state, the candidate and decision history, and the guard-hit audit. */

import type { Page, PageQuery, TimeWindow } from './queries.ts';

/** Where a pack version came from (`site_pack_state.approved_source`, `site_pack_changes.source`). */
export const SITE_PACK_SOURCES = ['bundled', 'remote', 'import', 'local'] as const;
/** Element of {@link SITE_PACK_SOURCES}. */
export type SitePackSourceId = (typeof SITE_PACK_SOURCES)[number];

/** `site_pack_changes.classification` (`unclassified` only in rows written before the classifier, T3a). */
export const SITE_PACK_CLASSIFICATIONS = [
  'unclassified',
  'tightening',
  'restrictive',
  'loosening',
  'neutral',
  'new_pack',
  'revoked',
  'local_override',
] as const;
/** Element of {@link SITE_PACK_CLASSIFICATIONS}. */
export type SitePackClassificationValue = (typeof SITE_PACK_CLASSIFICATIONS)[number];

/** `site_pack_changes.decision`. */
export const SITE_PACK_DECISIONS = [
  'available',
  'downloaded',
  'auto',
  'approved',
  'rejected',
  'superseded',
  'reverted',
] as const;
/** Element of {@link SITE_PACK_DECISIONS}. */
export type SitePackDecisionValue = (typeof SITE_PACK_DECISIONS)[number];

/** `site_guard_hits.guard_kind` (`stop`: a stopped site's refusal). */
export const SITE_GUARD_KINDS = [
  'logout',
  'account',
  'credential',
  'destructive',
  'write',
  'stop',
] as const;
/** Element of {@link SITE_GUARD_KINDS}. */
export type SiteGuardKindValue = (typeof SITE_GUARD_KINDS)[number];

/** `site_guard_hits.action`. */
export const SITE_GUARD_ACTIONS = ['block', 'confirm', 'warn', 'paced', 'held'] as const;
/** Element of {@link SITE_GUARD_ACTIONS}. */
export type SiteGuardActionValue = (typeof SITE_GUARD_ACTIONS)[number];

/** `site_guard_hits.outcome` (confirmations only). */
export const SITE_GUARD_OUTCOMES = ['approved', 'denied', 'timeout', 'cancelled'] as const;
/** Element of {@link SITE_GUARD_OUTCOMES}. */
export type SiteGuardOutcomeValue = (typeof SITE_GUARD_OUTCOMES)[number];

/** `site_guard_hits.source`. */
export const SITE_GUARD_SOURCES = ['tool', 'request', 'element'] as const;
/** Element of {@link SITE_GUARD_SOURCES}. */
export type SiteGuardSourceValue = (typeof SITE_GUARD_SOURCES)[number];

/** What the operator was shown at approval (`approved_provenance_json`). */
export type SitePackProvenanceRecord =
  | { readonly kind: 'bundled'; readonly release: string }
  | { readonly kind: 'remote'; readonly keyId: string; readonly indexVersion: number }
  | {
      readonly kind: 'import';
      readonly file: string;
      /** A signed import: the online key and index version it verified with. */
      readonly keyId?: string;
      readonly indexVersion?: number;
    }
  | { readonly kind: 'local'; readonly path: string };

/** One `site_pack_state` row (configuration class: never pruned). */
export interface SitePackStateRecord {
  readonly packId: string;
  readonly approvedVersion: number | null;
  readonly approvedSha256: string | null;
  readonly approvedSource: SitePackSourceId | null;
  readonly approvedProvenance: SitePackProvenanceRecord | null;
  /** The scope the operator approved. */
  readonly approvedDomains: readonly string[];
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  /** Kept for Revert. */
  readonly previousVersion: number | null;
  readonly previousSha256: string | null;
  readonly previousSource: SitePackSourceId | null;
  /** An unsigned local file (spec 13 §10.5). */
  readonly localPath: string | null;
  readonly localApprovedSha256: string | null;
  readonly localApprovedBy: string | null;
  readonly localApprovedAt: number | null;
  /** `null` = not pinned. */
  readonly pinnedVersion: number | null;
  /** `null` = automatic (followed while a template uses the pack). */
  readonly follow: boolean | null;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

/** A fresh state row (nothing approved). */
export function emptySitePackState(packId: string, now: number): SitePackStateRecord {
  return {
    packId,
    approvedVersion: null,
    approvedSha256: null,
    approvedSource: null,
    approvedProvenance: null,
    approvedDomains: [],
    approvedBy: null,
    approvedAt: null,
    previousVersion: null,
    previousSha256: null,
    previousSource: null,
    localPath: null,
    localApprovedSha256: null,
    localApprovedBy: null,
    localApprovedAt: null,
    pinnedVersion: null,
    follow: null,
    enabled: true,
    updatedAt: now,
  };
}

/** How a list read reports a row it cannot map (a corrupt cell); the row is left out. */
export interface UnreadableRowOptions {
  readonly onUnreadable?: (packId: string, error: unknown) => void;
}

/** Repository over `site_pack_state`. */
export interface SitePackStateRepository {
  /** Every row; an unreadable one is reported to `onUnreadable` and left out (else it throws). */
  list(options?: UnreadableRowOptions): Promise<readonly SitePackStateRecord[]>;
  get(packId: string): Promise<SitePackStateRecord | null>;
  /** Inserts or replaces the whole row. */
  put(record: SitePackStateRecord): Promise<void>;
}

/** One change field (`diff_json` element). */
export interface SitePackChangeFieldRecord {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
  /** `null` for a new pack's fields, and in rows written before the classifier (T3a). */
  readonly class: 'tightening' | 'restrictive' | 'loosening' | 'neutral' | null;
}

/** One `site_pack_changes` row (audit class). */
export interface SitePackChangeRecord {
  /** Assigned by the store; `0` on insert. */
  readonly seq: number;
  readonly eventId: string;
  readonly packId: string;
  readonly fromVersion: number | null;
  /** `null` for a local file. */
  readonly toVersion: number | null;
  readonly toSha256: string;
  readonly source: SitePackSourceId;
  readonly classification: SitePackClassificationValue;
  readonly newDomains: readonly string[];
  readonly notes: string | null;
  /** `null` until downloaded (always set for bundled and local candidates). */
  readonly diff: readonly SitePackChangeFieldRecord[] | null;
  readonly decision: SitePackDecisionValue;
  readonly decidedBy: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

/** `GET /site-packs/changes` filters. */
export interface SitePackChangeQuery extends PageQuery {
  readonly packId?: string;
  readonly decisions?: readonly SitePackDecisionValue[];
  readonly window?: TimeWindow;
}

/** Repository over `site_pack_changes`. */
export interface SitePackChangeRepository {
  /** Inserts and returns the stored row with its `seq`. */
  insert(record: SitePackChangeRecord): Promise<SitePackChangeRecord>;
  /** Sets the decision of one row, by its `event_id` (`seq` may be reused after pruning). */
  decide(
    eventId: string,
    decision: SitePackDecisionValue,
    by: string | null,
    at: number,
  ): Promise<void>;
  /**
   * Sets the classification and the classified diff of one row, by its `event_id` (spec 13 §9.7:
   * a pending candidate is re-classified at each load, as the templates using its pack change).
   */
  classify(
    eventId: string,
    classification: SitePackClassificationValue,
    diff: readonly SitePackChangeFieldRecord[] | null,
    /** The baseline the classification compared against, rewritten with it (review #100 M3). */
    baseline?: { readonly fromVersion: number | null; readonly newDomains: readonly string[] },
  ): Promise<void>;
  /**
   * A registry or imported candidate was downloaded and verified (spec 13 §10.6): `downloaded`
   * with its classification, field diff and new domains, by its `event_id`.
   */
  markDownloaded(
    eventId: string,
    fields: {
      readonly classification: SitePackClassificationValue;
      readonly diff: readonly SitePackChangeFieldRecord[];
      readonly newDomains: readonly string[];
    },
  ): Promise<void>;
  /** The newest row for this candidate (pack, sha256, source), or `null`. */
  findCandidate(
    packId: string,
    sha256: string,
    source: SitePackSourceId,
  ): Promise<SitePackChangeRecord | null>;
  /** Rows whose decision is `available` or `downloaded`, oldest first (unreadable rows as in `list`). */
  listPending(options?: UnreadableRowOptions): Promise<readonly SitePackChangeRecord[]>;
  /** Newest first, cursor-paged. */
  list(query: SitePackChangeQuery): Promise<Page<SitePackChangeRecord>>;
  /**
   * Deletes decided rows created before `before` (audit retention); pending candidates
   * (`available`, `downloaded`) are live state and kept. Returns the count.
   */
  pruneBefore(before: number): Promise<number>;
}

/** One `site_guard_hits` row (audit class). */
export interface SiteGuardHitRecord {
  readonly eventId: string;
  /** `null` for host-owned requests, and once the session row is pruned. */
  readonly sessionId: string | null;
  readonly templateId: string | null;
  readonly packId: string;
  readonly guardId: string;
  readonly guardKind: SiteGuardKindValue;
  readonly action: SiteGuardActionValue;
  readonly outcome: SiteGuardOutcomeValue | null;
  readonly decidedBy: string | null;
  readonly source: SiteGuardSourceValue;
  readonly method: string | null;
  /** Sanitized (D-20). */
  readonly url: string;
  readonly requestId: string | null;
  readonly tool: string | null;
  readonly ts: number;
}

/** `GET /site-packs/guard-hits` filters. */
export interface SiteGuardHitQuery extends PageQuery {
  readonly templateId?: string;
  readonly sessionId?: string;
  readonly packId?: string;
  readonly actions?: readonly SiteGuardActionValue[];
  /** `since <= ts <= until` (inclusive, like every timeline source). */
  readonly window?: TimeWindow;
  /** Free text over the URL, pack id and guard id. */
  readonly q?: string;
  /** Leave out approved confirmations (the timeline's `errors_only`). */
  readonly excludeApproved?: boolean;
}

/** Repository over `site_guard_hits`. */
export interface SiteGuardHitRepository {
  insert(record: SiteGuardHitRecord): Promise<void>;
  /** Newest first, cursor-paged on `(ts, event_id)`. */
  list(query: SiteGuardHitQuery): Promise<Page<SiteGuardHitRecord>>;
  /** Counts per template since `since` (template page, digests). */
  countByTemplate(templateId: string, since: number): Promise<number>;
  pruneBefore(before: number): Promise<number>;
}

/**
 * The registry client's values in the `meta` table (spec 13 §9.9: the rollback floors
 * `site_packs.keys_version` and `site_packs.index_version`, and the client's status), so no
 * migration is needed. Only keys under `site_packs.` are reachable.
 */
export interface SitePackMetaRepository {
  get(key: SitePackMetaKey): Promise<string | null>;
  set(key: SitePackMetaKey, value: string): Promise<void>;
}

/** The `meta` keys of the registry client. */
export const SITE_PACK_META_KEYS = [
  'site_packs.keys_version',
  'site_packs.index_version',
  'site_packs.client',
] as const;
/** Element of {@link SITE_PACK_META_KEYS}. */
export type SitePackMetaKey = (typeof SITE_PACK_META_KEYS)[number];
