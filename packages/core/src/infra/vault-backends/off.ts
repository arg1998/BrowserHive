/** @module infra/vault-backends/off — the `vault=off` placeholder backend: every operation is VAULT_NOT_CONFIGURED. */

import { AppError } from '../../kernel/errors/app-error.ts';
import type {
  VaultBackend,
  VaultBackendCapabilities,
  VaultEntry,
  VaultEntryQuery,
  VaultEntryRef,
  VaultEntrySummary,
  VaultGroup,
  VaultStatus,
  VaultSyncResult,
  VaultUnlockInput,
} from '../../ports/vault-backend.ts';

const OFF_CAPABILITIES: VaultBackendCapabilities = {
  unlock: 'none',
  grouping: false,
  writable: false,
  totp: false,
  sync: false,
};

function notConfigured(): AppError<'VAULT_NOT_CONFIGURED'> {
  return new AppError('VAULT_NOT_CONFIGURED', {});
}

/** The backend installed when no vault is configured; lets the service exist unconditionally. */
export class OffVaultBackend implements VaultBackend {
  readonly kind = 'off' as const;
  readonly capabilities = OFF_CAPABILITIES;
  readonly unlockHint = null;

  status(): Promise<VaultStatus> {
    return Promise.reject(notConfigured());
  }

  unlock(_input: VaultUnlockInput): Promise<void> {
    return Promise.reject(notConfigured());
  }

  lock(): void {
    // Nothing to lock.
  }

  sync(): Promise<VaultSyncResult> {
    return Promise.reject(notConfigured());
  }

  listEntries(_query: VaultEntryQuery): Promise<readonly VaultEntrySummary[]> {
    return Promise.reject(notConfigured());
  }

  getEntry(_ref: VaultEntryRef): Promise<VaultEntry> {
    return Promise.reject(notConfigured());
  }

  listGroups(): Promise<readonly VaultGroup[]> {
    return Promise.reject(notConfigured());
  }
}
