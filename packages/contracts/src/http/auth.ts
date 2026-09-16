/** @module contracts/http/auth — login, operator sessions, API tokens and grants (spec 03 §3, §4.1) */
import { z } from 'zod';
import { PrincipalKind, Scope } from '../enums/index.ts';
import { Count, DurationMs, EpochMs, OkResponse } from './common.ts';

/** Minimum password length (spec 03 §3.4). */
export const PASSWORD_MIN_LENGTH = 12;
/** Maximum password length (spec 03 §3.4). */
export const PASSWORD_MAX_LENGTH = 256;
/** Bearer token grammar: `bh_<kind>_<base64url 32 bytes>` (spec 03 §3.2). */
export const BEARER_TOKEN_RE = /^bh_[a-z]+_[A-Za-z0-9_-]{43}$/;

const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const newPassword = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** `POST /auth/login` body. */
export const LoginRequest = z.strictObject({ password });
/** `POST /auth/login` body. */
export type LoginRequest = z.infer<typeof LoginRequest>;

/** Public view of an operator session (`auth_sessions` row). */
export const AuthSessionInfo = z.object({
  id_prefix: z.string(),
  created_at: EpochMs,
  last_seen_at: EpochMs,
  expires_at: EpochMs,
});
/** Public view of an operator session. */
export type AuthSessionInfo = z.infer<typeof AuthSessionInfo>;

/** `POST /auth/login` 200 body; the cookie travels in `Set-Cookie`. */
export const LoginResponse = z.object({
  ok: z.literal(true),
  must_change_password: z.boolean(),
  session: z.object({ id_prefix: z.string(), expires_at: EpochMs }),
});
/** `POST /auth/login` 200 body. */
export type LoginResponse = z.infer<typeof LoginResponse>;

/** `POST /auth/logout` body. */
export const LogoutResponse = OkResponse;

/** Wire view of the caller (`RequestPrincipal` minus its auth internals). */
export const AuthPrincipal = z.object({
  subject: z.string(),
  kind: PrincipalKind,
  display: z.string(),
  scopes: z.array(Scope),
  must_change_password: z.boolean(),
});
/** Wire view of the caller. */
export type AuthPrincipal = z.infer<typeof AuthPrincipal>;

/** `GET /auth/me` body; `session` is present for cookie principals only. */
export const MeResponse = z.object({
  principal: AuthPrincipal,
  session: AuthSessionInfo.optional(),
});
/** `GET /auth/me` body. */
export type MeResponse = z.infer<typeof MeResponse>;

/** `POST /auth/change-password` body. */
export const ChangePasswordRequest = z.strictObject({
  current_password: password,
  new_password: newPassword,
});
/** `POST /auth/change-password` body. */
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** `POST /auth/change-password` 200 body. */
export const ChangePasswordResponse = z.object({
  ok: z.literal(true),
  revoked_sessions: Count,
});
/** `POST /auth/change-password` 200 body. */
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponse>;

/** One of the caller's operator sessions (`GET /auth/sessions`). */
export const AuthSessionSummary = z.object({
  id_prefix: z.string(),
  created_at: EpochMs,
  last_seen_at: EpochMs,
  user_agent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
/** One of the caller's operator sessions. */
export type AuthSessionSummary = z.infer<typeof AuthSessionSummary>;

/** `GET /auth/sessions` body. */
export const AuthSessionList = z.object({ data: z.array(AuthSessionSummary) });
/** `GET /auth/sessions` body. */
export type AuthSessionList = z.infer<typeof AuthSessionList>;

/** Path params for `/auth/sessions/{id_prefix}`. */
export const AuthSessionIdPrefixParams = z.strictObject({
  id_prefix: z.string().min(4).max(32),
});
/** Path params for `/auth/sessions/{id_prefix}`. */
export type AuthSessionIdPrefixParams = z.infer<typeof AuthSessionIdPrefixParams>;

/** `POST /auth/sessions/revoke-all` body (the current session is kept). */
export const RevokeAllSessionsResponse = z.object({ ok: z.literal(true), revoked: Count });
/** `POST /auth/sessions/revoke-all` body. */
export type RevokeAllSessionsResponse = z.infer<typeof RevokeAllSessionsResponse>;

/** Who an API token acts as. */
export const TokenOwnerKind = z.enum(['agent', 'operator']);
/** Who an API token acts as. */
export type TokenOwnerKind = z.infer<typeof TokenOwnerKind>;

/** One issued API token (`credentials` row of kind `api_token`); the secret is never listed. */
export const ApiTokenSummary = z.object({
  credential_id: z.string(),
  public_prefix: z.string(),
  owner_kind: TokenOwnerKind,
  subject: z.string(),
  scopes: z.array(Scope),
  created_at: EpochMs,
  last_used_at: EpochMs.nullable(),
  expires_at: EpochMs.nullable(),
});
/** One issued API token. */
export type ApiTokenSummary = z.infer<typeof ApiTokenSummary>;

/** `GET /auth/tokens` body. */
export const ApiTokenList = z.object({ data: z.array(ApiTokenSummary) });
/** `GET /auth/tokens` body. */
export type ApiTokenList = z.infer<typeof ApiTokenList>;

/** `POST /auth/tokens` body. `scopes` defaults to the owner kind's full set. */
export const CreateTokenRequest = z.strictObject({
  owner_kind: TokenOwnerKind,
  display: z.string().trim().min(1).max(80),
  scopes: z.array(Scope).min(1).optional(),
  expires_in_ms: DurationMs.positive().optional(),
});
/** `POST /auth/tokens` body. */
export type CreateTokenRequest = z.infer<typeof CreateTokenRequest>;

/** `POST /auth/tokens` 200 body; `token` is shown exactly once. */
export const CreateTokenResponse = z.object({ credential_id: z.string(), token: z.string() });
/** `POST /auth/tokens` 200 body. */
export type CreateTokenResponse = z.infer<typeof CreateTokenResponse>;

/** Path params for `/auth/tokens/{credential_id}`. */
export const CredentialIdParams = z.strictObject({ credential_id: z.string().min(1).max(128) });
/** Path params for `/auth/tokens/{credential_id}`. */
export type CredentialIdParams = z.infer<typeof CredentialIdParams>;

/** Routes that accept a `?grant=` token instead of a cookie (spec 03 §3.2). */
export const GrantRoute = z.enum(['trace', 'screenshot']);
/** Routes that accept a `?grant=` token. */
export type GrantRoute = z.infer<typeof GrantRoute>;

/** `POST /auth/grants` body: mint a single-use, 10-minute grant for one resource. */
export const CreateGrantRequest = z.strictObject({
  route: GrantRoute,
  resource_id: z.string().min(1).max(256),
});
/** `POST /auth/grants` body. */
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;

/** `POST /auth/grants` 200 body. */
export const CreateGrantResponse = z.object({ grant: z.string(), expires_at: EpochMs });
/** `POST /auth/grants` 200 body. */
export type CreateGrantResponse = z.infer<typeof CreateGrantResponse>;

/** Query accepted by grant-enabled routes (`trace.zip`, screenshot images). */
export const GrantQuery = z.strictObject({ grant: z.string().min(1).max(256).optional() });
/** Query accepted by grant-enabled routes. */
export type GrantQuery = z.infer<typeof GrantQuery>;
