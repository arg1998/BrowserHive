/** @module interface/http/serializers/vault — vault overview, groups, items, bindings and policies ↔ wire (spec 03 §4.5, D-14). */

import type {
  PutGroupPolicyRequest,
  PutVaultBindingRequest,
  VaultBinding,
  VaultGroup,
  VaultGroupPolicy,
  VaultItem,
  VaultOverview,
} from '@browserhive/contracts/http';
import type { z } from 'zod';
import type {
  VaultOverview as OverviewView,
  VaultGroupView,
  VaultItemView,
} from '../../../app/vault/vault-service.ts';
import type { VaultBindingInput } from '../../../domain/vault/bindings.ts';
import type { VaultGroupPolicyInput } from '../../../domain/vault/policies.ts';
import type {
  VaultBindingRecord,
  VaultGroupPolicyRecord,
} from '../../../ports/persistence/records.ts';

/** `GET /vault` body; the port's boolean `grouping` becomes `flat`/`none` on the wire. */
export function overviewToWire(view: OverviewView): z.input<typeof VaultOverview> {
  return {
    backend: {
      id: view.backend,
      capabilities: {
        unlock: view.capabilities.unlock,
        grouping: view.capabilities.grouping ? 'flat' : 'none',
        writable: view.capabilities.writable,
        totp: view.capabilities.totp,
        sync: view.capabilities.sync,
      },
    },
    unlock: { required: view.unlock.required, mode: view.unlock.mode, hint: view.unlock.hint },
    unlocked: view.unlocked,
    bindings_count: view.bindingsCount,
    policies_count: view.policiesCount,
    now: view.now,
  };
}

/** One group policy. */
export function policyToWire(record: VaultGroupPolicyRecord): z.input<typeof VaultGroupPolicy> {
  return {
    group_id: record.groupId,
    access_mode: record.accessMode,
    allow_all_sessions: record.allowAllSessions,
    session_slug_globs: [...record.sessionSlugGlobs],
    authorized_principals: [...record.authorizedPrincipals],
    dashboard_confirm: record.dashboardConfirm,
    require_no_evaluate: record.requireNoEvaluate,
    redact_username: record.redactUsername,
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

/** One backend group with coverage. */
export function groupToWire(view: VaultGroupView): z.input<typeof VaultGroup> {
  return {
    group_id: view.groupId,
    name: view.name,
    ...(view.path !== undefined && { path: view.path }),
    item_count: view.itemCount,
    bound_count: view.boundCount,
    policy: view.policy === null ? null : policyToWire(view.policy),
  };
}

/** One backend item. */
export function itemToWire(view: VaultItemView): z.input<typeof VaultItem> {
  return {
    item_id: view.itemId,
    name: view.name,
    group_id: view.groupId,
    login_uris: [...view.loginUris],
    handle: view.handle,
    bound: view.bound,
  };
}

/** One binding. */
export function bindingToWire(record: VaultBindingRecord): z.input<typeof VaultBinding> {
  return {
    handle: record.handle,
    title: record.title,
    item_name: record.itemName,
    item_id: record.itemId,
    group_id: record.groupId,
    allowed_origins: [...record.allowedOrigins],
    authorized_principals: [...record.authorizedPrincipals],
    authorized_session_slugs: [...record.authorizedSessionSlugs],
    allow_all_sessions: record.allowAllSessions,
    redact_username: record.redactUsername,
    require_no_evaluate: record.requireNoEvaluate,
    dashboard_confirm: record.dashboardConfirm,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    version: record.version,
  };
}

/** `PUT /vault/bindings/{handle}` body → domain input. */
export function bindingInputFromWire(
  body: z.output<typeof PutVaultBindingRequest>,
): VaultBindingInput {
  return {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.item_name !== undefined && { itemName: body.item_name }),
    ...(body.item_id !== undefined && { itemId: body.item_id }),
    ...(body.group_id !== undefined && { groupId: body.group_id }),
    ...(body.allowed_origins !== undefined && { allowedOrigins: body.allowed_origins }),
    ...(body.authorized_principals !== undefined && {
      authorizedPrincipals: body.authorized_principals,
    }),
    ...(body.authorized_session_slugs !== undefined && {
      authorizedSessionSlugs: body.authorized_session_slugs,
    }),
    ...(body.allow_all_sessions !== undefined && { allowAllSessions: body.allow_all_sessions }),
    ...(body.redact_username !== undefined && { redactUsername: body.redact_username }),
    ...(body.require_no_evaluate !== undefined && { requireNoEvaluate: body.require_no_evaluate }),
    ...(body.dashboard_confirm !== undefined && { dashboardConfirm: body.dashboard_confirm }),
  };
}

/** `PUT /vault/groups/{group_id}/policy` body → domain input. */
export function policyInputFromWire(
  body: z.output<typeof PutGroupPolicyRequest>,
): VaultGroupPolicyInput {
  return {
    accessMode: body.access_mode,
    ...(body.allow_all_sessions !== undefined && { allowAllSessions: body.allow_all_sessions }),
    ...(body.session_slug_globs !== undefined && { sessionSlugGlobs: body.session_slug_globs }),
    ...(body.authorized_principals !== undefined && {
      authorizedPrincipals: body.authorized_principals,
    }),
    ...(body.dashboard_confirm !== undefined && { dashboardConfirm: body.dashboard_confirm }),
    ...(body.require_no_evaluate !== undefined && { requireNoEvaluate: body.require_no_evaluate }),
    ...(body.redact_username !== undefined && { redactUsername: body.redact_username }),
  };
}
