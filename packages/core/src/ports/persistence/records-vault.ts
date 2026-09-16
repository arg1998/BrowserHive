/** @module ports/persistence/records-vault — vault binding and group policy records (D-14). */

import type { VaultAccessMode } from './enums.ts';

// --- vault policy -----------------------------------------------------------------------------

/** A vault binding (`vault_bindings`, D-14). */
export interface VaultBindingRecord {
  readonly handle: string;
  readonly tenantId: string | null;
  readonly title: string;
  readonly itemName: string;
  readonly itemId: string;
  readonly groupId: string | null;
  readonly allowedOrigins: readonly string[];
  readonly authorizedPrincipals: readonly string[];
  readonly authorizedSessionSlugs: readonly string[];
  readonly allowAllSessions: boolean;
  readonly redactUsername: boolean;
  readonly requireNoEvaluate: boolean;
  readonly dashboardConfirm: boolean;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A vault group policy (`vault_group_policies`); `groupKey` is `groupId` or `__ungrouped__`. */
export interface VaultGroupPolicyRecord {
  readonly groupKey: string;
  readonly groupId: string | null;
  readonly tenantId: string | null;
  readonly accessMode: VaultAccessMode;
  readonly allowAllSessions: boolean;
  readonly sessionSlugGlobs: readonly string[];
  readonly authorizedPrincipals: readonly string[];
  readonly dashboardConfirm: boolean;
  readonly requireNoEvaluate: boolean;
  readonly redactUsername: boolean;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The `/vault/export` document (version 3). */
export interface VaultExportDocument {
  readonly version: 3;
  readonly bindings: readonly VaultBindingRecord[];
  readonly policies: readonly VaultGroupPolicyRecord[];
}
