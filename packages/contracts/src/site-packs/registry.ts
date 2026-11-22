/** @module contracts/site-packs/registry — the signed registry layout on browserhive.ai (spec 13 §10.1, §10.2, D-55): `keys.json` (root-signed), `index.json` (signed by an online key), their `.sig` files and the size caps. Structure only: signatures, clocks and floors are checked in core (`infra/site-packs/verify.ts`), which may use `node:crypto`. */
import { z } from 'zod';
import { PackIsoDate, PackRegistrableDomain, PackSemVer } from './schema.ts';

/** The layout's schema major; it is also in the path (`/registry/v1/`). */
export const REGISTRY_SCHEMA = 1;

/** Cap of `index.json` (the endless-data defence, spec 13 §9.10). */
export const REGISTRY_INDEX_MAX_BYTES = 256 * 1024;
/** Cap of `keys.json`. */
export const REGISTRY_KEYS_MAX_BYTES = 16 * 1024;
/** Cap of a `.sig` file. */
export const REGISTRY_SIG_MAX_BYTES = 4 * 1024;
/** At most this many versions per pack are listed (spec 13 §10.1). */
export const REGISTRY_MAX_VERSIONS = 10;
/** At most this many packs are listed. */
export const REGISTRY_MAX_PACKS = 500;
/** At most this many online keys in `keys.json` (one in use, one being rotated in, spares). */
export const REGISTRY_MAX_ONLINE_KEYS = 4;
/** `notes` of one version: plain text, signed with the index. */
export const REGISTRY_NOTES_MAX = 500;

/** A key id: the first 16 hex digits of SHA-256 over the raw 32-byte Ed25519 public key. */
export const RegistryKeyId = z.string().regex(/^[0-9a-f]{16}$/);
/** A raw 32-byte Ed25519 public key, base64 with padding. */
export const RegistryPublicKey = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/);
/** A 64-byte Ed25519 signature, base64 with padding. */
export const RegistrySignature = z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/);
/** A UTC instant to the second: `2026-11-22T10:00:00Z`. */
export const RegistryInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

/** One online key named by `keys.json`. */
export const RegistryOnlineKey = z.strictObject({
  key_id: RegistryKeyId,
  public_key: RegistryPublicKey,
  /** The key signs nothing a client accepts at or after this instant (≤ 90 days after it was added). */
  not_after: RegistryInstant,
});
/** An online key. */
export type RegistryOnlineKey = z.infer<typeof RegistryOnlineKey>;

/** `keys.json`, signed by a pinned root key (`keys.json.sig`). */
export const RegistryKeysV1 = z.strictObject({
  schema: z.literal(REGISTRY_SCHEMA),
  /** Strictly increasing on every root signature; a client never accepts a lower one. */
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** At most 120 days after signing. */
  expires: RegistryInstant,
  /** When present, the client resets its stored index floor to it (after a fast-forward attack). */
  index_floor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  online: z
    .array(RegistryOnlineKey)
    .min(1)
    .max(REGISTRY_MAX_ONLINE_KEYS)
    .refine((keys) => new Set(keys.map((k) => k.key_id)).size === keys.length, {
      message: 'online key ids must be unique',
    }),
});
/** `keys.json`. */
export type RegistryKeysV1 = z.infer<typeof RegistryKeysV1>;

/** A `.sig` file: one or more Ed25519 signatures over the exact bytes of the file it names. */
export const RegistrySignatures = z.strictObject({
  schema: z.literal(REGISTRY_SCHEMA),
  signatures: z
    .array(z.strictObject({ key_id: RegistryKeyId, sig: RegistrySignature }))
    .min(1)
    .max(4),
});
/** A `.sig` file. */
export type RegistrySignatures = z.infer<typeof RegistrySignatures>;

/** One listed version of a pack. */
export const RegistryPackVersion = z.strictObject({
  v: z.number().int().min(1).max(1_000_000),
  min_client: PackSemVer,
  max_client: PackSemVer.optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024),
  /** Relative to `registry/v1/`; always `packs/<id>/<sha256>.json`. */
  path: z.string().max(400),
  released: PackIsoDate,
  notes: z.string().max(REGISTRY_NOTES_MAX),
  revoked: z.boolean().optional(),
});
/** A listed version. */
export type RegistryPackVersion = z.infer<typeof RegistryPackVersion>;

/** One pack of the index. */
export const RegistryIndexPack = z
  .strictObject({
    id: PackRegistrableDomain,
    title: z.string().min(1).max(60),
    versions: z.array(RegistryPackVersion).min(1).max(REGISTRY_MAX_VERSIONS),
  })
  .superRefine((pack, ctx) => {
    pack.versions.forEach((entry, i) => {
      if (entry.path !== `packs/${pack.id}/${entry.sha256}.json`) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i, 'path'],
          message: `must be packs/${pack.id}/<sha256>.json`,
        });
      }
      const next = pack.versions[i + 1];
      if (next !== undefined && next.v >= entry.v) {
        ctx.addIssue({
          code: 'custom',
          path: ['versions', i + 1, 'v'],
          message: 'versions are listed newest first, each once',
        });
      }
    });
  });
/** A pack of the index. */
export type RegistryIndexPack = z.infer<typeof RegistryIndexPack>;

/** `index.json`, signed by an online key of the accepted `keys.json` (`index.json.sig`). */
export const RegistryIndexV1 = z.strictObject({
  schema: z.literal(REGISTRY_SCHEMA),
  /** Strictly increasing on every signature (also the weekly re-sign). */
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  issued_at: RegistryInstant,
  /** At most 14 days after `issued_at`. */
  expires: RegistryInstant,
  packs: z
    .array(RegistryIndexPack)
    .max(REGISTRY_MAX_PACKS)
    .refine((packs) => new Set(packs.map((p) => p.id)).size === packs.length, {
      message: 'pack ids must be unique',
    }),
});
/** `index.json`. */
export type RegistryIndexV1 = z.infer<typeof RegistryIndexV1>;
