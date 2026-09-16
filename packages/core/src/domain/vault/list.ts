/** @module domain/vault/list — `vault_list_available` semantics: caller-visible entries, page scoping, honesty probe, denied-listing audit. */

import type { Clock } from '../../ports/clock.ts';
import type { EventPublisher } from '../../ports/event-bus.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { Logger } from '../../ports/logger.ts';
import type { VaultAccessRecord } from '../../ports/persistence/records.ts';
import type { VaultAuditRepository } from '../../ports/persistence/vault-audit.ts';
import type {
  VaultBindingRepository,
  VaultGroupPolicyRepository,
} from '../../ports/persistence/vault-policy.ts';
import type { VaultBackend } from '../../ports/vault-backend.ts';
import { bindingRule, type CallerSubject, isCallerAuthorized } from './bindings.ts';
import { publishVaultAccess } from './events.ts';
import { checkOrigin, domainKey, pageScope } from './origin.ts';
import { PolicySet } from './policies.ts';
import { allowAllEntries, enumerateBackend } from './resolve.ts';
import type {
  AvailableEntry,
  ListAvailableOptions,
  ListAvailableResult,
  VaultEvents,
} from './types.ts';

/** Entry name written on the audit row of a denied listing. */
export const LIST_AUDIT_ENTRY = '(vault_list_available)';

/** What listing reads and writes. */
export interface ListDeps {
  readonly backend: VaultBackend;
  readonly bindings: VaultBindingRepository;
  readonly policies: VaultGroupPolicyRepository;
  readonly audit: VaultAuditRepository;
  readonly events: EventPublisher<VaultEvents>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * Entries the caller is authorized for: manual bindings (excluding `reject_all` groups) plus
 * allow-all group items with ≥ 1 usable origin, deduped by handle with **manual winning**, sorted.
 * Backend errors on the allow-all path (locked) degrade to the manual set — listing never throws.
 * With `currentUrl` the list is scoped to that page; with `declaredUrl` the honesty probe must
 * match the real page by registrable domain, else the listing is denied and audited.
 */
export async function listAvailable(
  deps: ListDeps,
  caller: CallerSubject,
  opts: ListAvailableOptions = {},
  signal?: AbortSignal,
): Promise<ListAvailableResult> {
  const all = await composeVisible(deps, caller, signal);

  const currentUrl = (opts.currentUrl ?? '').trim();
  const page = currentUrl.length > 0 ? pageScope(currentUrl) : null;

  const declared = (opts.declaredUrl ?? '').trim();
  if (declared.length > 0) {
    const declaredKey = domainKey(declared);
    const actualKey = page?.key ?? null;
    if (declaredKey === null || actualKey === null || declaredKey !== actualKey) {
      await reportMismatch(
        deps,
        { ...opts, sessionSlug: opts.sessionSlug ?? caller.slug },
        currentUrl,
        declaredKey,
        actualKey,
      );
      return {
        entries: [],
        scope: 'rejected',
        scopedTo: actualKey,
        mismatch: { declared: declaredKey ?? declared, actual: actualKey },
        note: `Declared login domain ${declaredKey ?? declared} does not match the session's current page${actualKey ? ` (${actualKey})` : ' (no page loaded)'}. Listing denied and reported — pass the domain of the page the session has actually navigated to.`,
      };
    }
  }

  if (currentUrl.length === 0) return { entries: all, scope: 'unscoped', scopedTo: null };
  if (page === null) {
    return {
      entries: [],
      scope: 'no_page',
      scopedTo: null,
      note: 'No http(s) login page is loaded — navigate to the login page first. Listings are scoped to the site the session is currently on.',
    };
  }
  const entries = all.filter((e) => checkOrigin(currentUrl, e.allowedOrigins).outcome === 'pass');
  return { entries, scope: 'page', scopedTo: page.key };
}

async function composeVisible(
  deps: ListDeps,
  caller: CallerSubject,
  signal: AbortSignal | undefined,
): Promise<readonly AvailableEntry[]> {
  const now = deps.clock.now();
  const policies = new PolicySet(await deps.policies.list());
  const out = new Map<string, AvailableEntry>();

  const bindings = await deps.bindings.list({ limit: 500 });
  for (const b of bindings.items) {
    if (policies.get(b.groupId, now).accessMode === 'reject_all') continue;
    if (!isCallerAuthorized(bindingRule(b), caller)) continue;
    out.set(b.handle, {
      entryName: b.handle,
      allowedOrigins: [...b.allowedOrigins],
      redactUsername: b.redactUsername,
      requireNoEvaluate: b.requireNoEvaluate,
    });
  }

  if (policies.hasAllowAll()) {
    try {
      const inventory = await enumerateBackend(deps.backend, signal);
      for (const e of allowAllEntries(inventory, policies, now)) {
        if (!isCallerAuthorized(e.rule, caller)) continue;
        if (e.origins.length === 0) continue;
        if (out.has(e.handle)) continue;
        out.set(e.handle, {
          entryName: e.handle,
          allowedOrigins: e.origins,
          redactUsername: e.redactUsername,
          requireNoEvaluate: e.requireNoEvaluate,
        });
      }
    } catch (err) {
      deps.logger.debug('vault list degraded', { vault: true, err });
    }
  }
  return [...out.values()].sort((a, b) => a.entryName.localeCompare(b.entryName));
}

/** Logs and audits an unfaithful `vault_list_available` call (`VAULT_LIST_DENIED`). */
async function reportMismatch(
  deps: ListDeps,
  opts: ListAvailableOptions,
  pageUrl: string,
  declaredKey: string | null,
  actualKey: string | null,
): Promise<void> {
  deps.logger.warn('vault domain mismatch', {
    vault: true,
    code: 'VAULT_LIST_DENIED',
    tool: 'vault_list_available',
    ...(opts.sessionId !== undefined && { session_id: opts.sessionId }),
    declared_domain: declaredKey,
    actual_domain: actualKey,
  });
  if (opts.sessionId === undefined) return;
  const record: VaultAccessRecord = {
    eventId: deps.ids.eventId(),
    sessionId: opts.sessionId,
    toolEventId: opts.toolEventId ?? null,
    entryName: LIST_AUDIT_ENTRY,
    handle: null,
    result: 'blocked',
    reason: 'list_url_mismatch',
    evaluateEnabled: false,
    pageUrl,
    originCheck: 'fail',
    principalId: null,
    details: {
      code: 'VAULT_LIST_DENIED',
      reason: 'list_url_mismatch',
      declared_domain: declaredKey,
      actual_domain: actualKey,
    },
    ts: deps.clock.now(),
  };
  await deps.audit.insert(record);
  publishVaultAccess(deps.events, record, opts.sessionSlug ?? null);
}
