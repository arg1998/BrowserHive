/** @module contracts/http/vault — vault overview, unlock, sync, groups, policies and items (spec 03 §4.5, D-14) */
import { z } from 'zod';
import { VaultBackendKind } from '../enums/index.ts';
import { Count, EpochMs, listQuery, OkResponse, page, QueryText, sortable } from './common.ts';

/** Policy key of the ungrouped bucket (`vault_group_policies.group_key`). */
export const UNGROUPED_GROUP_KEY = '__ungrouped__';

/** How the backend is unlocked. */
export const VaultUnlockMode = z.enum(['none', 'passphrase', 'token']);
/** How the backend is unlocked. */
export type VaultUnlockMode = z.infer<typeof VaultUnlockMode>;

/** How the backend organises items. */
export const VaultGrouping = z.enum(['none', 'flat', 'tree']);
/** How the backend organises items. */
export type VaultGrouping = z.infer<typeof VaultGrouping>;

/** Group policy access modes. */
export const VaultAccessMode = z.enum(['manual', 'allow_all', 'reject_all']);
/** Group policy access modes. */
export type VaultAccessMode = z.infer<typeof VaultAccessMode>;

/** Capabilities declared by the `VaultBackend` port. */
export const VaultCapabilities = z.object({
  unlock: VaultUnlockMode,
  grouping: VaultGrouping,
  writable: z.boolean(),
  totp: z.boolean(),
  sync: z.boolean(),
});
/** Capabilities declared by the `VaultBackend` port. */
export type VaultCapabilities = z.infer<typeof VaultCapabilities>;

/** Backend-neutral unlock descriptor (no backend-specific session variable names). */
export const VaultUnlockDescriptor = z.object({
  required: z.boolean(),
  mode: VaultUnlockMode,
  hint: z.string().nullable(),
});
/** Generic unlock descriptor. */
export type VaultUnlockDescriptor = z.infer<typeof VaultUnlockDescriptor>;

/** `GET /vault` body — never shells out to the backend. */
export const VaultOverview = z.object({
  backend: z.object({ id: VaultBackendKind, capabilities: VaultCapabilities }),
  unlock: VaultUnlockDescriptor,
  unlocked: z.boolean(),
  bindings_count: Count,
  policies_count: Count,
  now: EpochMs,
});
/** `GET /vault` body. */
export type VaultOverview = z.infer<typeof VaultOverview>;

/** `GET /vault/status` body (may call the backend). */
export const VaultStatus = z.object({ unlocked: z.boolean(), checked_at: EpochMs });
/** `GET /vault/status` body. */
export type VaultStatus = z.infer<typeof VaultStatus>;

/** `POST /vault/unlock` body: exactly one of `passphrase`/`token` per `unlock.mode`. */
export const UnlockVaultRequest = z
  .strictObject({
    passphrase: z.string().min(1).max(1024).optional(),
    token: z.string().min(1).max(4096).optional(),
  })
  .refine((v) => (v.passphrase === undefined) !== (v.token === undefined), {
    message: 'exactly one of passphrase or token is required',
  });
/** `POST /vault/unlock` body. */
export type UnlockVaultRequest = z.infer<typeof UnlockVaultRequest>;

/** `POST /vault/unlock` 200 body. */
export const UnlockVaultResponse = z.object({ ok: z.literal(true), unlocked: z.literal(true) });
/** `POST /vault/unlock` 200 body. */
export type UnlockVaultResponse = z.infer<typeof UnlockVaultResponse>;

/** `POST /vault/lock` body. */
export const LockVaultResponse = OkResponse;

/** `POST /vault/sync` 200 body. */
export const SyncVaultResponse = z.object({
  ok: z.literal(true),
  items: Count,
  groups: Count,
  synced_at: EpochMs,
});
/** `POST /vault/sync` 200 body. */
export type SyncVaultResponse = z.infer<typeof SyncVaultResponse>;

/** One group policy (`vault_group_policies` row); `group_id: null` = ungrouped. */
export const VaultGroupPolicy = z.object({
  group_id: z.string().nullable(),
  access_mode: VaultAccessMode,
  allow_all_sessions: z.boolean(),
  session_slug_globs: z.array(z.string()),
  authorized_principals: z.array(z.string()),
  dashboard_confirm: z.boolean(),
  require_no_evaluate: z.boolean(),
  redact_username: z.boolean(),
  version: z.number().int().positive(),
  created_at: EpochMs,
  updated_at: EpochMs,
});
/** One group policy. */
export type VaultGroupPolicy = z.infer<typeof VaultGroupPolicy>;

/** One backend group with its binding coverage and policy. */
export const VaultGroup = z.object({
  group_id: z.string().nullable(),
  name: z.string(),
  path: z.string().optional(),
  item_count: Count,
  bound_count: Count,
  policy: VaultGroupPolicy.nullable(),
});
/** One backend group. */
export type VaultGroup = z.infer<typeof VaultGroup>;

/** `GET /vault/groups` body; `duplicates` lists same-named groups the operator must disambiguate. */
export const VaultGroupsResponse = z.object({
  data: z.array(VaultGroup),
  duplicates: z.array(
    z.object({ group_id: z.string().nullable(), name: z.string(), ids: z.array(z.string()) }),
  ),
});
/** `GET /vault/groups` body. */
export type VaultGroupsResponse = z.infer<typeof VaultGroupsResponse>;

/** Path params for `/vault/groups/{group_id}/policy`; `__ungrouped__` addresses the ungrouped bucket. */
export const GroupIdParams = z.strictObject({ group_id: z.string().min(1).max(128) });
/** Path params for `/vault/groups/{group_id}/policy`. */
export type GroupIdParams = z.infer<typeof GroupIdParams>;

/** `PUT /vault/groups/{group_id}/policy` body (requires `If-Match: <version>` on update). */
export const PutGroupPolicyRequest = z.strictObject({
  access_mode: VaultAccessMode,
  allow_all_sessions: z.boolean().optional(),
  session_slug_globs: z.array(z.string().min(1).max(64)).max(100).optional(),
  authorized_principals: z.array(z.string().min(1).max(128)).max(100).optional(),
  dashboard_confirm: z.boolean().optional(),
  require_no_evaluate: z.boolean().optional(),
  redact_username: z.boolean().optional(),
});
/** `PUT /vault/groups/{group_id}/policy` body. */
export type PutGroupPolicyRequest = z.infer<typeof PutGroupPolicyRequest>;

/** `PUT /vault/groups/{group_id}/policy` 200 body. */
export const PutGroupPolicyResponse = z.object({ ok: z.literal(true), policy: VaultGroupPolicy });
/** `PUT /vault/groups/{group_id}/policy` 200 body. */
export type PutGroupPolicyResponse = z.infer<typeof PutGroupPolicyResponse>;

/** One backend item as listed for binding */
export const VaultItem = z.object({
  item_id: z.string(),
  name: z.string(),
  group_id: z.string().nullable(),
  login_uris: z.array(z.string()),
  handle: z.string(),
  bound: z.boolean(),
});
/** One backend item. */
export type VaultItem = z.infer<typeof VaultItem>;

/** `GET /vault/items` query. */
export const VaultItemsQuery = listQuery({
  sort: sortable(['handle', 'name']).default('handle'),
  filters: { group_id: z.string().min(1).max(128).optional(), q: QueryText.optional() },
});
/** `GET /vault/items` query. */
export type VaultItemsQuery = z.infer<typeof VaultItemsQuery>;

/** `GET /vault/items` body. */
export const VaultItemsPage = page(VaultItem);
/** `GET /vault/items` body. */
export type VaultItemsPage = z.infer<typeof VaultItemsPage>;
