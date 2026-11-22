/** @module app/site-packs/client/accept — decides one candidate layout (`keys.json`, `index.json` and their signatures from a fetch, an import or the local folder) against the stored floors and the held layout (spec 13 §10.3 steps 1, 2 and 4): refused, unchanged (the same `index.json` bytes BrowserHive holds, re-verified under the accepted `keys.json`; expired → stale), or a newer index. Pure apart from the verifier. */

import type { RegistryIndexV1, RegistryKeysV1 } from '@browserhive/contracts/site-packs';
import type {
  RegistryRefusalInfo,
  RegistryVerifier,
  VerifiedFile,
} from '../../../ports/site-pack-registry.ts';
import type { RegistryFloorsRecord } from './client-state.ts';

/** The four signed files of a layout. */
export interface LayoutFiles {
  readonly keys: Uint8Array;
  readonly keysSig: Uint8Array;
  readonly index: Uint8Array;
  readonly indexSig: Uint8Array;
}

/** What {@link acceptLayout} decided. */
export type Acceptance =
  /**
   * Refused. `keys` is set when step 1 accepted `keys.json` (a revoking `keys.json` is kept even
   * when the index fails under it, review #100 L1); `pendingIndexFloor` is its unconsumed reset.
   */
  | {
      readonly kind: 'refused';
      readonly refusal: RegistryRefusalInfo;
      readonly keys?: VerifiedFile<RegistryKeysV1>;
      readonly pendingIndexFloor?: number | null;
    }
  /** The held index, unchanged, has expired: it stays in force for what was downloaded, nothing new. */
  | {
      readonly kind: 'stale';
      readonly keys: VerifiedFile<RegistryKeysV1>;
      readonly heldIndex: RegistryIndexV1 | null;
      readonly pendingIndexFloor: number | null;
    }
  | {
      readonly kind: 'not_modified';
      readonly keys: VerifiedFile<RegistryKeysV1>;
      readonly index: VerifiedFile<RegistryIndexV1>;
      /**
       * A newer `keys.json`'s `index_floor` not consumed yet: it is honoured with the next index
       * accepted under it, never by an unchanged one (review #100 M2).
       */
      readonly pendingIndexFloor: number | null;
    }
  | {
      readonly kind: 'updated';
      readonly keys: VerifiedFile<RegistryKeysV1>;
      readonly index: VerifiedFile<RegistryIndexV1>;
      /** `keys.json`'s `index_floor` replaced the stored floor for this check (consumed). */
      readonly indexFloorApplied: number | null;
    };

/** Inputs of {@link acceptLayout}. */
export interface AcceptInput {
  readonly verifier: RegistryVerifier;
  readonly files: LayoutFiles;
  /**
   * The SHA-256 of the held `index.json`, or the one recorded when the held file was lost
   * (review #100 L2); `null` when none.
   */
  readonly heldIndexSha256: string | null;
  readonly sha256: (bytes: Uint8Array) => string;
  readonly floors: RegistryFloorsRecord;
  /** A reset from an earlier, newer `keys.json` not consumed yet. */
  readonly pendingIndexFloor?: number | null;
  /** No index is held (lost or never): an index of exactly the floor's version is accepted again. */
  readonly nothingHeld?: boolean;
  readonly now: number;
}

function parsedIndex(bytes: Uint8Array): RegistryIndexV1 | null {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof raw === 'object' && raw !== null ? (raw as RegistryIndexV1) : null;
  } catch {
    return null;
  }
}

/** Decides one layout; never throws. */
export function acceptLayout(input: AcceptInput): Acceptance {
  const { verifier, files, floors, now } = input;
  const keys = verifier.verifyKeys({
    bytes: files.keys,
    sig: files.keysSig,
    now,
    floor: floors.keysVersion,
  });
  if (!keys.ok) return { kind: 'refused', refusal: keys.error };
  // §10.3 step 1: a newer keys.json's index_floor, else one still pending from an earlier one.
  const reset =
    verifier.indexFloorOf(keys.value.value, floors).applied ?? input.pendingIndexFloor ?? null;
  const floor = reset ?? floors.indexVersion;
  const refused = (refusal: RegistryRefusalInfo): Acceptance => ({
    kind: 'refused',
    refusal,
    keys: keys.value,
    pendingIndexFloor: reset,
  });
  const same =
    input.heldIndexSha256 !== null && input.sha256(files.index) === input.heldIndexSha256;
  if (same) {
    // The index BrowserHive holds: re-checked under the (maybe newer) keys, without the rollback
    // floor (its version is the floor). A 200 with the same bytes is the same as a 304 (D69).
    const held = verifier.verifyIndex({
      bytes: files.index,
      sig: files.indexSig,
      keys: keys.value.value,
      now,
      floor: null,
    });
    if (held.ok) {
      if (floor !== null && held.value.value.version < floor) {
        return refused({
          file: 'index.json',
          reason: 'rollback',
          detail: `the held index (version ${held.value.value.version}) is below the floor (${floor})`,
        });
      }
      return {
        kind: 'not_modified',
        keys: keys.value,
        index: held.value,
        pendingIndexFloor: reset,
      };
    }
    if (held.error.reason === 'expired') {
      return {
        kind: 'stale',
        keys: keys.value,
        heldIndex: parsedIndex(files.index),
        pendingIndexFloor: reset,
      };
    }
    return refused(held.error);
  }
  // With nothing held, the floor's own version is accepted again (a lost held file, review #100 L2).
  const effective =
    floor !== null && input.nothingHeld === true && reset === null ? floor - 1 : floor;
  const index = verifier.verifyIndex({
    bytes: files.index,
    sig: files.indexSig,
    keys: keys.value.value,
    now,
    floor: effective,
  });
  if (!index.ok) return refused(index.error);
  return {
    kind: 'updated',
    keys: keys.value,
    index: index.value,
    indexFloorApplied: reset,
  };
}

/** The floors after an accepted layout: the keys version, and the index version it established. */
export function floorsAfter(
  acceptance: Extract<Acceptance, { kind: 'not_modified' | 'updated' }>,
): { readonly keysVersion: number; readonly indexVersion: number } {
  return {
    keysVersion: acceptance.keys.value.version,
    indexVersion: acceptance.index.value.version,
  };
}
