/** @module domain/auth/cookie.test — cookie data, header parsing, scopes and the password policy. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  bearerTokenFromHeader,
  clearSessionCookie,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  serializeCookie,
  sessionCookie,
  sessionTokenFromCookie,
} from './cookie.ts';
import { assertPasswordPolicy, checkPasswordPolicy } from './password-policy.ts';
import { AGENT_SCOPES, isSubsetOf, OPERATOR_SCOPES, parseScopes, scopesForKind } from './scopes.ts';

describe('session cookie', () => {
  it('carries the spec attributes and Secure only over https', () => {
    const plain = sessionCookie('tok', { secure: false });
    expect(plain.name).toBe(SESSION_COOKIE_NAME);
    expect(serializeCookie(plain)).toBe(
      'browserhive_session=tok; Max-Age=28800; Path=/; SameSite=Strict; HttpOnly',
    );
    expect(serializeCookie(sessionCookie('tok', { secure: true }))).toEndWith('; HttpOnly; Secure');
    expect(serializeCookie(clearSessionCookie({ secure: false }))).toBe(
      'browserhive_session=; Max-Age=0; Path=/; SameSite=Strict; HttpOnly',
    );
  });

  it('parses Cookie headers (first occurrence wins) and extracts the session token', () => {
    const map = parseCookieHeader('a=1; browserhive_session=abc; a=2; broken; =x');
    expect(map.get('a')).toBe('1');
    expect(map.get('browserhive_session')).toBe('abc');
    expect(map.size).toBe(2);
    expect(sessionTokenFromCookie('browserhive_session=abc')).toBe('abc');
    expect(sessionTokenFromCookie('browserhive_session=')).toBeUndefined();
    expect(sessionTokenFromCookie(undefined)).toBeUndefined();
  });

  it('extracts bearer tokens case-insensitively and rejects other schemes', () => {
    expect(bearerTokenFromHeader('Bearer abc')).toBe('abc');
    expect(bearerTokenFromHeader('bearer   abc ')).toBe('abc');
    expect(bearerTokenFromHeader('Basic abc')).toBeUndefined();
    expect(bearerTokenFromHeader('Bearer ')).toBeUndefined();
    expect(bearerTokenFromHeader(undefined)).toBeUndefined();
  });
});

describe('scopes', () => {
  it('kinds map to their default sets', () => {
    expect(scopesForKind('operator')).toBe(OPERATOR_SCOPES);
    expect(scopesForKind('agent')).toBe(AGENT_SCOPES);
    expect(scopesForKind('service')).toEqual([]);
    expect(OPERATOR_SCOPES).toHaveLength(17);
  });

  it('parseScopes drops unknown values and keeps registry order', () => {
    expect(parseScopes(['vault:read', 'bogus', 'sessions:read', 'sessions:read'])).toEqual([
      'sessions:read',
      'vault:read',
    ]);
    expect(isSubsetOf(['sessions:read'], OPERATOR_SCOPES)).toBe(true);
    expect(isSubsetOf(['sessions:read'], AGENT_SCOPES)).toBe(false);
  });
});

describe('password policy', () => {
  it('enforces min 12, max 256 and must differ', () => {
    expect(checkPasswordPolicy('short', 'x')).toEqual({ ok: false, error: 'too_short' });
    expect(checkPasswordPolicy('a'.repeat(257), 'x')).toEqual({ ok: false, error: 'too_long' });
    expect(checkPasswordPolicy('same-same-same', 'same-same-same')).toEqual({
      ok: false,
      error: 'same_as_current',
    });
    expect(checkPasswordPolicy('long enough now', 'x').ok).toBe(true);
  });

  it('assertPasswordPolicy throws WEAK_PASSWORD with min_length', () => {
    try {
      assertPasswordPolicy('short', 'x');
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'WEAK_PASSWORD')).toBe(true);
      if (isAppError(error, 'WEAK_PASSWORD')) expect(error.details.min_length).toBe(12);
    }
  });
});
