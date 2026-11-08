/** @module domain/auth/authorizer.test — the v1 policy table. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  allowedDuringPasswordChange,
  assertCan,
  can,
  hasFullOperatorAccess,
} from './authorizer.ts';
import { agentPrincipal, LOCAL_PRINCIPAL, type RequestPrincipal } from './principal.ts';
import { ALL_SCOPES, OPERATOR_SCOPES } from './scopes.ts';

const operator: RequestPrincipal = {
  subject: 'admin',
  kind: 'operator',
  display: 'admin',
  auth: { method: 'password-session', sessionId: 's1' },
  scopes: OPERATOR_SCOPES,
  tenantId: null,
  mustChangePassword: false,
};
/** An operator API token issued with a subset (`POST /auth/tokens {owner_kind:'operator', scopes}`). */
const operatorToken: RequestPrincipal = {
  ...operator,
  auth: { method: 'bearer', credentialId: 'c1' },
  scopes: ['system:read'],
};
/** An operator API token issued without `scopes`: it holds the full set. */
const fullOperatorToken: RequestPrincipal = {
  ...operator,
  auth: { method: 'bearer', credentialId: 'c2' },
  scopes: OPERATOR_SCOPES,
};
const agent = agentPrincipal('agent-1', {});
const foreign = { kind: 'session', id: 'x', owner: 'agent-1' } as const;

describe('Authorizer.can', () => {
  it('a dashboard-session operator holds every scope, and ownership never restricts it', () => {
    for (const scope of ALL_SCOPES) expect(can(operator, scope)).toBe(true);
    expect(can(operator, 'sessions:write', foreign)).toBe(true);
    expect(can(operator, null, foreign)).toBe(true);
    // The session decides, not the scope list the principal happens to carry.
    expect(can({ ...operator, scopes: [] }, 'vault:write')).toBe(true);
    const grant: RequestPrincipal = {
      ...operator,
      auth: { method: 'grant', sessionId: 's1' },
      scopes: [],
    };
    expect(can(grant, 'sessions:read')).toBe(true);
  });

  it('an operator API token is limited to the scopes its credential carries', () => {
    expect(can(operatorToken, 'system:read')).toBe(true);
    expect(can(operatorToken, 'sessions:write')).toBe(false);
    for (const scope of ALL_SCOPES.filter((s) => s !== 'system:read')) {
      expect(can(operatorToken, scope)).toBe(false);
    }
  });

  it('ownership never restricts an operator token, only its scopes do', () => {
    expect(can(operatorToken, 'system:read', foreign)).toBe(true);
    expect(can(operatorToken, null, foreign)).toBe(true);
    expect(can(operatorToken, 'sessions:read', foreign)).toBe(false);
  });

  it('an operator token issued without scopes (the full set) is unchanged', () => {
    for (const scope of ALL_SCOPES) expect(can(fullOperatorToken, scope)).toBe(true);
    expect(can(fullOperatorToken, 'sessions:write', foreign)).toBe(true);
  });

  it('agents hold mcp:tools only', () => {
    expect(can(agent, 'mcp:tools')).toBe(true);
    expect(can(LOCAL_PRINCIPAL, 'mcp:tools')).toBe(true);
    for (const scope of ALL_SCOPES.filter((s) => s !== 'mcp:tools')) {
      expect(can(agent, scope)).toBe(false);
    }
  });

  it('non-operators must own a resource that names an owner', () => {
    expect(can(agent, 'mcp:tools', { kind: 'session', id: 'x', owner: 'agent-1' })).toBe(true);
    expect(can(agent, 'mcp:tools', { kind: 'session', id: 'x', owner: 'agent-2' })).toBe(false);
    expect(can(agent, null, { kind: 'session', id: 'x', owner: 'agent-2' })).toBe(false);
  });

  it('null scope means any authenticated principal; null principal never passes', () => {
    expect(can(agent, null)).toBe(true);
    expect(can(null, null)).toBe(false);
    expect(can(null, 'sessions:read')).toBe(false);
  });
});

describe('hasFullOperatorAccess', () => {
  it('is true for a session operator and a full-scope operator token only', () => {
    expect(hasFullOperatorAccess(operator)).toBe(true);
    expect(hasFullOperatorAccess(fullOperatorToken)).toBe(true);
    expect(hasFullOperatorAccess(operatorToken)).toBe(false);
    expect(hasFullOperatorAccess({ ...fullOperatorToken, scopes: OPERATOR_SCOPES.slice(1) })).toBe(
      false,
    );
    expect(hasFullOperatorAccess(agent)).toBe(false);
    expect(hasFullOperatorAccess({ ...agent, scopes: ALL_SCOPES })).toBe(false);
    expect(hasFullOperatorAccess(LOCAL_PRINCIPAL)).toBe(false);
  });
});

describe('Authorizer.assertCan', () => {
  it('throws UNAUTHORIZED without a principal and FORBIDDEN {scope} otherwise', () => {
    try {
      assertCan(null, 'sessions:read');
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'UNAUTHORIZED')).toBe(true);
    }
    try {
      assertCan(agent, 'sessions:read');
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'FORBIDDEN')).toBe(true);
      if (isAppError(error, 'FORBIDDEN')) expect(error.details.scope).toBe('sessions:read');
    }
    expect(() => assertCan(operator, 'sessions:read')).not.toThrow();
    try {
      assertCan(operatorToken, 'sessions:write');
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'FORBIDDEN')).toBe(true);
      if (isAppError(error, 'FORBIDDEN')) expect(error.details.scope).toBe('sessions:write');
    }
  });
});

describe('allowedDuringPasswordChange', () => {
  it('gates every operation except me/change-password/logout while must_change_password', () => {
    const seeded = { ...operator, mustChangePassword: true };
    expect(allowedDuringPasswordChange(seeded, 'getMe')).toBe(true);
    expect(allowedDuringPasswordChange(seeded, 'changePassword')).toBe(true);
    expect(allowedDuringPasswordChange(seeded, 'logout')).toBe(true);
    expect(allowedDuringPasswordChange(seeded, 'listSessions')).toBe(false);
    expect(allowedDuringPasswordChange(seeded, 'wsUpgrade')).toBe(false);
    expect(allowedDuringPasswordChange(operator, 'listSessions')).toBe(true);
  });
});
