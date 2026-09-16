/** @module interface/http/routes/vault — vault overview, status, unlock/lock/sync, groups, policies and items (spec 03 §4.5, D-14). */

import {
  GroupIdParams,
  IfMatchVersion,
  LockVaultResponse,
  PutGroupPolicyRequest,
  PutGroupPolicyResponse,
  SyncVaultResponse,
  UnlockVaultRequest,
  UnlockVaultResponse,
  VaultGroupsResponse,
  VaultItemsPage,
  VaultItemsQuery,
  VaultOverview,
  VaultStatus,
} from '@browserhive/contracts/http';
import { z } from 'zod';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, reply } from '../define-route.ts';
import { validationFailed } from '../problem.ts';
import { envelope } from '../serializers/page.ts';
import {
  groupToWire,
  itemToWire,
  overviewToWire,
  policyInputFromWire,
  policyToWire,
} from '../serializers/vault.ts';
import { requireVault } from './common.ts';

const tags = ['vault'];
/** `If-Match: <version>` (optional on create). */
export const IfMatchHeaders = z.object({ 'if-match': IfMatchVersion.optional() });

/** Opaque offset cursor for in-memory pages (backend item lists). */
export function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ r: 'vault_items', o: offset })).toString('base64url');
}

/** Decodes {@link encodeOffset}; a foreign cursor → 400 `VALIDATION_FAILED`. */
export function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = z
    .object({ r: z.literal('vault_items'), o: z.number().int().nonnegative() })
    .safeParse(safeJson(Buffer.from(cursor, 'base64url').toString('utf8')));
  if (!parsed.success) {
    throw validationFailed([{ path: 'query.cursor', message: 'invalid cursor', code: 'custom' }]);
  }
  return parsed.data.o;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Vault backend routes. */
export const VAULT_ROUTES = [
  defineRoute({
    operationId: 'getVault',
    tags,
    summary: 'Backend capabilities, unlock descriptor and counts (never shells out).',
    request: {},
    responses: { 200: VaultOverview },
    errors: ['VAULT_NOT_CONFIGURED'],
    async handler({ services }) {
      requireVault(services);
      return reply(200, overviewToWire(await services.vault.overview()));
    },
  }),
  defineRoute({
    operationId: 'getVaultStatus',
    tags,
    summary: 'Lock state (may call the backend).',
    request: {},
    responses: { 200: VaultStatus },
    errors: ['VAULT_NOT_CONFIGURED', 'VAULT_BACKEND_ERROR'],
    async handler({ services }) {
      requireVault(services);
      const status = await services.vault.status();
      return reply(200, { unlocked: status.unlocked, checked_at: status.checkedAt });
    },
  }),
  defineRoute({
    operationId: 'unlockVault',
    tags,
    summary:
      'Unlock with the secret `unlock.mode` names (Bitwarden: a session token, never the master password).',
    request: { body: UnlockVaultRequest },
    responses: { 200: UnlockVaultResponse },
    errors: ['VAULT_NOT_CONFIGURED', 'VAULT_UNLOCK_FAILED'],
    rateLimit: { limit: 5, windowMs: 60_000, key: 'principal' },
    async handler({ input, services }) {
      requireVault(services);
      await services.vault.unlock({
        ...(input.body.passphrase !== undefined && { passphrase: input.body.passphrase }),
        ...(input.body.token !== undefined && { token: input.body.token }),
      });
      return reply(200, { ok: true, unlocked: true });
    },
  }),
  defineRoute({
    operationId: 'lockVault',
    tags,
    summary: 'Forget the backend session.',
    request: {},
    responses: { 200: LockVaultResponse },
    errors: ['VAULT_NOT_CONFIGURED'],
    async handler({ services }) {
      requireVault(services);
      services.vault.lock();
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'syncVault',
    tags,
    summary: "Refresh the backend's local cache.",
    request: {},
    responses: { 200: SyncVaultResponse },
    errors: ['VAULT_NOT_CONFIGURED', 'VAULT_SYNC_UNSUPPORTED', 'VAULT_LOCKED'],
    async handler({ services }) {
      requireVault(services);
      const overview = await services.vault.overview();
      if (!overview.capabilities.sync) {
        throw new AppError('VAULT_SYNC_UNSUPPORTED', { backend: overview.backend });
      }
      const result = await services.vault.sync();
      return reply(200, {
        ok: true,
        items: result.items,
        groups: result.groups,
        synced_at: result.syncedAt,
      });
    },
  }),
  defineRoute({
    operationId: 'listVaultGroups',
    tags,
    summary: 'Backend groups with item/binding coverage, policies and same-name duplicates.',
    request: {},
    responses: { 200: VaultGroupsResponse },
    errors: ['VAULT_NOT_CONFIGURED', 'VAULT_LOCKED'],
    async handler({ services }) {
      requireVault(services);
      const view = await services.vault.groups();
      return reply(200, {
        data: view.groups.map(groupToWire),
        duplicates: view.duplicates.map((d) => ({
          group_id: d.groupId,
          name: d.name,
          ids: [...d.ids],
        })),
      });
    },
  }),
  defineRoute({
    operationId: 'putVaultGroupPolicy',
    tags,
    summary: 'Create or update a group policy (`If-Match: <version>` on update).',
    request: { params: GroupIdParams, body: PutGroupPolicyRequest, headers: IfMatchHeaders },
    responses: { 200: PutGroupPolicyResponse },
    errors: ['VAULT_NOT_CONFIGURED', 'CONFLICT'],
    async handler({ input, services }) {
      requireVault(services);
      const policy = await services.vault.admin.putPolicy(
        input.params.group_id,
        policyInputFromWire(input.body),
        input.headers['if-match'],
      );
      return reply(200, { ok: true, policy: policyToWire(policy) });
    },
  }),
  defineRoute({
    operationId: 'listVaultItems',
    tags,
    summary: 'Backend items with derived handles and binding coverage.',
    request: { query: VaultItemsQuery },
    responses: { 200: VaultItemsPage },
    errors: ['VAULT_NOT_CONFIGURED', 'VAULT_LOCKED'],
    async handler({ input, services, ctx }) {
      requireVault(services);
      const q = input.query;
      const offset = decodeOffset(q.cursor);
      const all = await services.vault.items({
        ...(q.group_id !== undefined && { groupId: q.group_id }),
        ...(q.q !== undefined && { q: q.q }),
      });
      const sorted =
        q.sort === 'name' ? [...all].sort((a, b) => a.name.localeCompare(b.name)) : all;
      const ordered = q.dir === 'desc' ? [...sorted].reverse() : sorted;
      const slice = ordered.slice(offset, offset + q.limit);
      const next =
        offset + slice.length < ordered.length ? encodeOffset(offset + slice.length) : null;
      const page = { items: slice, nextCursor: next, ...(q.total && { total: ordered.length }) };
      return reply(200, envelope(page, itemToWire, q, ctx.now, 'handle'));
    },
  }),
];
