/** @module interface/http/routes/attention — operator requests: attention queue and vault confirm (spec 03 §4.4, D-15). */

import { ERROR_REGISTRY } from '@browserhive/contracts/errors';
import {
  AttentionPage,
  AttentionQuery,
  BulkAttentionRequest,
  BulkRequestsResponse,
  BulkVaultConfirmRequest,
  IdempotencyKey,
  RequestIdParams,
  ResolveAttentionRequest,
  ResolveRequestResponse,
  ResolveVaultConfirmRequest,
  VaultConfirmPage,
  VaultConfirmQuery,
} from '@browserhive/contracts/http';
import { z } from 'zod';
import { isAppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, reply } from '../define-route.ts';
import {
  operatorRequestQueryToRepo,
  operatorRequestToWire,
} from '../serializers/operator-requests.ts';
import { envelope } from '../serializers/page.ts';
import { requirePrincipal, requireVault } from './common.ts';

const IdempotencyHeaders = z.object({ 'idempotency-key': IdempotencyKey });

async function bulk(
  ids: readonly string[],
  run: (id: string) => Promise<unknown>,
): Promise<{
  results: { request_id: string; ok: boolean; error?: { code: string; title: string } }[];
  ok_count: number;
  error_count: number;
}> {
  const results = [];
  for (const id of ids) {
    try {
      await run(id);
      results.push({ request_id: id, ok: true });
    } catch (error) {
      if (!isAppError(error)) throw error;
      results.push({
        request_id: id,
        ok: false,
        error: { code: error.code, title: ERROR_REGISTRY[error.code].title },
      });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { results, ok_count: okCount, error_count: results.length - okCount };
}

/** Operator request routes. */
export const ATTENTION_ROUTES = [
  defineRoute({
    operationId: 'listAttention',
    tags: ['attention'],
    summary:
      'Attention requests (open and history) with the live open count and status/mode facets.',
    request: { query: AttentionQuery },
    responses: { 200: AttentionPage },
    async handler({ input, services, ctx }) {
      const query = operatorRequestQueryToRepo(input.query);
      const [page, facets] = await Promise.all([
        services.attention.history(query),
        services.attention.facets(query),
      ]);
      const body = envelope(page, operatorRequestToWire, input.query, ctx.now, 'created_at');
      return reply(200, {
        ...body,
        open_count: services.attention.openCount(),
        facets: { status: [...facets.statuses], mode: [...facets.modes] },
      });
    },
  }),
  defineRoute({
    operationId: 'resolveAttention',
    tags: ['attention'],
    summary: 'Resolve or reject an open attention request.',
    request: { params: RequestIdParams, body: ResolveAttentionRequest },
    responses: { 200: ResolveRequestResponse },
    errors: ['NOT_FOUND', 'ATTENTION_NOT_OPEN'],
    async handler({ input, principal, services }) {
      const by = requirePrincipal(principal).subject;
      const { decision, message } = input.body;
      const id = input.params.request_id;
      const status =
        decision === 'resolve'
          ? await services.attention.resolve(id, by, message)
          : await services.attention.reject(id, by, message);
      return reply(200, { ok: true, status });
    },
  }),
  defineRoute({
    operationId: 'bulkAttention',
    tags: ['attention'],
    summary: 'Resolve or reject several attention requests (per-item results).',
    request: { body: BulkAttentionRequest, headers: IdempotencyHeaders },
    responses: { 200: BulkRequestsResponse },
    idempotent: true,
    async handler({ input, principal, services }) {
      const by = requirePrincipal(principal).subject;
      const { action, message } = input.body;
      const body = await bulk(input.body.request_ids, (id) =>
        action === 'resolve'
          ? services.attention.resolve(id, by, message)
          : services.attention.reject(id, by, message),
      );
      return reply(200, body);
    },
  }),
  defineRoute({
    operationId: 'listVaultConfirm',
    tags: ['vault'],
    summary: 'Vault fill confirmations (open and history).',
    request: { query: VaultConfirmQuery },
    responses: { 200: VaultConfirmPage },
    errors: ['VAULT_NOT_CONFIGURED'],
    async handler({ input, services, ctx }) {
      requireVault(services);
      const result = await services.vault.confirms(operatorRequestQueryToRepo(input.query));
      const body = envelope(result.page, operatorRequestToWire, input.query, ctx.now, 'created_at');
      return reply(200, { ...body, open_count: result.openCount });
    },
  }),
  defineRoute({
    operationId: 'resolveVaultConfirm',
    tags: ['vault'],
    summary: 'Approve or deny a pending vault fill (`reason` is audit-only).',
    request: { params: RequestIdParams, body: ResolveVaultConfirmRequest },
    responses: { 200: ResolveRequestResponse },
    errors: ['VAULT_NOT_CONFIGURED', 'NOT_FOUND', 'CONFIRM_NOT_OPEN'],
    async handler({ input, principal, services }) {
      requireVault(services);
      const status = await services.vault.resolveConfirm(
        input.params.request_id,
        input.body.decision,
        requirePrincipal(principal).subject,
        input.body.reason,
      );
      return reply(200, { ok: true, status });
    },
  }),
  defineRoute({
    operationId: 'bulkVaultConfirm',
    tags: ['vault'],
    summary: 'Approve or deny several vault confirmations (per-item results).',
    request: { body: BulkVaultConfirmRequest, headers: IdempotencyHeaders },
    responses: { 200: BulkRequestsResponse },
    errors: ['VAULT_NOT_CONFIGURED'],
    idempotent: true,
    async handler({ input, principal, services }) {
      requireVault(services);
      const by = requirePrincipal(principal).subject;
      const { action, reason } = input.body;
      return reply(
        200,
        await bulk(input.body.request_ids, (id) =>
          services.vault.resolveConfirm(id, action, by, reason),
        ),
      );
    },
  }),
];
