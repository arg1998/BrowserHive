/** @module domain/auth/reserved-subjects — principal subjects no agent token may take (spec 13 T0f, D-52 amendment): `local`, `browserhive`, `system` and every `template:` subject. */

import { sanitizeSlug } from '../../kernel/slug.ts';
import { LOCAL_SUBJECT } from './principal.ts';

/**
 * Subjects BrowserHive itself acts as:
 * - `local` owns every session created under `auth=off` and every saved auth state without an owner;
 * - `browserhive` owns maintenance sessions (spec 13);
 * - `system` is held back for internal actors.
 */
export const RESERVED_SUBJECTS: readonly string[] = Object.freeze([
  LOCAL_SUBJECT,
  'browserhive',
  'system',
]);

/** Prefix of the synthetic principal a template's vault auto-relogin acts as (`template:<id>`). */
export const RESERVED_SUBJECT_PREFIX = 'template:';

const RESERVED = new Set(RESERVED_SUBJECTS);

/** Unicode-folds, lowercases and trims, as the first steps of `sanitizeSlug` do (keeps `:`). */
function fold(subject: string): string {
  return subject
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * True when `subject` names, or would be stored as, a reserved subject. Case and compatibility
 * forms do not matter: `Local`, `local `, `ＬＯＣＡＬ` and `-local-` (which `sanitizeSlug` turns into
 * `local`) are all reserved, as is `Template:x`. Used by token creation, `browserhive doctor` and
 * the boot warning, so the three agree.
 */
export function isReservedSubject(subject: string): boolean {
  const folded = fold(subject);
  if (RESERVED.has(folded) || folded.startsWith(RESERVED_SUBJECT_PREFIX)) return true;
  return RESERVED.has(sanitizeSlug(subject));
}
