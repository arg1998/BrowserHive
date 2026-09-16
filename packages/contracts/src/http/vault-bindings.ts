/** @module contracts/http/vault-bindings — bindings CRUD, origin resolver, access log, export/import (spec 03 §4.5) */
import { z } from 'zod';
import { EventId, SessionId } from '../ids/index.ts';
import {
  Count,
  csv,
  EpochMs,
  listQuery,
  page,
  QueryText,
  sortable,
  windowQuery,
} from './common.ts';
import { VaultAccessMode, VaultGroupPolicy } from './vault.ts';

/** Binding handle grammar: lowercase slug-ish token derived from `<group>/<item>`. */
export const VAULT_HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Binding handle. */
export const VaultHandle = z.string().regex(VAULT_HANDLE_RE);
/** Vault export document version (spec 03 §4.5). */
export const VAULT_EXPORT_VERSION = 3;

/** Path params for `/vault/bindings/{handle}`. */
export const HandleParams = z.strictObject({ handle: VaultHandle });
/** Path params for `/vault/bindings/{handle}`. */
export type HandleParams = z.infer<typeof HandleParams>;

/** One binding (`vault_bindings` row). */
export const VaultBinding = z.object({
  handle: VaultHandle,
  title: z.string(),
  item_name: z.string(),
  item_id: z.string(),
  group_id: z.string().nullable(),
  allowed_origins: z.array(z.string()),
  authorized_principals: z.array(z.string()),
  authorized_session_slugs: z.array(z.string()),
  allow_all_sessions: z.boolean(),
  redact_username: z.boolean(),
  require_no_evaluate: z.boolean(),
  dashboard_confirm: z.boolean(),
  created_at: EpochMs,
  updated_at: EpochMs,
  version: z.number().int().positive(),
});
/** One binding. */
export type VaultBinding = z.infer<typeof VaultBinding>;

/** `GET /vault/bindings` query. */
export const VaultBindingsQuery = listQuery({
  sort: sortable(['handle', 'updated_at', 'created_at']).default('handle'),
  filters: { group_id: z.string().min(1).max(128).optional(), q: QueryText.optional() },
});
/** `GET /vault/bindings` query. */
export type VaultBindingsQuery = z.infer<typeof VaultBindingsQuery>;

/** `GET /vault/bindings` body. */
export const VaultBindingsPage = page(VaultBinding);
/** `GET /vault/bindings` body. */
export type VaultBindingsPage = z.infer<typeof VaultBindingsPage>;

/**
 * `PUT /vault/bindings/{handle}` body. All fields optional on update; `item_name` is required on
 * create (enforced by the service, which knows whether the handle exists). `If-Match` carries the
 * expected `version` on update.
 */
export const PutVaultBindingRequest = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  item_name: z.string().trim().min(1).max(200).optional(),
  item_id: z.string().max(128).optional(),
  group_id: z.string().max(128).nullable().optional(),
  allowed_origins: z.array(z.string().min(1).max(512)).max(100).optional(),
  authorized_principals: z.array(z.string().min(1).max(128)).max(100).optional(),
  authorized_session_slugs: z.array(z.string().min(1).max(64)).max(100).optional(),
  allow_all_sessions: z.boolean().optional(),
  redact_username: z.boolean().optional(),
  require_no_evaluate: z.boolean().optional(),
  dashboard_confirm: z.boolean().optional(),
});
/** `PUT /vault/bindings/{handle}` body. */
export type PutVaultBindingRequest = z.infer<typeof PutVaultBindingRequest>;

/** `PUT /vault/bindings/{handle}` 200 body. */
export const PutVaultBindingResponse = z.object({ ok: z.literal(true), binding: VaultBinding });
/** `PUT /vault/bindings/{handle}` 200 body. */
export type PutVaultBindingResponse = z.infer<typeof PutVaultBindingResponse>;

/** `DELETE /vault/bindings/{handle}` 200 body. */
export const DeleteVaultBindingResponse = z.object({ ok: z.literal(true), removed: z.boolean() });
/** `DELETE /vault/bindings/{handle}` 200 body. */
export type DeleteVaultBindingResponse = z.infer<typeof DeleteVaultBindingResponse>;

/** `POST /vault/bindings/resolve` body — server-side origin tester. */
export const ResolveBindingsRequest = z.strictObject({
  url: z.url(),
  session_slug: z.string().min(1).max(64).optional(),
  principal: z.string().min(1).max(128).optional(),
});
/** `POST /vault/bindings/resolve` body. */
export type ResolveBindingsRequest = z.infer<typeof ResolveBindingsRequest>;

/** `POST /vault/bindings/resolve` 200 body. */
export const ResolveBindingsResponse = z.object({
  would_fill: z.array(VaultHandle),
  blocked: z.array(z.object({ handle: VaultHandle, reason: z.string() })),
});
/** `POST /vault/bindings/resolve` 200 body. */
export type ResolveBindingsResponse = z.infer<typeof ResolveBindingsResponse>;

/** Outcome of one vault access (`vault_access.result`). */
export const VaultAccessResult = z.enum([
  'success',
  'origin_mismatch',
  'auth_failed',
  'blocked',
  'denied',
]);
/** Outcome of one vault access. */
export type VaultAccessResult = z.infer<typeof VaultAccessResult>;

/** Origin check outcome of one vault access. */
export const OriginCheck = z.enum(['pass', 'fail', 'skipped']);
/** Origin check outcome. */
export type OriginCheck = z.infer<typeof OriginCheck>;

/** One vault access audit row (`vault_access`); secrets never appear here. */
export const VaultAccessRow = z.object({
  event_id: EventId,
  session_id: SessionId,
  session_slug: z.string().nullable(),
  tool_event_id: EventId.nullable(),
  entry_name: z.string(),
  handle: VaultHandle.nullable(),
  result: VaultAccessResult,
  reason: z.string().nullable(),
  evaluate_enabled: z.boolean(),
  page_url: z.string(),
  origin_check: OriginCheck,
  principal_id: z.string().nullable(),
  details: z.unknown().nullable(),
  ts: EpochMs,
});
/** One vault access audit row. */
export type VaultAccessRow = z.infer<typeof VaultAccessRow>;

/** Sort keys accepted by `GET /vault/log`. */
export const VaultLogSortKey = sortable(['ts', 'entry_name', 'result', 'session']);
/** Sort keys accepted by `GET /vault/log`. */
export type VaultLogSortKey = z.infer<typeof VaultLogSortKey>;

/** `GET /vault/log` and `GET /sessions/{session_id}/vault-access` query. */
export const VaultLogQuery = listQuery({
  sort: VaultLogSortKey.default('ts'),
  filters: {
    result: csv(VaultAccessResult),
    origin_check: csv(OriginCheck),
    evaluate: z.enum(['on', 'off']).optional(),
    session_id: SessionId.optional(),
    entry_name: z.string().min(1).max(200).optional(),
    q: QueryText.optional(),
    ...windowQuery,
  },
});
/** `GET /vault/log` query. */
export type VaultLogQuery = z.infer<typeof VaultLogQuery>;

/** `GET /vault/log` body. */
export const VaultLogPage = page(VaultAccessRow);
/** `GET /vault/log` body. */
export type VaultLogPage = z.infer<typeof VaultLogPage>;

/** Binding as exported (no timestamps/version — hand-editable). */
export const VaultBindingExport = VaultBinding.omit({
  created_at: true,
  updated_at: true,
  version: true,
});
/** Binding as exported. */
export type VaultBindingExport = z.infer<typeof VaultBindingExport>;

/** Group policy as exported. */
export const VaultGroupPolicyExport = VaultGroupPolicy.omit({
  created_at: true,
  updated_at: true,
  version: true,
}).extend({ access_mode: VaultAccessMode });
/** Group policy as exported. */
export type VaultGroupPolicyExport = z.infer<typeof VaultGroupPolicyExport>;

/** `GET /vault/export` body and `POST /vault/import` body (version 3 document). */
export const VaultExportDocument = z.strictObject({
  version: z.literal(VAULT_EXPORT_VERSION),
  bindings: z.array(VaultBindingExport),
  policies: z.array(VaultGroupPolicyExport),
});
/** Vault export document. */
export type VaultExportDocument = z.infer<typeof VaultExportDocument>;

/** `POST /vault/import` query. */
export const ImportVaultQuery = z.strictObject({
  mode: z.enum(['merge', 'replace']).default('merge'),
});
/** `POST /vault/import` query. */
export type ImportVaultQuery = z.infer<typeof ImportVaultQuery>;

/** `POST /vault/import` 200 body. */
export const ImportVaultResponse = z.object({
  ok: z.literal(true),
  imported: z.object({ bindings: Count, policies: Count }),
});
/** `POST /vault/import` 200 body. */
export type ImportVaultResponse = z.infer<typeof ImportVaultResponse>;
