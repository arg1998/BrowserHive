/** @module ports/auth-state-locator — resolves saved auth snapshots (storage state, full profile, identity seed) for session creation (spec 02 §3.11). */

import type { SessionPrincipal } from '../domain/session/principal.ts';

/** The auth-states store as the creation pipeline sees it. */
export interface AuthStateLocator {
  /**
   * Managed file path for a saved storage-state name.
   *
   * @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'storage' }` when no snapshot exists.
   */
  storageStatePath(name: string, principal: SessionPrincipal): Promise<string>;
  /**
   * Extracts a saved full profile into the managed `userDataDir`.
   *
   * @throws `AUTH_STATE_NOT_FOUND` `{ name, kind: 'profile' }` when no snapshot exists.
   */
  restoreProfile(name: string, userDataDir: string, principal: SessionPrincipal): Promise<void>;
  /** The display seed saved beside a profile, or `null` (missing/unreadable degrades to a fresh identity). */
  loadIdentitySeed(name: string): Promise<string | null>;
}
