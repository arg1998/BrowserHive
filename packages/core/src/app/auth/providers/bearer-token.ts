/** @module app/auth/providers/bearer-token — `Authorization: Bearer` → stored `api_token` credential or an `authTokens` config token (spec 02 §1.3, 03 §3.2). */

import { bearerTokenFromHeader } from '../../../domain/auth/cookie.ts';
import { constantTimeEqual, matchesHash, sha256Hex } from '../../../domain/auth/digest.ts';
import {
  agentPrincipal,
  principalFromRecord,
  type RequestPrincipal,
} from '../../../domain/auth/principal.ts';
import { parseScopes } from '../../../domain/auth/scopes.ts';
import { parseToken } from '../../../domain/auth/token-format.ts';
import type { AuthDeps } from '../types.ts';
import { type AuthenticationProvider, unauthorized } from './provider.ts';

/** A config-supplied token, hashed at boot; the plaintext is dropped. */
export interface ConfigToken {
  readonly principalId: string;
  readonly hash: string;
}

/**
 * Parses `authTokens` items (`name:token`) into hashed entries. Items the config schema would
 * reject (no colon, empty parts) are skipped; the schema already guards the length.
 */
export function parseConfigTokens(items: readonly string[]): readonly ConfigToken[] {
  const out: ConfigToken[] = [];
  for (const item of items) {
    const idx = item.indexOf(':');
    if (idx <= 0 || idx === item.length - 1) continue;
    const principalId = item.slice(0, idx).trim();
    const token = item.slice(idx + 1).trim();
    if (principalId.length === 0 || token.length === 0) continue;
    out.push({ principalId, hash: sha256Hex(token) });
  }
  return out;
}

/** Constant-time scan of the config tokens: every entry is compared, the last match wins. */
export function lookupConfigToken(
  tokens: readonly ConfigToken[],
  literal: string,
): ConfigToken | undefined {
  const hash = sha256Hex(literal);
  let match: ConfigToken | undefined;
  for (const entry of tokens) {
    if (constantTimeEqual(entry.hash, hash)) match = entry;
  }
  return match;
}

/** Builds the bearer provider (stored tokens + `authTokens` config list). */
export function createBearerTokenProvider(
  deps: Pick<AuthDeps, 'repos' | 'config'>,
): AuthenticationProvider {
  const name = 'bearer-token';
  const configTokens = parseConfigTokens(deps.config.authTokens);
  return {
    name,
    async authenticate(view, ctx): Promise<RequestPrincipal | null> {
      if (view.headers.authorization === undefined) return null;
      const literal = bearerTokenFromHeader(view.headers.authorization);
      if (literal === undefined) throw unauthorized(name, 'authorization scheme is not bearer');
      const fromConfig = lookupConfigToken(configTokens, literal);
      if (fromConfig !== undefined) return agentPrincipal(fromConfig.principalId, {});

      const parsed = parseToken(literal);
      if (parsed === null || parsed.kind === 'grant') throw unauthorized(name, 'malformed token');
      const credential = await deps.repos.credentials.findByPrefix(parsed.publicPrefix);
      if (credential === null || credential.kind !== 'api_token') {
        throw unauthorized(name, 'unknown token');
      }
      if (!matchesHash(literal, credential.secretHash)) throw unauthorized(name, 'unknown token');
      if (credential.expiresAt !== null && credential.expiresAt <= ctx.now) {
        throw unauthorized(name, 'token expired');
      }
      const principal = await deps.repos.principals.get(credential.principalId);
      if (principal === null || principal.disabledAt !== null) {
        throw unauthorized(name, 'principal missing or disabled');
      }
      await deps.repos.credentials.touch(credential.credentialId, ctx.now);
      return principalFromRecord(principal, {
        auth: {
          method: 'bearer',
          credentialId: credential.credentialId,
          ...(credential.expiresAt !== null && { expiresAt: credential.expiresAt }),
        },
        scopes: parseScopes(credential.scopes),
      });
    },
  };
}
