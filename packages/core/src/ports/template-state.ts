/** @module ports/template-state — a template's browser state in memory and its encrypted files (spec 13 §2.4, §2.6, §3.9): the key ring, the state store (encryption included, plaintext only in memory) and the shape of a Playwright storage state. */

import type { StateSlot, TemplateKey } from '../domain/templates/envelope.ts';
import type { TemplateStateFileRecord } from './persistence/index.ts';

export type { StateSlot, TemplateKey } from '../domain/templates/envelope.ts';

/** A cookie of a storage state (Playwright's shape; `expires` in epoch seconds, `-1` = session). */
export interface StateCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None';
}

/** One origin's storage (Playwright's shape; `indexedDB` passed through as Playwright wrote it). */
export interface StateOrigin {
  readonly origin: string;
  readonly localStorage: readonly { readonly name: string; readonly value: string }[];
  readonly indexedDB?: readonly unknown[];
}

/**
 * A template's sign-ins as Playwright reads and applies them (`context.storageState({indexedDB:
 * true})`, `context.setStorageState`). Exists only in memory (spec 13 §2.4).
 */
export interface TemplateState {
  readonly cookies: readonly StateCookie[];
  readonly origins: readonly StateOrigin[];
}

/** The keys this process holds (spec 13 §2.4). */
export interface TemplateKeyRing {
  /** The key new files are written with; `null` = `TEMPLATE_KEY_MISSING` (nothing is written). */
  readonly current: TemplateKey | null;
  /** `templateKeyPrevious`: read only. */
  readonly previous: TemplateKey | null;
}

/** A file of a template's `versions/` directory. */
export interface StateFileInfo {
  readonly slot: StateSlot;
  /** The key id in the file's header; `null` when the header cannot be read. */
  readonly keyId: string | null;
  readonly sizeBytes: number;
}

/**
 * The encrypted files under `templates/<id>/versions/` (spec 13 §2.4). Written to `<name>.tmp` with
 * mode 0600, `fsync`ed and renamed; never written in plain text.
 */
export interface TemplateStateStore {
  /** The keys in use. */
  readonly keys: TemplateKeyRing;
  /**
   * Encrypts and writes one slot with the current key.
   *
   * @throws AppError `TEMPLATE_VERSION_UNREADABLE` when no key resolves, or the write's I/O error
   *   (the `.tmp` file is removed and the previous file is unchanged).
   */
  write(
    templateId: string,
    slot: StateSlot,
    state: TemplateState,
  ): Promise<TemplateStateFileRecord>;
  /**
   * Reads and decrypts one slot.
   *
   * @throws AppError `TEMPLATE_VERSION_UNREADABLE` (no key, another key, a missing file or a file
   *   that fails authentication) with the file's `key_id` when it has one.
   */
  read(templateId: string, slot: StateSlot): Promise<TemplateState>;
  /** Deletes one slot (and a version's `.meta.json`); a missing file is not an error. */
  remove(templateId: string, slot: StateSlot): Promise<void>;
  /** Writes `versions/v<N>.meta.json` (mode 0600): the row's facts beside the file, no value. */
  writeMeta(
    templateId: string,
    version: number,
    meta: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  /** The state files of one template (`latest` and numbered), with the key id of each header. */
  files(templateId: string): Promise<readonly StateFileInfo[]>;
  /** Template ids that have at least one state file. */
  templatesWithFiles(): Promise<readonly string[]>;
  /** Leftover `.tmp` files of interrupted writes are deleted; returns how many. */
  removeTemporaries(templateId: string): Promise<number>;
}
