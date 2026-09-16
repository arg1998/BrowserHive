/** @module kernel/slug — session slug validation, sanitization and session-id parsing (D-23). */

import { AppError } from './errors/app-error.ts';
import { err, ok, type Result } from './result.ts';

/**
 * Slug regex.
 *
 * - Must start with a lowercase letter (not a digit / dash) so the resulting session id never
 *   begins with `-` and is always a syntactically clean filesystem entry name.
 * - 2–32 chars total (1+`{1,31}`).
 * - Lowercase ASCII alphanumerics and dashes only — no underscores, no Unicode.
 *
 * The resulting `<slug>-<nanoid8>` string must be filesystem-safe; the slug regex is the
 * load-bearing half, the id alphabet is the other.
 */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** Human-readable form of {@link SLUG_RE} for `INVALID_SLUG.details.pattern`. */
export const SLUG_PATTERN = '^[a-z][a-z0-9-]{1,31}$';

/** Maximum slug length. */
export const SLUG_MAX_LENGTH = 32;

/** Minimum slug length. */
export const SLUG_MIN_LENGTH = 2;

/**
 * Id alphabet: `0-9a-z`. Lowercase only, no separators, so the id segment is always a single safe
 * filesystem token. Shared by session and tab ids.
 */
export const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Length of the id suffix after the slug. 36^8 = 2.8 trillion possibilities. */
export const ID_SUFFIX_LENGTH = 8;

/** Canonical session id: `<slug>-<suffix8>`. */
export const SESSION_ID_RE = /^([a-z][a-z0-9-]{1,31})-([0-9a-z]{8})$/;

/** Slug used when {@link sanitizeSlug} cannot salvage anything from its input. */
export const FALLBACK_SLUG = 'session';

/** True when `slug` satisfies {@link SLUG_RE}. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Details of an `INVALID_SLUG` failure. */
export interface InvalidSlugDetails {
  readonly slug: string;
  readonly pattern: string;
}

/** Validates a user-supplied slug; returns `Err` with the registry details on any violation. */
export function parseSlug(slug: string): Result<string, InvalidSlugDetails> {
  return SLUG_RE.test(slug) ? ok(slug) : err({ slug, pattern: SLUG_PATTERN });
}

/**
 * Validates a user-supplied slug for service code.
 *
 * @throws `INVALID_SLUG` with `{ slug, pattern }` on any violation.
 */
export function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new AppError(
      'INVALID_SLUG',
      { slug, pattern: SLUG_PATTERN },
      {
        // Stable public text: agents may match on it (spec 10 §1.2).
        publicMessage: `Invalid slug '${slug}'. Slugs must match /^[a-z][a-z0-9-]{1,31}$/ (start with a lowercase letter, 2–32 chars, lowercase alphanumerics and dashes).`,
      },
    );
  }
}

/**
 * Coerces free text (a dashboard form, a profile name) into a valid slug: lowercase, every run of
 * disallowed characters becomes one dash, leading non-letters and trailing dashes are dropped, and
 * the result is capped at {@link SLUG_MAX_LENGTH}. Falls back to {@link FALLBACK_SLUG} when nothing
 * usable remains. The output always satisfies {@link SLUG_RE}.
 */
export function sanitizeSlug(input: string): string {
  let s = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
  if (s.length > SLUG_MAX_LENGTH) {
    s = s.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
  }
  if (s.length < SLUG_MIN_LENGTH) {
    return s.length === 0 ? FALLBACK_SLUG : `${s}0`;
  }
  return s;
}

/** Slug and random suffix of a canonical session id. */
export interface SessionIdComponents {
  readonly slug: string;
  readonly suffix: string;
}

/**
 * Inverse of the id generator's `sessionId(slug)`. Returns `null` when `id` is not in canonical
 * form (the caller treats that as `SESSION_NOT_FOUND` rather than logging it).
 */
export function parseSessionId(id: string): SessionIdComponents | null {
  const match = SESSION_ID_RE.exec(id);
  if (match === null) return null;
  const slug = match[1];
  const suffix = match[2];
  if (slug === undefined || suffix === undefined) return null;
  return { slug, suffix };
}
