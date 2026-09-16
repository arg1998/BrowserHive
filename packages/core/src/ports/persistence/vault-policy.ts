/** @module ports/persistence/vault-policy — vault bindings and group policies (D-14). */

import type { Page, VaultBindingListQuery } from './queries.ts';
import type { VaultBindingRecord, VaultExportDocument, VaultGroupPolicyRecord } from './records.ts';

/** Import mode of {@link VaultBindingRepository.importAll}. */
export type VaultImportMode = 'merge' | 'replace';

/** Counts returned by an import. */
export interface VaultImportResult {
  readonly bindings: number;
  readonly policies: number;
}

/** Repository over `vault_bindings`. Optimistic concurrency via `version` (`If-Match`). */
export interface VaultBindingRepository {
  /** Lists bindings ordered by handle. */
  list(query: VaultBindingListQuery): Promise<Page<VaultBindingRecord>>;
  /** Fetches one binding or `null`. */
  get(handle: string): Promise<VaultBindingRecord | null>;
  /**
   * Creates or replaces a binding. When `ifVersion` is given and does not match the stored
   * version, throws `AppError('CONFLICT')` with `current_version`. The stored `version` is
   * incremented on update and set to 1 on create; the returned record reflects storage.
   */
  upsert(binding: VaultBindingRecord, ifVersion?: number): Promise<VaultBindingRecord>;
  /** Deletes a binding; returns true when a row was removed. */
  remove(handle: string): Promise<boolean>;
  /** Every binding and policy as the export document. */
  exportAll(): Promise<VaultExportDocument>;
  /** Imports a document; `replace` clears both tables first. */
  importAll(doc: VaultExportDocument, mode: VaultImportMode): Promise<VaultImportResult>;
  /** Number of bindings. */
  count(): Promise<number>;
}

/** Repository over `vault_group_policies`. */
export interface VaultGroupPolicyRepository {
  /** All policies ordered by group key. */
  list(): Promise<readonly VaultGroupPolicyRecord[]>;
  /** Fetches one policy or `null`. */
  get(groupKey: string): Promise<VaultGroupPolicyRecord | null>;
  /** Creates or replaces a policy with the same version semantics as bindings. */
  upsert(policy: VaultGroupPolicyRecord, ifVersion?: number): Promise<VaultGroupPolicyRecord>;
  /** Deletes a policy; returns true when a row was removed. */
  remove(groupKey: string): Promise<boolean>;
  /** Number of policies. */
  count(): Promise<number>;
}
