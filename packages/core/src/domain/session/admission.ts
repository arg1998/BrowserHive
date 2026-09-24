/** @module domain/session/admission — AdmissionPolicy port and the default capacity policy behind SESSION_LIMIT_REACHED (D-21). */

import { AppError } from '../../kernel/errors/app-error.ts';
import { err, ok, type Result } from '../../kernel/result.ts';

/** Facts the policy decides on. */
export interface AdmissionRequest {
  /** Sessions currently occupying capacity (reserved, launching, live, paused, draining). */
  readonly occupied: number;
  readonly slug: string;
  readonly principal: string;
}

/** Why a launch was refused: the cap and the occupancy at decision time. */
export interface AdmissionRefusal {
  readonly limit: number;
  readonly live: number;
}

/**
 * Decides whether one more session may be created. The seam for a resource governor, queueing or
 * eviction later (spec 01 §9); today the only implementation is a fixed cap.
 */
export interface AdmissionPolicy {
  admit(request: AdmissionRequest): Result<void, AdmissionRefusal>;
  /** The cap reported by `server_status.sessions.limit`; `null` when unbounded. */
  capacity(): number | null;
}

/** `maxSessions` as resolved by the config layer. */
export type MaxSessions = number | 'unbounded';

const GIB = 1024 ** 3;
/** RAM budget per session the default cap assumes (D-21). */
export const RAM_GIB_PER_SESSION = 1.5;
/** Upper bound of the derived cap (D-21). */
export const MAX_DERIVED_SESSIONS = 20;

/** D-21: `max(1, min(floor(RAM_GB / 1.5), 20))`. Mirrors the config resolver's derivation. */
export function deriveSessionCap(totalMemoryBytes: number): number {
  const gib = totalMemoryBytes / GIB;
  return Math.max(1, Math.min(Math.floor(gib / RAM_GIB_PER_SESSION), MAX_DERIVED_SESSIONS));
}

/** Fixed-cap policy over a resolved `maxSessions`. */
export class CapAdmissionPolicy implements AdmissionPolicy {
  private readonly limit: number | null;

  constructor(maxSessions: MaxSessions) {
    this.limit = maxSessions === 'unbounded' ? null : Math.max(0, Math.floor(maxSessions));
  }

  capacity(): number | null {
    return this.limit;
  }

  admit(request: AdmissionRequest): Result<void, AdmissionRefusal> {
    if (this.limit === null || request.occupied < this.limit) return ok(undefined);
    return err({ limit: this.limit, live: request.occupied });
  }
}

/**
 * Builds the default policy: an explicit `maxSessions`, or the D-21 derivation from available RAM.
 */
export function defaultAdmissionPolicy(
  source: { readonly maxSessions: MaxSessions } | { readonly totalMemoryBytes: number },
): AdmissionPolicy {
  return new CapAdmissionPolicy(
    'maxSessions' in source ? source.maxSessions : deriveSessionCap(source.totalMemoryBytes),
  );
}

/**
 * Service-side helper: consult the policy and throw the typed, retryable refusal.
 *
 * @throws `SESSION_LIMIT_REACHED` `{ limit, live }` (registry message text; retryable `backoff`).
 */
export function assertAdmitted(policy: AdmissionPolicy, request: AdmissionRequest): void {
  const decision = policy.admit(request);
  if (decision.ok) return;
  throw new AppError('SESSION_LIMIT_REACHED', decision.error, {
    publicMessage: `Concurrent session limit reached (max=${decision.error.limit}). Close a session and retry.`,
  });
}
