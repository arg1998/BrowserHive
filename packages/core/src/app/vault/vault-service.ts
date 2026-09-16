/** @module app/vault/vault-service — the vault facade for tools, REST and WS: fill/list, backend status/unlock/sync, groups/items, confirm queue, access log, admin. */

import type { OperatorRequestBroker } from '../../domain/operator-requests/broker.ts';
import type { OperatorRequestTerminalStatus } from '../../domain/operator-requests/types.ts';
import type { CallerSubject } from '../../domain/vault/bindings.ts';
import { deriveHandle } from '../../domain/vault/bindings.ts';
import type { VaultBroker } from '../../domain/vault/broker.ts';
import { groupKeyOf } from '../../domain/vault/policies.ts';
import type {
  ListAvailableOptions,
  ListAvailableResult,
  VaultFillContext,
  VaultFillRequest,
  VaultFillResult,
} from '../../domain/vault/types.ts';
import { AppError } from '../../kernel/errors/app-error.ts';
import { secret } from '../../kernel/secret.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Logger } from '../../ports/logger.ts';
import type { OperatorRequestListRow } from '../../ports/persistence/operator-requests.ts';
import type {
  OperatorRequestListQuery,
  Page,
  VaultAccessListQuery,
} from '../../ports/persistence/queries.ts';
import type { VaultGroupPolicyRecord } from '../../ports/persistence/records.ts';
import type {
  VaultAccessListRow,
  VaultAuditRepository,
} from '../../ports/persistence/vault-audit.ts';
import type {
  VaultBindingRepository,
  VaultGroupPolicyRepository,
} from '../../ports/persistence/vault-policy.ts';
import type {
  VaultBackend,
  VaultStatus,
  VaultUnlockDescriptor,
  VaultUnlockInput,
} from '../../ports/vault-backend.ts';
import { VaultAdmin } from './vault-admin.ts';

/** Constructor dependencies of {@link VaultService}. */
export interface VaultServiceDeps {
  /** The `off` backend when `vault=off`. */
  readonly backend: VaultBackend;
  /** `null` when `vault=off`. */
  readonly broker: VaultBroker | null;
  readonly bindings: VaultBindingRepository;
  readonly policies: VaultGroupPolicyRepository;
  readonly audit: VaultAuditRepository;
  /** `null` under stdio (no dashboard to confirm from). */
  readonly confirm: OperatorRequestBroker | null;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** `GET /vault` (camelCase; never shells out). */
export interface VaultOverview {
  readonly backend: VaultBackend['kind'];
  readonly capabilities: VaultBackend['capabilities'];
  readonly unlock: VaultUnlockDescriptor;
  readonly unlocked: boolean;
  readonly bindingsCount: number;
  readonly policiesCount: number;
  readonly now: number;
}

/** One backend group with its binding coverage and policy (`GET /vault/groups`). */
export interface VaultGroupView {
  readonly groupId: string | null;
  readonly name: string;
  readonly path?: string;
  readonly itemCount: number;
  readonly boundCount: number;
  readonly policy: VaultGroupPolicyRecord | null;
}

/** `GET /vault/groups`. */
export interface VaultGroupsView {
  readonly groups: readonly VaultGroupView[];
  readonly duplicates: readonly {
    readonly groupId: string | null;
    readonly name: string;
    readonly ids: readonly string[];
  }[];
}

/** One backend item as listed for binding (`GET /vault/items`). */
export interface VaultItemView {
  readonly itemId: string;
  readonly name: string;
  readonly groupId: string | null;
  readonly loginUris: readonly string[];
  readonly handle: string;
  readonly bound: boolean;
}

/** `POST /vault/unlock` body (exactly one of the two, per `unlock.mode`). */
export interface UnlockInput {
  readonly passphrase?: string;
  readonly token?: string;
}

/** The vault facade. Every method that needs a backend throws `VAULT_NOT_CONFIGURED` when `vault=off`. */
export class VaultService {
  /** Bindings/policies CRUD, tester, export/import. */
  readonly admin: VaultAdmin;
  private readonly deps: VaultServiceDeps;
  private readonly log: Logger;
  private lastStatus: VaultStatus | null = null;

  constructor(deps: VaultServiceDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ module: 'vault.service' });
    this.admin = new VaultAdmin({
      bindings: deps.bindings,
      policies: deps.policies,
      clock: deps.clock,
    });
  }

  /** True when a backend other than `off` is configured. */
  get configured(): boolean {
    return this.deps.backend.kind !== 'off';
  }

  /** @throws `VAULT_NOT_CONFIGURED` */
  assertConfigured(): void {
    if (!this.configured) throw new AppError('VAULT_NOT_CONFIGURED', {});
  }

  /** `vault_fill` (tool). Session lookup/ownership happen before, in the dispatcher. */
  async fill(request: VaultFillRequest, ctx: VaultFillContext): Promise<VaultFillResult> {
    return this.requireBroker().fill(request, ctx);
  }

  /** `vault_list_available` (tool). */
  async listAvailable(
    caller: CallerSubject,
    opts: ListAvailableOptions = {},
    signal?: AbortSignal,
  ): Promise<ListAvailableResult> {
    return this.requireBroker().listAvailable(caller, opts, signal);
  }

  /** `GET /vault` — cached lock state, counts, capabilities. Never shells out. */
  async overview(): Promise<VaultOverview> {
    this.assertConfigured();
    const backend = this.deps.backend;
    const [bindingsCount, policiesCount] = await Promise.all([
      this.deps.bindings.count(),
      this.deps.policies.count(),
    ]);
    const unlocked = this.lastStatus?.unlocked ?? false;
    return {
      backend: backend.kind,
      capabilities: backend.capabilities,
      unlock: this.lastStatus?.unlock ?? {
        required: !unlocked,
        mode: backend.capabilities.unlock,
        hint: backend.unlockHint,
      },
      unlocked,
      bindingsCount,
      policiesCount,
      now: this.deps.clock.now(),
    };
  }

  /** `GET /vault/status` — may call the backend. */
  async status(signal?: AbortSignal): Promise<VaultStatus> {
    this.assertConfigured();
    const status = await this.deps.backend.status(signal);
    this.lastStatus = status;
    return status;
  }

  /**
   * `POST /vault/unlock`.
   * @throws `VALIDATION_FAILED` when the body does not match `unlock.mode`, `VAULT_UNLOCK_FAILED`
   */
  async unlock(input: UnlockInput, signal?: AbortSignal): Promise<void> {
    this.assertConfigured();
    const unlock: VaultUnlockInput | null =
      input.passphrase !== undefined
        ? { mode: 'passphrase', passphrase: secret(input.passphrase) }
        : input.token !== undefined
          ? { mode: 'token', token: secret(input.token) }
          : null;
    const expected = this.deps.backend.capabilities.unlock;
    if (unlock === null || unlock.mode !== expected) {
      const field = expected === 'passphrase' ? 'passphrase' : 'token';
      const message =
        expected === 'none'
          ? 'this backend needs no unlock'
          : `this backend unlocks with a ${field === 'token' ? 'session token' : 'passphrase'}`;
      throw new AppError('VALIDATION_FAILED', {
        issues: [{ path: field, message, code: 'custom' }],
      });
    }
    await this.deps.backend.unlock(unlock, signal);
    this.lastStatus = await this.deps.backend.status(signal);
    this.log.info('vault unlocked', {
      vault: true,
      backend: this.deps.backend.kind,
      mode: unlock.mode,
    });
  }

  /** `POST /vault/lock`. */
  lock(): void {
    this.assertConfigured();
    this.deps.backend.lock();
    this.lastStatus = null;
    this.log.info('vault locked', { vault: true, backend: this.deps.backend.kind });
  }

  /** `POST /vault/sync`. */
  async sync(signal?: AbortSignal): Promise<{ items: number; groups: number; syncedAt: number }> {
    this.assertConfigured();
    const result = await this.deps.backend.sync(signal);
    this.log.info('vault synced', { vault: true, backend: this.deps.backend.kind, ...result });
    return { ...result, syncedAt: this.deps.clock.now() };
  }

  /** `GET /vault/groups` — groups with counts, coverage, policy and same-name duplicates. */
  async groups(signal?: AbortSignal): Promise<VaultGroupsView> {
    this.assertConfigured();
    const [groups, entries, policies, bindings] = await Promise.all([
      this.deps.backend.listGroups(signal),
      this.deps.backend.listEntries({}, signal),
      this.deps.policies.list(),
      this.deps.bindings.list({ limit: 500 }),
    ]);
    const policyByKey = new Map(policies.map((p) => [p.groupKey, p]));
    const itemCount = new Map<string | null, number>();
    for (const e of entries) itemCount.set(e.groupId, (itemCount.get(e.groupId) ?? 0) + 1);
    const boundCount = new Map<string | null, number>();
    for (const b of bindings.items) boundCount.set(b.groupId, (boundCount.get(b.groupId) ?? 0) + 1);
    const byName = new Map<string, { groupId: string | null; ids: string[] }>();
    for (const g of groups) {
      const slot = byName.get(g.name) ?? { groupId: g.id, ids: [] };
      slot.ids.push(g.id ?? '');
      byName.set(g.name, slot);
    }
    return {
      groups: groups.map((g) => ({
        groupId: g.id,
        name: g.name,
        ...(g.path !== undefined && { path: g.path }),
        itemCount: itemCount.get(g.id) ?? 0,
        boundCount: boundCount.get(g.id) ?? 0,
        policy: policyByKey.get(groupKeyOf(g.id)) ?? null,
      })),
      duplicates: [...byName.entries()]
        .filter(([, v]) => v.ids.length > 1)
        .map(([name, v]) => ({ groupId: v.groupId, name, ids: v.ids })),
    };
  }

  /** `GET /vault/items` — backend items with derived handles and binding coverage. */
  async items(
    query: { groupId?: string; q?: string } = {},
    signal?: AbortSignal,
  ): Promise<readonly VaultItemView[]> {
    this.assertConfigured();
    const [groups, entries, bindings] = await Promise.all([
      this.deps.backend.listGroups(signal),
      this.deps.backend.listEntries(
        {
          ...(query.groupId !== undefined && { groupId: query.groupId }),
          ...(query.q !== undefined && { search: query.q }),
        },
        signal,
      ),
      this.deps.bindings.list({ limit: 500 }),
    ]);
    const names = new Map(groups.map((g) => [g.id, g.name]));
    const boundIds = new Set(bindings.items.map((b) => b.itemId));
    const boundHandles = new Set(bindings.items.map((b) => b.handle));
    return entries
      .map((e) => {
        const handle = deriveHandle(names.get(e.groupId) ?? '', e.name);
        return {
          itemId: e.id,
          name: e.name,
          groupId: e.groupId,
          loginUris: e.uris,
          handle,
          bound: boundIds.has(e.id) || boundHandles.has(handle),
        };
      })
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  /** `GET /vault/log` / `GET /sessions/{id}/vault-access`. */
  accessLog(query: VaultAccessListQuery): Promise<Page<VaultAccessListRow>> {
    return this.deps.audit.list(query);
  }

  /** `GET /vault/confirm` — open + history rows of kind `vault_confirm`. */
  async confirms(
    query: OperatorRequestListQuery,
  ): Promise<{ page: Page<OperatorRequestListRow>; openCount: number }> {
    this.assertConfigured();
    const broker = this.requireConfirm();
    return {
      page: await broker.history({ ...query, kind: 'vault_confirm' }),
      openCount: broker.openCount('vault_confirm'),
    };
  }

  /**
   * `POST /vault/confirm/{id}/resolve` — `approve` settles `resolved`, `deny` settles `rejected`
   * with the audit-only `reason`.
   * @throws `NOT_FOUND`, `CONFIRM_NOT_OPEN`
   */
  async resolveConfirm(
    requestId: string,
    decision: 'approve' | 'deny',
    by: string,
    reason?: string,
  ): Promise<OperatorRequestTerminalStatus> {
    this.assertConfigured();
    const result = await this.requireConfirm().resolve(
      requestId,
      {
        status: decision === 'approve' ? 'resolved' : 'rejected',
        ...(reason !== undefined && { reason }),
      },
      by,
    );
    if (result.ok) return result.outcome.status;
    if (result.status === null) throw new AppError('NOT_FOUND', {});
    throw new AppError(
      'CONFIRM_NOT_OPEN',
      { request_id: requestId, status: result.status },
      {
        publicMessage: `Vault confirmation '${requestId}' is not open (status: ${result.status}).`,
      },
    );
  }

  private requireBroker(): VaultBroker {
    this.assertConfigured();
    if (this.deps.broker === null) throw new AppError('VAULT_NOT_CONFIGURED', {});
    return this.deps.broker;
  }

  private requireConfirm(): OperatorRequestBroker {
    if (this.deps.confirm === null) throw new AppError('NOT_FOUND', {});
    return this.deps.confirm;
  }
}
