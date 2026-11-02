/** @module interface/http/routes/vault-bindings — bindings CRUD, origin tester, access log, export/import (spec 03 §4.5). */

import { harnessLabel } from '@browserhive/contracts/harness';
import {
  DeleteVaultBindingResponse,
  HandleParams,
  ImportVaultQuery,
  ImportVaultResponse,
  PutVaultBindingRequest,
  PutVaultBindingResponse,
  ResolveBindingsRequest,
  ResolveBindingsResponse,
  VAULT_HARNESSES_WINDOW_DAYS,
  VaultBindingsPage,
  VaultBindingsQuery,
  VaultExportDocument,
  VaultHarnessesResponse,
  VaultLogPage,
  VaultLogQuery,
} from '@browserhive/contracts/http';
import { defineRoute, reply } from '../define-route.ts';
import { IMPORT_BODY_LIMIT_BYTES } from '../middleware/body-limit.ts';
import { vaultAccessToWire, vaultLogQueryToRepo } from '../serializers/facts.ts';
import { envelope, pagingOf } from '../serializers/page.ts';
import { bindingInputFromWire, bindingToWire } from '../serializers/vault.ts';
import { requireVault } from './common.ts';
import { IfMatchHeaders } from './vault.ts';

const tags = ['vault'];
const errors = ['VAULT_NOT_CONFIGURED'] as const;

/** Binding and audit routes. */
export const VAULT_BINDING_ROUTES = [
  defineRoute({
    operationId: 'listVaultBindings',
    tags,
    summary: 'Stored bindings, ordered by handle.',
    request: { query: VaultBindingsQuery },
    responses: { 200: VaultBindingsPage },
    errors,
    async handler({ input, services, ctx }) {
      requireVault(services);
      const q = input.query;
      const page = await services.vault.admin.listBindings({
        ...pagingOf(q),
        ...(q.group_id !== undefined && { groupId: q.group_id }),
        ...(q.q !== undefined && { q: q.q }),
      });
      return reply(200, envelope(page, bindingToWire, q, ctx.now, 'handle'));
    },
  }),
  defineRoute({
    operationId: 'putVaultBinding',
    tags,
    summary: 'Create (item_name required) or update a binding (`If-Match: <version>`).',
    request: { params: HandleParams, body: PutVaultBindingRequest, headers: IfMatchHeaders },
    responses: { 200: PutVaultBindingResponse },
    errors: ['VAULT_NOT_CONFIGURED', 'CONFLICT'],
    async handler({ input, services }) {
      requireVault(services);
      const binding = await services.vault.admin.putBinding(
        input.params.handle,
        bindingInputFromWire(input.body),
        input.headers['if-match'],
      );
      return reply(200, { ok: true, binding: bindingToWire(binding) });
    },
  }),
  defineRoute({
    operationId: 'deleteVaultBinding',
    tags,
    summary: 'Remove a binding.',
    request: { params: HandleParams },
    responses: { 200: DeleteVaultBindingResponse },
    errors,
    async handler({ input, services }) {
      requireVault(services);
      const removed = await services.vault.admin.deleteBinding(input.params.handle);
      return reply(200, { ok: true, removed });
    },
  }),
  defineRoute({
    operationId: 'resolveVaultBindings',
    tags,
    summary:
      'Dry-run the fill gates of every binding against a URL, optionally as a given principal, slug and harness (D-48).',
    request: { body: ResolveBindingsRequest },
    responses: { 200: ResolveBindingsResponse },
    errors,
    async handler({ input, services }) {
      requireVault(services);
      const result = await services.vault.admin.tester({
        url: input.body.url,
        ...(input.body.session_slug !== undefined && { sessionSlug: input.body.session_slug }),
        ...(input.body.principal !== undefined && { principal: input.body.principal }),
        ...(input.body.harness !== undefined && { harness: input.body.harness }),
        ...(input.body.harness_declared !== undefined && {
          harnessDeclared: input.body.harness_declared,
        }),
      });
      return reply(200, {
        would_fill: [...result.wouldFill],
        blocked: result.blocked.map((b) => ({
          handle: b.handle,
          reason: b.reason,
          ...(b.rule !== undefined && { rule: b.rule }),
        })),
        harness_lists_unchecked: [...result.harnessListsUnchecked],
      });
    },
  }),
  defineRoute({
    operationId: 'listVaultHarnesses',
    tags,
    summary:
      'Harnesses and declared names seen on this daemon in the last 30 days, for the harness lists of bindings and group policies (D-48).',
    request: {},
    responses: { 200: VaultHarnessesResponse },
    errors,
    async handler({ services, ctx }) {
      requireVault(services);
      const until = ctx.now;
      const since = until - VAULT_HARNESSES_WINDOW_DAYS * 86_400_000;
      const seen = await services.analytics.harnessesSeen({ since, until });
      return reply(200, {
        data: seen.rows.map((r) => ({
          harness: r.harness,
          label: harnessLabel(r.harness),
          declared: r.declared,
          sessions: r.sessions,
          last_seen_at: r.lastSeenAt,
        })),
        principals: seen.principals,
        window: { since, until },
        now: ctx.now,
      });
    },
  }),
  defineRoute({
    operationId: 'listVaultLog',
    tags,
    summary: 'Vault access audit log.',
    request: { query: VaultLogQuery },
    responses: { 200: VaultLogPage },
    errors,
    async handler({ input, services, ctx }) {
      requireVault(services);
      const page = await services.vault.accessLog(vaultLogQueryToRepo(input.query));
      return reply(200, envelope(page, vaultAccessToWire, input.query, ctx.now, 'ts'));
    },
  }),
  defineRoute({
    operationId: 'exportVault',
    tags,
    summary: 'Export bindings and policies as the v3 document.',
    request: {},
    responses: { 200: VaultExportDocument },
    errors,
    async handler({ services }) {
      requireVault(services);
      return reply(200, await services.vault.admin.exportDocument());
    },
  }),
  defineRoute({
    operationId: 'importVault',
    tags,
    summary: 'Import a v3 document (`?mode=merge|replace`).',
    request: { query: ImportVaultQuery, body: VaultExportDocument },
    responses: { 200: ImportVaultResponse },
    errors,
    bodyLimitBytes: IMPORT_BODY_LIMIT_BYTES,
    async handler({ input, services }) {
      requireVault(services);
      const imported = await services.vault.admin.importDocument(input.body, input.query.mode);
      return reply(200, {
        ok: true,
        imported: { bindings: imported.bindings, policies: imported.policies },
      });
    },
  }),
];
