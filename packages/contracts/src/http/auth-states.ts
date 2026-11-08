/** @module contracts/http/auth-states — saved logins (auth states) of every principal: the operator's list and delete (spec 03 §4.6.1, spec 02 §6) */
import { z } from 'zod';
import { SavedAuthKind } from '../enums/saved-auth-kind.ts';
import { AUTH_NAME_RE } from '../tools/auth-states.ts';
import { Bytes, EpochMs } from './common.ts';

/** One saved login of any principal (its manifest, plus the source session's slug). */
export const AuthStateRow = z.object({
  name: z.string(),
  kind: SavedAuthKind,
  /** Subject of the principal that saved it (`local` without authentication). */
  owner: z.string(),
  size: Bytes,
  saved_at: EpochMs,
  source_session_id: z.string(),
  /** Slug of the source session while its record exists; `null` once it is deleted. */
  source_session_slug: z.string().nullable(),
});
/** One saved login. */
export type AuthStateRow = z.infer<typeof AuthStateRow>;

/** `GET /auth-states` body: every principal's saved logins, newest first. */
export const AuthStatesResponse = z.object({ data: z.array(AuthStateRow), now: EpochMs });
/** `GET /auth-states` body. */
export type AuthStatesResponse = z.infer<typeof AuthStatesResponse>;

/** Path params of `/auth-states/{owner}/{name}`. */
export const AuthStateParams = z.strictObject({
  owner: z.string().min(1).max(256),
  name: z.string().regex(AUTH_NAME_RE, 'not a saved-login name'),
});
/** Path params of `/auth-states/{owner}/{name}`. */
export type AuthStateParams = z.infer<typeof AuthStateParams>;

/** `DELETE /auth-states/{owner}/{name}` body: what was deleted. */
export const DeleteAuthStateResponse = z.object({ ok: z.literal(true), deleted: AuthStateRow });
/** `DELETE /auth-states/{owner}/{name}` body. */
export type DeleteAuthStateResponse = z.infer<typeof DeleteAuthStateResponse>;
