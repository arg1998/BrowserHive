/** @module domain/session/principal — the caller identity a session is owned by (spec 03 §3.1). */

/**
 * The slice of `RequestPrincipal` the session subsystem needs. Structural on purpose: the auth
 * layer's full principal satisfies it, and tests can pass `{ subject: 'alice' }`.
 */
export interface SessionPrincipal {
  /** Stable principal id (`principals.principal_id`); `'local'` under `auth=off`. */
  readonly subject: string;
  /** Always `null` in v1 (spec 03 §3.1). */
  readonly tenantId?: string | null;
}

/** The single shared principal used when no authentication is configured (`local`). */
export const LOCAL_SUBJECT = 'local';

/** The shared `local` caller. Reused so identity comparisons are cheap and allocation-free. */
export const LOCAL_PRINCIPAL: SessionPrincipal = Object.freeze({
  subject: LOCAL_SUBJECT,
  tenantId: null,
});

/** True when `principal` owns a session whose `owner` column is `owner`. */
export function ownsSession(principal: SessionPrincipal, owner: string): boolean {
  return principal.subject === owner;
}
