/** @module app/vault/vault-admin — operator-side policy administration: bindings and group policies CRUD (optimistic version), tester, export/import. */

import {
  type HarnessSubject,
  normalizeHarness,
  UNKNOWN_HARNESS,
} from '@browserhive/contracts/harness';
import { isPrincipalAuthorized } from '../../domain/policies/access-rule.ts';
import {
  isSlugAuthorized,
  isValidHandle,
  mergeBinding,
  type VaultBindingInput,
} from '../../domain/vault/bindings.ts';
import { decideFill } from '../../domain/vault/decide-fill.ts';
import { checkHarnessRules, type HarnessRuleSource } from '../../domain/vault/harness-rule.ts';
import {
  groupIdOf,
  mergePolicy,
  PolicySet,
  type VaultGroupPolicyInput,
} from '../../domain/vault/policies.ts';
import { manualEntry } from '../../domain/vault/resolve.ts';
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
  /** Harness slug of the session to stand in for (D-48). */
  readonly harness?: string;
  /** Its exact declared name; alone, it is normalised into `harness`. */
  readonly harnessDeclared?: string;
}

/** One binding the dry run would refuse; `rule` names the harness list that refused. */
export interface TesterBlocked {
  readonly handle: string;
  readonly reason: string;
  readonly rule?: HarnessRuleSource;
}

/** `POST /vault/bindings/resolve` result. */
export interface TesterResult {
  readonly wouldFill: readonly string[];
  readonly blocked: readonly TesterBlocked[];
  /** Bindings with a harness list that was not checked because no harness was given. */
  readonly harnessListsUnchecked: readonly string[];
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
   * Dry run of the fill gates for every binding against `url` (the dashboard tester), in the
   * broker's order: group `reject_all` → principal → slug → harness (D-48) → origin. The subject
   * parts are checked only when supplied; the evaluate gate is not applied. The harness check is the
   * broker's own `checkHarnessRules` over the same entry (`manualEntry`), so the two always agree;
   * without a harness, bindings whose lists would have applied are reported as unchecked.
   */
  async tester(input: TesterInput): Promise<TesterResult> {
    const now = this.deps.clock.now();
    const policies = new PolicySet(await this.deps.policies.list());
    const bindings = await this.deps.bindings.list({ limit: 500 });
    const subject = testerHarness(input);
    const wouldFill: string[] = [];
    const blocked: TesterBlocked[] = [];
    const unchecked: string[] = [];
    for (const b of bindings.items) {
      const policy = policies.get(b.groupId, now);
      if (policy.accessMode === 'reject_all') {
        blocked.push({ handle: b.handle, reason: 'not_authorized' });
        continue;
      }
      const entry = manualEntry(b, policy);
      const principalOk =
        input.principal === undefined || isPrincipalAuthorized(entry.rule, input.principal);
      const slugOk =
        input.sessionSlug === undefined || isSlugAuthorized(entry.rule, input.sessionSlug);
      if (!principalOk || !slugOk) {
        blocked.push({ handle: b.handle, reason: 'not_authorized' });
        continue;
      }
      if (subject === null) {
        if (entry.harnessRules.binding !== null || entry.harnessRules.group !== null) {
          unchecked.push(b.handle);
        }
      } else {
        const verdict = checkHarnessRules(entry.harnessRules, subject);
        if (!verdict.allowed) {
          blocked.push({ handle: b.handle, reason: 'harness_not_allowed', rule: verdict.rule });
          continue;
        }
      }
      const decision = decideFill({
        session: {
          sessionId: 'tester',
          slug: input.sessionSlug ?? '',
          disableEvaluate: true,
          vaultEnabled: true,
          harness: subject?.harness ?? null,
          harnessDeclared: subject?.declared ?? null,
        },
        principal: input.principal ?? '',
        allowEvaluate: false,
        pageUrl: input.url,
        entry,
        // Principal, slug and harness were checked above, each only when supplied.
        checkSubject: false,
      });
      if (decision.kind === 'proceed') wouldFill.push(b.handle);
      else blocked.push({ handle: b.handle, reason: decision.reason });
    }
    return { wouldFill, blocked, harnessListsUnchecked: unchecked };
  }
}

/**
 * The launch identity the tester stands in for, or `null` when none was given. A declared name
 * alone is normalised into its slug exactly as a declared signal is when a session launches.
 */
export function testerHarness(input: TesterInput): HarnessSubject | null {
  if (input.harness === undefined && input.harnessDeclared === undefined) return null;
  return {
    harness: input.harness ?? normalizeHarness(input.harnessDeclared) ?? UNKNOWN_HARNESS,
    declared: input.harnessDeclared ?? null,
  };
}
