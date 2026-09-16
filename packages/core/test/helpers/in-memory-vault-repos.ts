/** @module test/helpers/in-memory-vault-repos — Map-backed repositories for the vault and operator-request ports (spec 09 §4). */

import { AppError } from '../../src/kernel/errors/app-error.ts';
import type { OperatorRequestKind } from '../../src/ports/persistence/enums.ts';
import type { OperatorActionRepository } from '../../src/ports/persistence/operations.ts';
import type {
  OperatorRequestFacets,
  OperatorRequestListRow,
  OperatorRequestRepository,
  OperatorRequestResolution,
} from '../../src/ports/persistence/operator-requests.ts';
import type {
  AuditListQuery,
  OperatorRequestListQuery,
  Page,
  VaultAccessListQuery,
  VaultBindingListQuery,
} from '../../src/ports/persistence/queries.ts';
import type {
  NewOperatorAction,
  NewOperatorRequest,
  OperatorActionRecord,
  OperatorRequestRecord,
  VaultAccessRecord,
  VaultBindingRecord,
  VaultExportDocument,
  VaultGroupPolicyRecord,
} from '../../src/ports/persistence/records.ts';
import type {
  VaultAccessListRow,
  VaultAuditRepository,
} from '../../src/ports/persistence/vault-audit.ts';
import type {
  VaultBindingRepository,
  VaultGroupPolicyRepository,
  VaultImportMode,
  VaultImportResult,
} from '../../src/ports/persistence/vault-policy.ts';

function page<T>(items: readonly T[]): Page<T> {
  return { items, nextCursor: null, total: items.length };
}

/** `vault_bindings` in memory with the same optimistic-version semantics as SQLite. */
export class InMemoryVaultBindingRepository implements VaultBindingRepository {
  readonly rows = new Map<string, VaultBindingRecord>();
  private readonly policies: InMemoryVaultGroupPolicyRepository;

  constructor(policies: InMemoryVaultGroupPolicyRepository) {
    this.policies = policies;
  }

  list(query: VaultBindingListQuery): Promise<Page<VaultBindingRecord>> {
    const q = query.q?.toLowerCase();
    const items = [...this.rows.values()]
      .filter((b) => query.groupId === undefined || b.groupId === query.groupId)
      .filter(
        (b) =>
          q === undefined ||
          b.handle.toLowerCase().includes(q) ||
          b.title.toLowerCase().includes(q) ||
          b.itemName.toLowerCase().includes(q),
      )
      .sort((a, b) => a.handle.localeCompare(b.handle));
    return Promise.resolve(page(items));
  }

  get(handle: string): Promise<VaultBindingRecord | null> {
    return Promise.resolve(this.rows.get(handle) ?? null);
  }

  upsert(binding: VaultBindingRecord, ifVersion?: number): Promise<VaultBindingRecord> {
    const prior = this.rows.get(binding.handle);
    if (ifVersion !== undefined && prior !== undefined && prior.version !== ifVersion) {
      return Promise.reject(new AppError('CONFLICT', { current_version: prior.version }));
    }
    const stored: VaultBindingRecord = {
      ...binding,
      version: prior === undefined ? 1 : prior.version + 1,
      createdAt: prior?.createdAt ?? binding.createdAt,
    };
    this.rows.set(binding.handle, stored);
    return Promise.resolve(stored);
  }

  remove(handle: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(handle));
  }

  exportAll(): Promise<VaultExportDocument> {
    return Promise.resolve({
      version: 3,
      bindings: [...this.rows.values()].sort((a, b) => a.handle.localeCompare(b.handle)),
      policies: [...this.policies.rows.values()].sort((a, b) =>
        a.groupKey.localeCompare(b.groupKey),
      ),
    });
  }

  async importAll(doc: VaultExportDocument, mode: VaultImportMode): Promise<VaultImportResult> {
    if (mode === 'replace') {
      this.rows.clear();
      this.policies.rows.clear();
    }
    for (const b of doc.bindings) await this.upsert(b);
    for (const p of doc.policies) await this.policies.upsert(p);
    return { bindings: doc.bindings.length, policies: doc.policies.length };
  }

  count(): Promise<number> {
    return Promise.resolve(this.rows.size);
  }
}

/** `vault_group_policies` in memory. */
export class InMemoryVaultGroupPolicyRepository implements VaultGroupPolicyRepository {
  readonly rows = new Map<string, VaultGroupPolicyRecord>();

  list(): Promise<readonly VaultGroupPolicyRecord[]> {
    return Promise.resolve(
      [...this.rows.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey)),
    );
  }

  get(groupKey: string): Promise<VaultGroupPolicyRecord | null> {
    return Promise.resolve(this.rows.get(groupKey) ?? null);
  }

  upsert(policy: VaultGroupPolicyRecord, ifVersion?: number): Promise<VaultGroupPolicyRecord> {
    const prior = this.rows.get(policy.groupKey);
    if (ifVersion !== undefined && prior !== undefined && prior.version !== ifVersion) {
      return Promise.reject(new AppError('CONFLICT', { current_version: prior.version }));
    }
    const stored: VaultGroupPolicyRecord = {
      ...policy,
      version: prior === undefined ? 1 : prior.version + 1,
      createdAt: prior?.createdAt ?? policy.createdAt,
    };
    this.rows.set(policy.groupKey, stored);
    return Promise.resolve(stored);
  }

  remove(groupKey: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(groupKey));
  }

  count(): Promise<number> {
    return Promise.resolve(this.rows.size);
  }
}

/** `vault_access` in memory. */
export class InMemoryVaultAuditRepository implements VaultAuditRepository {
  readonly rows: VaultAccessRecord[] = [];

  insert(record: VaultAccessRecord): Promise<void> {
    if (!this.rows.some((r) => r.eventId === record.eventId)) this.rows.push(record);
    return Promise.resolve();
  }

  list(query: VaultAccessListQuery): Promise<Page<VaultAccessListRow>> {
    const items = this.rows
      .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
      .filter((r) => query.results === undefined || query.results.includes(r.result))
      .filter((r) => query.entryName === undefined || r.entryName === query.entryName)
      .map((r) => ({ ...r, sessionSlug: null }));
    return Promise.resolve(page(items));
  }

  /** Rows for one session. */
  forSession(sessionId: string): VaultAccessRecord[] {
    return this.rows.filter((r) => r.sessionId === sessionId);
  }
}

/** `operator_requests` in memory. */
export class InMemoryOperatorRequestRepository implements OperatorRequestRepository {
  readonly rows = new Map<string, OperatorRequestRecord>();

  insert(record: NewOperatorRequest): Promise<void> {
    if (this.rows.has(record.requestId)) return Promise.resolve();
    if (
      record.idempotencyKey !== null &&
      [...this.rows.values()].some(
        (r) => r.sessionId === record.sessionId && r.idempotencyKey === record.idempotencyKey,
      )
    ) {
      return Promise.resolve();
    }
    this.rows.set(record.requestId, {
      ...record,
      status: 'pending',
      message: null,
      resolvedBy: null,
      resolutionReason: null,
      resolvedAt: null,
    });
    return Promise.resolve();
  }

  resolve(requestId: string, resolution: OperatorRequestResolution): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (row === undefined || row.status !== 'pending') return Promise.resolve(false);
    this.rows.set(requestId, {
      ...row,
      status: resolution.status,
      message: resolution.message ?? null,
      resolvedBy: resolution.resolvedBy ?? null,
      resolutionReason: resolution.reason ?? null,
      resolvedAt: resolution.at,
    });
    return Promise.resolve(true);
  }

  open(kind?: OperatorRequestKind): Promise<readonly OperatorRequestListRow[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.status === 'pending' && (kind === undefined || r.kind === kind))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(toRow),
    );
  }

  get(requestId: string): Promise<OperatorRequestListRow | null> {
    const row = this.rows.get(requestId);
    return Promise.resolve(row === undefined ? null : toRow(row));
  }

  getByIdempotencyKey(sessionId: string, key: string): Promise<OperatorRequestListRow | null> {
    const row = [...this.rows.values()].find(
      (r) => r.sessionId === sessionId && r.idempotencyKey === key,
    );
    return Promise.resolve(row === undefined ? null : toRow(row));
  }

  listHistory(query: OperatorRequestListQuery): Promise<Page<OperatorRequestListRow>> {
    const items = [...this.rows.values()]
      .filter((r) => query.kind === undefined || r.kind === query.kind)
      .filter((r) => query.statuses === undefined || query.statuses.includes(r.status))
      .filter((r) => query.modes === undefined || (r.mode !== null && query.modes.includes(r.mode)))
      .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toRow);
    return Promise.resolve(page(items));
  }

  async facets(query: OperatorRequestListQuery): Promise<OperatorRequestFacets> {
    const { statuses, modes, ...rest } = query;
    const tally = async (
      key: 'status' | 'mode',
      q: OperatorRequestListQuery,
    ): Promise<{ value: string; count: number }[]> => {
      const counts = new Map<string, number>();
      for (const row of (await this.listHistory(q)).items) {
        const value = row[key];
        if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }));
    };
    return {
      statuses: await tally('status', { ...rest, ...(modes !== undefined && { modes }) }),
      modes: await tally('mode', { ...rest, ...(statuses !== undefined && { statuses }) }),
    };
  }

  countOpen(kind?: OperatorRequestKind): Promise<number> {
    return this.open(kind).then((rows) => rows.length);
  }
}

function toRow(r: OperatorRequestRecord): OperatorRequestListRow {
  return {
    ...r,
    sessionSlug: null,
    waitedMs: r.resolvedAt === null ? null : r.resolvedAt - r.createdAt,
  };
}

/** `operator_actions` in memory. */
export class InMemoryOperatorActionRepository implements OperatorActionRepository {
  readonly rows: OperatorActionRecord[] = [];

  append(action: NewOperatorAction): Promise<number> {
    const seq = this.rows.length + 1;
    this.rows.push({ ...action, seq });
    return Promise.resolve(seq);
  }

  list(query: AuditListQuery): Promise<Page<OperatorActionRecord>> {
    const items = [...this.rows]
      .filter((r) => query.principalId === undefined || r.principalId === query.principalId)
      .reverse();
    return Promise.resolve(page(items));
  }
}

/** Every vault/operator-request repository, wired together. */
export function createVaultRepos(): {
  bindings: InMemoryVaultBindingRepository;
  policies: InMemoryVaultGroupPolicyRepository;
  audit: InMemoryVaultAuditRepository;
  requests: InMemoryOperatorRequestRepository;
  actions: InMemoryOperatorActionRepository;
} {
  const policies = new InMemoryVaultGroupPolicyRepository();
  return {
    bindings: new InMemoryVaultBindingRepository(policies),
    policies,
    audit: new InMemoryVaultAuditRepository(),
    requests: new InMemoryOperatorRequestRepository(),
    actions: new InMemoryOperatorActionRepository(),
  };
}
