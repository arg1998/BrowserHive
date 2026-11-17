/** @module contracts/http/site-packs-vocabulary — the words of the site-pack DTOs (spec 13 §11.1): sources, provenance, hashes, local-file states, classifications, skip reasons and version references. */
import { z } from 'zod';

// ------------------------------------------------------------------------------------------------
// Vocabulary.
// ------------------------------------------------------------------------------------------------

/** Where a pack version came from (spec 13 §9.6 `SitePackSource.id`). */
export const SitePackSourceKind = z.enum(['bundled', 'remote', 'import', 'local']);
/** A pack version's source. */
export type SitePackSourceKind = z.infer<typeof SitePackSourceKind>;

/** The `?source=` filter: `registry` is the remote source. */
export const SitePackSourceFilter = z.enum(['local', 'registry', 'bundled', 'import']);

/**
 * What the operator was shown when approving: the release a bundled version shipped with, the
 * registry key and index (T4b), the imported file's name, or a local file's path.
 */
export const SitePackProvenance = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bundled'), release: z.string() }),
  z.object({ kind: z.literal('remote'), key_id: z.string(), index_version: z.number().int() }),
  z.object({ kind: z.literal('import'), file: z.string() }),
  z.object({ kind: z.literal('local'), path: z.string() }),
]);
/** A provenance. */
export type SitePackProvenance = z.infer<typeof SitePackProvenance>;

/** A lowercase hex SHA-256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** A local file's state (spec 13 §10.5). */
export const SitePackLocalState = z.enum(['approved', 'changed', 'not_approved']);
/** A local file's state. */
export type SitePackLocalState = z.infer<typeof SitePackLocalState>;

/**
 * How a candidate compares with the approved version (spec 13 §9.7). T3a shows every diff as
 * `unclassified`; the classifier and its chips arrive with T3b.
 */
export const SitePackClassification = z.enum([
  'unclassified',
  'tightening',
  'restrictive',
  'loosening',
  'neutral',
  'new_pack',
  'revoked',
  'local_override',
]);
/** A classification. */
export type SitePackClassification = z.infer<typeof SitePackClassification>;

/** Why a pack version was not loaded. */
export const SitePackSkipReason = z.enum([
  'invalid',
  'too_large',
  'unknown_strategy',
  'min_client',
  'domain_overlap',
  'not_found',
  'id_mismatch',
  'signed_layout_unsupported',
  'unreadable',
]);
/** A skip reason. */
export type SitePackSkipReason = z.infer<typeof SitePackSkipReason>;

/** One version a pack id was offered or decided at. */
export const SitePackVersionRef = z.object({
  version: z.number().int().nullable(),
  sha256: Sha256Hex,
  source: SitePackSourceKind,
});
/** A version reference. */
export type SitePackVersionRef = z.infer<typeof SitePackVersionRef>;
