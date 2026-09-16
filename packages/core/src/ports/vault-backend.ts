/** @module ports/vault-backend — credential backend port (D-14): capabilities, generic unlock, groups instead of folders. */

import type { VaultBackendKind } from '@browserhive/contracts/enums';
import type { Secret } from '../kernel/secret.ts';

/** How a backend is unlocked. `none` = always open (an OS keychain). */
export type VaultUnlockCapability = 'none' | 'passphrase' | 'token';

/** What a backend can do; surfaced verbatim on `GET /vault` and `server_status`. */
export interface VaultBackendCapabilities {
  readonly unlock: VaultUnlockCapability;
  /** Whether items live in groups (Bitwarden folders). */
  readonly grouping: boolean;
  /** Whether BrowserHive may create or edit items (no backend does today). */
  readonly writable: boolean;
  /** Whether entries may carry a TOTP secret. */
  readonly totp: boolean;
  /** Whether the backend has a local cache that `sync()` refreshes. */
  readonly sync: boolean;
}

/** Generic unlock descriptor (backend-neutral: no backend-specific env var names). */
export interface VaultUnlockDescriptor {
  /** True when the backend is currently locked and needs an unlock before it can serve items. */
  readonly required: boolean;
  readonly mode: VaultUnlockCapability;
  /** Operator-facing hint (`"Run bw unlock --raw … and paste the session token"`); never a secret. */
  readonly hint: string | null;
}

/** Result of {@link VaultBackend.status}. */
export interface VaultStatus {
  readonly unlocked: boolean;
  readonly unlock: VaultUnlockDescriptor;
  /** Epoch ms of the check. */
  readonly checkedAt: number;
}

/** Secret material handed to {@link VaultBackend.unlock}; wrapped so it can never print. */
export type VaultUnlockInput =
  | { readonly mode: 'passphrase'; readonly passphrase: Secret<string> }
  | { readonly mode: 'token'; readonly token: Secret<string> };

/** One enumerated entry. Never carries secret material. */
export interface VaultEntrySummary {
  /** Backend item id (Bitwarden GUID); stable. */
  readonly id: string;
  readonly name: string;
  /** Group id (Bitwarden folder GUID); `null` = ungrouped. */
  readonly groupId: string | null;
  /** The item's own saved login URIs (may be empty). */
  readonly uris: readonly string[];
}

/** Full item material for one entry. Held in memory for milliseconds during a fill. */
export interface VaultEntry extends VaultEntrySummary {
  readonly username: string;
  readonly password: Secret<string>;
  /** Present only when the backend reports `totp` and the item has one. */
  readonly totp?: Secret<string>;
}

/** A backend group (Bitwarden folder); `id: null` is the implicit ungrouped bucket. */
export interface VaultGroup {
  readonly id: string | null;
  readonly name: string;
  /** Tree backends may expose a path (`"Work/Infra"`). */
  readonly path?: string;
}

/** Filters for {@link VaultBackend.listEntries}. */
export interface VaultEntryQuery {
  readonly groupId?: string | null;
  readonly search?: string;
}

/** Reference used by {@link VaultBackend.getEntry}: the item id wins when non-empty. */
export interface VaultEntryRef {
  readonly id?: string;
  readonly name?: string;
}

/** Counts after a {@link VaultBackend.sync}. */
export interface VaultSyncResult {
  readonly items: number;
  readonly groups: number;
}

/**
 * Credential backend. Only `bitwarden` (and the `off` placeholder) are implemented; every method
 * throws `AppError` with a registry code: `VAULT_LOCKED`, `VAULT_ENTRY_NOT_FOUND`,
 * `VAULT_BACKEND_ERROR`, `VAULT_UNLOCK_FAILED`, `VAULT_SYNC_UNSUPPORTED`, `VAULT_NOT_CONFIGURED`.
 */
export interface VaultBackend {
  readonly kind: VaultBackendKind;
  readonly capabilities: VaultBackendCapabilities;
  /** Static operator hint for the unlock form (`GET /vault` never shells out); never a secret. */
  readonly unlockHint: string | null;
  /** Lock state; may shell out. Never throws for a locked backend. */
  status(signal?: AbortSignal): Promise<VaultStatus>;
  /** Unlocks with a passphrase or token per `capabilities.unlock`. */
  unlock(input: VaultUnlockInput, signal?: AbortSignal): Promise<void>;
  /** Drops the in-memory session so the next call reports locked. */
  lock(): void;
  /** Refreshes a local cache from the remote; `VAULT_SYNC_UNSUPPORTED` when `capabilities.sync` is false. */
  sync(signal?: AbortSignal): Promise<VaultSyncResult>;
  /** Names/ids/groups/uris of entries. Never returns secret values. */
  listEntries(query: VaultEntryQuery, signal?: AbortSignal): Promise<readonly VaultEntrySummary[]>;
  /** Full item material by id (preferred) or name. */
  getEntry(ref: VaultEntryRef, signal?: AbortSignal): Promise<VaultEntry>;
  /** Every group; grouping backends always include the ungrouped bucket `{ id: null }`. */
  listGroups(signal?: AbortSignal): Promise<readonly VaultGroup[]>;
}
