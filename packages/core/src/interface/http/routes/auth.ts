/** @module interface/http/routes/auth — login, logout, me, password change, operator sessions, API tokens and grants (spec 03 §4.1). */

import {
  ApiTokenList,
  AuthSessionIdPrefixParams,
  AuthSessionList,
  ChangePasswordRequest,
  ChangePasswordResponse,
  CreateGrantRequest,
  CreateGrantResponse,
  CreateTokenRequest,
  CreateTokenResponse,
  CredentialIdParams,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  OkResponse,
  RevokeAllSessionsResponse,
} from '@browserhive/contracts/http';
import { serializeCookie } from '../../../domain/auth/cookie.ts';
import { secret } from '../../../kernel/secret.ts';
import { defineRoute, reply } from '../define-route.ts';
import { LOGIN_BODY_LIMIT_BYTES } from '../middleware/body-limit.ts';
import { authSessionToWire, meToWire, tokenToWire } from '../serializers/auth.ts';
import { requirePrincipal } from './common.ts';

const tags = ['auth'];

/** Every auth route. */
export const AUTH_ROUTES = [
  defineRoute({
    operationId: 'login',
    tags,
    summary: 'Log in with the operator password; sets the session cookie.',
    request: { body: LoginRequest },
    responses: { 200: LoginResponse },
    errors: ['INVALID_CREDENTIALS'],
    bodyLimitBytes: LOGIN_BODY_LIMIT_BYTES,
    rateLimit: 'service',
    loginSemaphore: true,
    async handler({ input, services, ctx }) {
      const result = await services.auth.login({
        password: secret(input.body.password),
        ip: ctx.ip,
        secure: ctx.secure,
        ...(ctx.userAgent !== undefined && { userAgent: ctx.userAgent }),
      });
      const cookie = serializeCookie({ ...result.cookie, value: result.token.reveal() });
      return reply(
        200,
        {
          ok: true,
          must_change_password: result.mustChangePassword,
          session: { id_prefix: result.session.idPrefix, expires_at: result.session.expiresAt },
        },
        { 'set-cookie': cookie },
      );
    },
  }),
  defineRoute({
    operationId: 'logout',
    tags,
    summary: 'Destroy the current session and clear the cookie.',
    request: {},
    responses: { 200: LogoutResponse },
    async handler({ principal, services, ctx }) {
      const cookie = await services.auth.logout(requirePrincipal(principal), {
        secure: ctx.secure,
      });
      return reply(200, { ok: true }, { 'set-cookie': serializeCookie(cookie) });
    },
  }),
  defineRoute({
    operationId: 'getMe',
    tags,
    summary: 'The authenticated principal.',
    request: {},
    responses: { 200: MeResponse },
    async handler({ principal, services }) {
      return reply(200, meToWire(await services.auth.me(requirePrincipal(principal))));
    },
  }),
  defineRoute({
    operationId: 'changePassword',
    tags,
    summary: 'Change the operator password; revokes every other session.',
    request: { body: ChangePasswordRequest },
    responses: { 200: ChangePasswordResponse },
    errors: ['BAD_CURRENT_PASSWORD', 'WEAK_PASSWORD'],
    bodyLimitBytes: LOGIN_BODY_LIMIT_BYTES,
    loginSemaphore: true,
    async handler({ input, principal, services }) {
      const result = await services.auth.changePassword(
        requirePrincipal(principal),
        secret(input.body.current_password),
        secret(input.body.new_password),
      );
      return reply(200, { ok: true, revoked_sessions: result.revokedSessions });
    },
  }),
  defineRoute({
    operationId: 'listAuthSessions',
    tags,
    summary: "The caller's operator sessions.",
    request: {},
    responses: { 200: AuthSessionList },
    async handler({ principal, services }) {
      const sessions = await services.auth.listSessions(requirePrincipal(principal));
      return reply(200, { data: sessions.map(authSessionToWire) });
    },
  }),
  defineRoute({
    operationId: 'revokeAuthSession',
    tags,
    summary: 'Revoke one operator session by id prefix.',
    request: { params: AuthSessionIdPrefixParams },
    responses: { 200: OkResponse },
    errors: ['NOT_FOUND'],
    async handler({ input, principal, services }) {
      await services.auth.revokeSession(requirePrincipal(principal), input.params.id_prefix);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'revokeAllAuthSessions',
    tags,
    summary: 'Revoke every session of the caller except the current one.',
    request: {},
    responses: { 200: RevokeAllSessionsResponse },
    async handler({ principal, services }) {
      const revoked = await services.auth.revokeAllSessions(requirePrincipal(principal));
      return reply(200, { ok: true, revoked });
    },
  }),
  defineRoute({
    operationId: 'listTokens',
    tags,
    summary: 'Issued API tokens (never the secret).',
    request: {},
    responses: { 200: ApiTokenList },
    async handler({ services }) {
      const tokens = await services.auth.listTokens();
      return reply(200, { data: tokens.map(tokenToWire) });
    },
  }),
  defineRoute({
    operationId: 'createToken',
    tags,
    summary: 'Issue an API token; the token is shown once.',
    request: { body: CreateTokenRequest },
    responses: { 200: CreateTokenResponse },
    async handler({ input, principal, services }) {
      const body = input.body;
      const result = await services.auth.createToken(requirePrincipal(principal), {
        ownerKind: body.owner_kind,
        display: body.display,
        ...(body.scopes !== undefined && { scopes: body.scopes }),
        ...(body.expires_in_ms !== undefined && { expiresInMs: body.expires_in_ms }),
      });
      return reply(200, { credential_id: result.credentialId, token: result.token.reveal() });
    },
  }),
  defineRoute({
    operationId: 'revokeToken',
    tags,
    summary: 'Revoke an API token.',
    request: { params: CredentialIdParams },
    responses: { 200: OkResponse },
    errors: ['NOT_FOUND'],
    async handler({ input, principal, services }) {
      await services.auth.revokeToken(requirePrincipal(principal), input.params.credential_id);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'createGrant',
    tags,
    summary:
      'Mint a single-use, 10-minute grant: `trace` → resource_id is the session id, `screenshot` → the event id.',
    request: { body: CreateGrantRequest },
    responses: { 200: CreateGrantResponse },
    async handler({ input, principal, services }) {
      const result = await services.auth.createGrant(requirePrincipal(principal), {
        route: input.body.route,
        resourceId: input.body.resource_id,
      });
      return reply(200, { grant: result.grant.reveal(), expires_at: result.expiresAt });
    },
  }),
];
