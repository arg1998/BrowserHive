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
  | { readonly kind: 'refused'; readonly refusal: RegistryRefusalInfo }
  /** The held index, unchanged, has expired: it stays in force for what was downloaded, nothing new. */
  | {
      readonly kind: 'stale';
      readonly keys: VerifiedFile<RegistryKeysV1>;
      readonly heldIndex: RegistryIndexV1 | null;
    }
  | {
      readonly kind: 'not_modified';
      readonly keys: VerifiedFile<RegistryKeysV1>;
      readonly index: VerifiedFile<RegistryIndexV1>;
    }
  | {
      readonly kind: 'updated';
      readonly keys: VerifiedFile<RegistryKeysV1>;
      readonly index: VerifiedFile<RegistryIndexV1>;
      /** `keys.json`'s `index_floor` replaced the stored floor for this check. */
      readonly indexFloorApplied: number | null;
    };

/** Inputs of {@link acceptLayout}. */
export interface AcceptInput {
  readonly verifier: RegistryVerifier;
  readonly files: LayoutFiles;
  /** The SHA-256 of the held `index.json`, `null` when none is held. */
  readonly heldIndexSha256: string | null;
  readonly sha256: (bytes: Uint8Array) => string;
  readonly floors: RegistryFloorsRecord;
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
      if (floors.indexVersion !== null && held.value.value.version !== floors.indexVersion) {
        return {
          kind: 'refused',
          refusal: {
            file: 'index.json',
            reason: 'rollback',
            detail: `the held index (version ${held.value.value.version}) is not the one recorded (${floors.indexVersion})`,
          },
        };
      }
      return { kind: 'not_modified', keys: keys.value, index: held.value };
    }
    if (held.error.reason === 'expired') {
      return { kind: 'stale', keys: keys.value, heldIndex: parsedIndex(files.index) };
    }
    return { kind: 'refused', refusal: held.error };
  }
  const floor = verifier.indexFloorOf(keys.value.value, floors);
  const index = verifier.verifyIndex({
    bytes: files.index,
    sig: files.indexSig,
    keys: keys.value.value,
    now,
    floor: floor.floor,
  });
  if (!index.ok) return { kind: 'refused', refusal: index.error };
  return {
    kind: 'updated',
    keys: keys.value,
    index: index.value,
    indexFloorApplied: floor.applied,
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
