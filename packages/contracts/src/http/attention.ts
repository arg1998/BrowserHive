/** @module contracts/http/attention — operator requests: attention and vault-confirm views (spec 03 §4.4, D-15) */
import { z } from 'zod';
import { AttentionMode, OperatorRequestKind, OperatorRequestStatus } from '../enums/index.ts';
import { EventId, OperatorRequestId, SessionId } from '../ids/index.ts';
import {
  BulkItemError,
  Count,
  csv,
  DurationMs,
  EpochMs,
  Facet,
  listQuery,
  page,
  QueryText,
  sortable,
  windowQuery,
} from './common.ts';

/** Maximum ids per bulk operator-request action. */
export const BULK_REQUESTS_MAX = 100;
/** Maximum length of an operator message / deny reason. */
export const OPERATOR_MESSAGE_MAX = 500;

/** Path params for `/attention/{request_id}/…` and `/vault/confirm/{request_id}/…`. */
export const RequestIdParams = z.strictObject({ request_id: OperatorRequestId });
/** Path params for `/…/{request_id}/…`. */
export type RequestIdParams = z.infer<typeof RequestIdParams>;

/**
 * One operator request (`operator_requests` row) — both kinds share the shape; `mode` is set for
 * `attention`, `entry_name` for `vault_confirm`. Decision-grade context (`page_url`, `tool`,
 * `event_id`) is included so the operator can decide without opening the session.
 */
export const OperatorRequestRow = z.object({
  request_id: OperatorRequestId,
  kind: OperatorRequestKind,
  session_id: SessionId,
  session_slug: z.string(),
  owner: z.string(),
  reason: z.string(),
  mode: AttentionMode.nullable(),
  options: z.unknown().nullable(),
  status: OperatorRequestStatus,
  message: z.string().nullable(),
  resolved_by: z.string().nullable(),
  resolution_reason: z.string().nullable(),
  created_at: EpochMs,
  resolved_at: EpochMs.nullable(),
  deadline_at: EpochMs.nullable(),
  waited_ms: DurationMs.nullable(),
  page_url: z.string().nullable(),
  tool: z.string().nullable(),
  event_id: EventId.nullable(),
  entry_name: z.string().nullable(),
});
/** One operator request. */
export type OperatorRequestRow = z.infer<typeof OperatorRequestRow>;

/** Sort keys accepted by `GET /attention`. */
export const AttentionSortKey = sortable(['created_at', 'resolved_at', 'waited_ms']);
/** Sort keys accepted by `GET /attention`. */
export type AttentionSortKey = z.infer<typeof AttentionSortKey>;

/** `GET /attention` query. */
export const AttentionQuery = listQuery({
  sort: AttentionSortKey.default('created_at'),
  filters: {
    status: csv(OperatorRequestStatus),
    mode: csv(AttentionMode),
    session_id: SessionId.optional(),
    q: QueryText.optional(),
    ...windowQuery,
  },
});
/** `GET /attention` query. */
export type AttentionQuery = z.infer<typeof AttentionQuery>;

/** `GET /sessions/{session_id}/attention` query. */
export const SessionAttentionQuery = listQuery({
  sort: AttentionSortKey.default('created_at'),
  filters: { status: csv(OperatorRequestStatus), mode: csv(AttentionMode) },
});
/** `GET /sessions/{session_id}/attention` query. */
export type SessionAttentionQuery = z.infer<typeof SessionAttentionQuery>;

/**
 * `GET /attention` body: `Page<OperatorRequestRow>` plus the live open count and facet counts.
 * Facets are disjunctive: `status` counts honour every filter except `status`, `mode` counts every
 * filter except `mode`, so unselected chips show what selecting them would add.
 */
export const AttentionPage = page(OperatorRequestRow).extend({
  open_count: Count,
  facets: z.object({ status: z.array(Facet), mode: z.array(Facet) }),
});
/** `GET /attention` body. */
export type AttentionPage = z.infer<typeof AttentionPage>;

/** `GET /sessions/{session_id}/attention` body. */
export const SessionAttentionPage = page(OperatorRequestRow);
/** `GET /sessions/{session_id}/attention` body. */
export type SessionAttentionPage = z.infer<typeof SessionAttentionPage>;

/** Attention decisions (a closed enum: any other value is rejected, never read as resolve). */
export const AttentionDecision = z.enum(['resolve', 'reject']);
/** Attention decisions. */
export type AttentionDecision = z.infer<typeof AttentionDecision>;

/** `POST /attention/{request_id}/resolve` body. */
export const ResolveAttentionRequest = z.strictObject({
  decision: AttentionDecision,
  message: z.string().trim().max(OPERATOR_MESSAGE_MAX).optional(),
});
/** `POST /attention/{request_id}/resolve` body. */
export type ResolveAttentionRequest = z.infer<typeof ResolveAttentionRequest>;

/** Resolution acknowledgement shared by attention and vault confirm. */
export const ResolveRequestResponse = z.object({
  ok: z.literal(true),
  status: OperatorRequestStatus,
});
/** Resolution acknowledgement. */
export type ResolveRequestResponse = z.infer<typeof ResolveRequestResponse>;

/** `POST /attention/bulk` body (requires `Idempotency-Key`). */
export const BulkAttentionRequest = z.strictObject({
  action: AttentionDecision,
  request_ids: z.array(OperatorRequestId).min(1).max(BULK_REQUESTS_MAX),
  message: z.string().trim().max(OPERATOR_MESSAGE_MAX).optional(),
});
/** `POST /attention/bulk` body. */
export type BulkAttentionRequest = z.infer<typeof BulkAttentionRequest>;

/** One item of a bulk operator-request result. */
export const BulkRequestResult = z.object({
  request_id: OperatorRequestId,
  ok: z.boolean(),
  error: BulkItemError.optional(),
});
/** One item of a bulk operator-request result. */
export type BulkRequestResult = z.infer<typeof BulkRequestResult>;

/** Bulk operator-request 200 body (shared by attention and vault confirm). */
export const BulkRequestsResponse = z.object({
  results: z.array(BulkRequestResult),
  ok_count: Count,
  error_count: Count,
});
/** Bulk operator-request 200 body. */
export type BulkRequestsResponse = z.infer<typeof BulkRequestsResponse>;

/** `GET /vault/confirm` query. */
export const VaultConfirmQuery = listQuery({
  sort: sortable(['created_at', 'resolved_at']).default('created_at'),
  filters: { status: csv(OperatorRequestStatus), session_id: SessionId.optional() },
});
/** `GET /vault/confirm` query. */
export type VaultConfirmQuery = z.infer<typeof VaultConfirmQuery>;

/** `GET /vault/confirm` body (rows have `kind: 'vault_confirm'`). */
export const VaultConfirmPage = page(OperatorRequestRow).extend({ open_count: Count });
/** `GET /vault/confirm` body. */
export type VaultConfirmPage = z.infer<typeof VaultConfirmPage>;

/** Vault confirm decisions. */
export const VaultConfirmDecision = z.enum(['approve', 'deny']);
/** Vault confirm decisions. */
export type VaultConfirmDecision = z.infer<typeof VaultConfirmDecision>;

/** `POST /vault/confirm/{request_id}/resolve` body; `reason` is audit-only (≤ 500). */
export const ResolveVaultConfirmRequest = z.strictObject({
  decision: VaultConfirmDecision,
  reason: z.string().trim().max(OPERATOR_MESSAGE_MAX).optional(),
});
/** `POST /vault/confirm/{request_id}/resolve` body. */
export type ResolveVaultConfirmRequest = z.infer<typeof ResolveVaultConfirmRequest>;

/** `POST /vault/confirm/bulk` body (requires `Idempotency-Key`). */
export const BulkVaultConfirmRequest = z.strictObject({
  action: VaultConfirmDecision,
  request_ids: z.array(OperatorRequestId).min(1).max(BULK_REQUESTS_MAX),
  reason: z.string().trim().max(OPERATOR_MESSAGE_MAX).optional(),
});
/** `POST /vault/confirm/bulk` body. */
export type BulkVaultConfirmRequest = z.infer<typeof BulkVaultConfirmRequest>;
