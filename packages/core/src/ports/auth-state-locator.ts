/** @module ports/auth-state-locator — resolves saved auth snapshots (storage state, full profile, identity seed) for session creation (spec 02 §3.11). */

import type { SessionPrincipal } from '../domain/session/principal.ts';

/** The auth-states store as the creation pipeline sees it. */
export interface AuthStateLocator {
  /**
   * Managed file path for a saved storage-state name.
   *
   * @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'storage' }` when the principal has no storage-state snapshot of that name.
   */
  storageStatePath(name: string, principal: SessionPrincipal): Promise<string>;
  /**
   * Extracts a saved full profile into the managed `userDataDir`.
   *
   * @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'profile' }` when the principal has no full-profile snapshot of that name.
   */
  restoreProfile(name: string, userDataDir: string, principal: SessionPrincipal): Promise<void>;
  /**
   * The template a storage-state snapshot was exported from (`source_template_id`, spec 13 §5.4),
   * or `null`. Optional: a locator without it never warns `TEMPLATE_STATE_COPY`.
   */
  sourceTemplateOf?(name: string, principal: SessionPrincipal): Promise<string | null>;
  /** The display seed saved beside the principal's profile, or `null` (missing/unreadable degrades to a fresh identity). */
  loadIdentitySeed(name: string, principal: SessionPrincipal): Promise<string | null>;
}
