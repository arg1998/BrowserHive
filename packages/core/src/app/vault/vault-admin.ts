/** @module app/vault/vault-admin — operator-side policy administration: bindings and group policies CRUD (optimistic version), tester, export/import. */

import {
  isPrincipalAuthorized,
  isSlugAuthorized,
  isValidHandle,
  mergeBinding,
  type VaultBindingInput,
} from '../../domain/vault/bindings.ts';
import { decideFill } from '../../domain/vault/decide-fill.ts';
import {
  groupIdOf,
  mergePolicy,
  PolicySet,
  type VaultGroupPolicyInput,
} from '../../domain/vault/policies.ts';
import type { ResolvedEntry } from '../../domain/vault/types.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Page, VaultBindingListQuery } from '../../ports/persistence/queries.ts';
import type {
  VaultBindingRecord,
  VaultGroupPolicyRecord,
} from '../../ports/persistence/records.ts';
import type {
  VaultBindingRepository,
  VaultGroupPolicyRepository,
  VaultImportMode,
  VaultImportResult,
} from '../../ports/persistence/vault-policy.ts';
import { fromWireExport, toWireExport, type VaultExportWire } from './export.ts';

/** Constructor dependencies of {@link VaultAdmin}. */
export interface VaultAdminDeps {
  readonly bindings: VaultBindingRepository;
  readonly policies: VaultGroupPolicyRepository;
  readonly clock: Clock;
}

/** `POST /vault/bindings/resolve` body (camelCase). */
export interface TesterInput {
  readonly url: string;
  readonly sessionSlug?: string;
  readonly principal?: string;
}

/** `POST /vault/bindings/resolve` result. */
export interface TesterResult {
  readonly wouldFill: readonly string[];
  readonly blocked: readonly { readonly handle: string; readonly reason: string }[];
}

/** Bindings / policies administration. Authorization (`vault:write`) is the HTTP layer's job. */
export class VaultAdmin {
  private readonly deps: VaultAdminDeps;

  constructor(deps: VaultAdminDeps) {
    this.deps = deps;
  }

  /** `GET /vault/bindings`. */
  listBindings(query: VaultBindingListQuery): Promise<Page<VaultBindingRecord>> {
    return this.deps.bindings.list(query);
  }

  /** @throws `NOT_FOUND` */
  async getBinding(handle: string): Promise<VaultBindingRecord> {
    const binding = await this.deps.bindings.get(handle);
    if (binding === null) throw new AppError('NOT_FOUND', {});
    return binding;
  }

  /**
   * `PUT /vault/bindings/{handle}`: create or update; `ifVersion` is the `If-Match` value.
   * @throws `VALIDATION_FAILED` (bad handle, missing `item_name` on create), `CONFLICT` (version)
   */
  async putBinding(
    handle: string,
    input: VaultBindingInput,
    ifVersion?: number,
  ): Promise<VaultBindingRecord> {
    if (!isValidHandle(handle)) {
      throw new AppError('VALIDATION_FAILED', {
        issues: [{ path: 'handle', message: 'invalid handle', code: 'invalid_string' }],
      });
    }
    const prior = await this.deps.bindings.get(handle);
    const merged = mergeBinding(handle, input, prior, this.deps.clock.now());
    if (merged === null) {
      throw new AppError('VALIDATION_FAILED', {
        issues: [{ path: 'item_name', message: 'item_name is required on create', code: 'custom' }],
      });
    }
    return this.deps.bindings.upsert(merged, ifVersion);
  }

  /** `DELETE /vault/bindings/{handle}`; `removed` is false when nothing existed. */
  deleteBinding(handle: string): Promise<boolean> {
    return this.deps.bindings.remove(handle);
  }

  /** Every stored policy. */
  listPolicies(): Promise<readonly VaultGroupPolicyRecord[]> {
    return this.deps.policies.list();
  }

  /** `PUT /vault/groups/{group_id}/policy` (`__ungrouped__` addresses the ungrouped bucket). */
  async putPolicy(
    groupKey: string,
    input: VaultGroupPolicyInput,
    ifVersion?: number,
  ): Promise<VaultGroupPolicyRecord> {
    const prior = await this.deps.policies.get(groupKey);
    const merged = mergePolicy(groupIdOf(groupKey), input, prior, this.deps.clock.now());
    return this.deps.policies.upsert(merged, ifVersion);
  }

  /** Removes a stored policy (the group falls back to `manual`). */
  deletePolicy(groupKey: string): Promise<boolean> {
    return this.deps.policies.remove(groupKey);
  }

  /** `GET /vault/export` — the v3 wire document. */
  async exportDocument(): Promise<VaultExportWire> {
    return toWireExport(await this.deps.bindings.exportAll());
  }

  /** `POST /vault/import?mode=` — validates with the contracts schema, then merges or replaces. */
  async importDocument(body: unknown, mode: VaultImportMode): Promise<VaultImportResult> {
    const doc = fromWireExport(body, this.deps.clock.now());
    return this.deps.bindings.importAll(doc, mode);
  }

  /**
   * Dry-run of the fill gates for every binding against `url` (the dashboard tester). The subject
   * parts are checked only when supplied; the evaluate gate is not applied.
   */
  async tester(input: TesterInput): Promise<TesterResult> {
    const now = this.deps.clock.now();
    const policies = new PolicySet(await this.deps.policies.list());
    const bindings = await this.deps.bindings.list({ limit: 500 });
    const wouldFill: string[] = [];
    const blocked: { handle: string; reason: string }[] = [];
    for (const b of bindings.items) {
      if (policies.get(b.groupId, now).accessMode === 'reject_all') {
        blocked.push({ handle: b.handle, reason: 'not_authorized' });
        continue;
      }
      const entry: ResolvedEntry = {
        handle: b.handle,
        itemName: b.itemName,
        itemId: b.itemId,
        groupId: b.groupId,
        origins: b.allowedOrigins,
        rule: {
          allowAllSessions: b.allowAllSessions,
          slugGlobs: b.authorizedSessionSlugs,
          principals: b.authorizedPrincipals,
        },
        redactUsername: b.redactUsername,
        requireNoEvaluate: b.requireNoEvaluate,
        dashboardConfirm: b.dashboardConfirm,
        source: 'manual',
      };
      const slugOk =
        input.sessionSlug === undefined || isSlugAuthorized(entry.rule, input.sessionSlug);
      const principalOk =
        input.principal === undefined || isPrincipalAuthorized(entry.rule, input.principal);
      if (!slugOk || !principalOk) {
        blocked.push({ handle: b.handle, reason: 'not_authorized' });
        continue;
      }
      const decision = decideFill({
        session: {
          sessionId: 'tester',
          slug: input.sessionSlug ?? '',
          disableEvaluate: true,
          vaultEnabled: true,
        },
        principal: input.principal ?? '',
        allowEvaluate: false,
        pageUrl: input.url,
        entry,
        checkSubject: false,
      });
      if (decision.kind === 'proceed') wouldFill.push(b.handle);
      else blocked.push({ handle: b.handle, reason: decision.reason });
    }
    return { wouldFill, blocked };
  }
}
