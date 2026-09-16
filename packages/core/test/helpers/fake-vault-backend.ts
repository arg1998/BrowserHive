/** @module test/helpers/fake-vault-backend — in-memory `VaultBackend` with configurable capabilities, entries and failures (spec 09 §4). */

import type { VaultBackendKind } from '@browserhive/contracts/enums';
import { AppError } from '../../src/kernel/errors/app-error.ts';
import { secret } from '../../src/kernel/secret.ts';
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
} from '../../src/ports/vault-backend.ts';

/** Secret material the fake hands out for an entry. */
export interface FakeCredential {
  readonly username: string;
  readonly password: string;
  readonly totp?: string;
}

/** Defaults mirror the Bitwarden adapter. */
export const FAKE_CAPABILITIES: VaultBackendCapabilities = {
  unlock: 'token',
  grouping: true,
  writable: false,
  totp: true,
  sync: true,
};

/** In-memory `VaultBackend` fake with configurable capabilities. Every call is recorded in `calls`. */
export class FakeVaultBackend implements VaultBackend {
  readonly kind: VaultBackendKind;
  readonly capabilities: VaultBackendCapabilities;
  readonly unlockHint = 'fake hint';
  unlocked = true;
  passphrase = 'correct-horse';
  token = 'fake-session-token';
  /** When set, `getEntry` rejects with it. */
  throwOnGet: unknown = null;
  /** When set, enumeration (`listEntries`/`listGroups`) rejects with it. */
  throwOnList: unknown = null;
  entries: VaultEntrySummary[] = [{ id: 'i1', name: 'linkedin', groupId: null, uris: [] }];
  groups: VaultGroup[] = [{ id: null, name: 'No Folder' }];
  credentials = new Map<string, FakeCredential>();
  readonly calls: string[] = [];
  private now = 1_700_000_000_000;

  constructor(
    options: { kind?: VaultBackendKind; capabilities?: Partial<VaultBackendCapabilities> } = {},
  ) {
    this.kind = options.kind ?? 'bitwarden';
    this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
  }

  /** Registers the credential returned for an item id or name. */
  setCredential(idOrName: string, credential: FakeCredential): void {
    this.credentials.set(idOrName, credential);
  }

  status(): Promise<VaultStatus> {
    this.calls.push('status');
    return Promise.resolve({
      unlocked: this.unlocked,
      unlock: { required: !this.unlocked, mode: this.capabilities.unlock, hint: this.unlockHint },
      checkedAt: this.now,
    });
  }

  unlock(input: VaultUnlockInput): Promise<void> {
    this.calls.push(`unlock:${input.mode}`);
    const ok =
      input.mode === 'passphrase'
        ? input.passphrase.reveal() === this.passphrase
        : input.token.reveal() === this.token;
    if (!ok) return Promise.reject(new AppError('VAULT_UNLOCK_FAILED', { mode: input.mode }));
    this.unlocked = true;
    return Promise.resolve();
  }

  lock(): void {
    this.calls.push('lock');
    this.unlocked = false;
  }

  sync(): Promise<VaultSyncResult> {
    this.calls.push('sync');
    if (!this.capabilities.sync) {
      return Promise.reject(new AppError('VAULT_SYNC_UNSUPPORTED', { backend: this.kind }));
    }
    this.requireUnlocked();
    return Promise.resolve({ items: this.entries.length, groups: this.groups.length });
  }

  listEntries(query: VaultEntryQuery): Promise<readonly VaultEntrySummary[]> {
    this.calls.push('listEntries');
    if (this.throwOnList !== null) return Promise.reject(this.throwOnList);
    this.requireUnlocked();
    const search = query.search?.toLowerCase();
    return Promise.resolve(
      this.entries.filter(
        (e) =>
          (query.groupId === undefined || e.groupId === query.groupId) &&
          (search === undefined || e.name.toLowerCase().includes(search)),
      ),
    );
  }

  getEntry(ref: VaultEntryRef): Promise<VaultEntry> {
    this.calls.push(`getEntry:${ref.id ?? ''}:${ref.name ?? ''}`);
    if (this.throwOnGet !== null) return Promise.reject(this.throwOnGet);
    this.requireUnlocked();
    const key = ref.id !== undefined && ref.id.length > 0 ? ref.id : (ref.name ?? '');
    const cred = this.credentials.get(key) ?? this.credentials.get(ref.name ?? '');
    const summary =
      this.entries.find((e) => e.id === key) ?? this.entries.find((e) => e.name === ref.name);
    if (cred === undefined) {
      return Promise.reject(new AppError('VAULT_ENTRY_NOT_FOUND', { entry_name: key }));
    }
    return Promise.resolve({
      id: summary?.id ?? key,
      name: summary?.name ?? key,
      groupId: summary?.groupId ?? null,
      uris: summary?.uris ?? [],
      username: cred.username,
      password: secret(cred.password),
      ...(cred.totp !== undefined && { totp: secret(cred.totp) }),
    });
  }

  listGroups(): Promise<readonly VaultGroup[]> {
    this.calls.push('listGroups');
    if (this.throwOnList !== null) return Promise.reject(this.throwOnList);
    this.requireUnlocked();
    return Promise.resolve(this.groups);
  }

  private requireUnlocked(): void {
    if (!this.unlocked) throw new AppError('VAULT_LOCKED', { backend: this.kind });
  }
}
