/** @module domain/auth/authorizer.test — the v1 policy table. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { allowedDuringPasswordChange, assertCan, can } from './authorizer.ts';
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
const operatorToken: RequestPrincipal = {
  ...operator,
  auth: { method: 'bearer', credentialId: 'c1' },
  scopes: ['sessions:read'],
};
const agent = agentPrincipal('agent-1', {});

describe('Authorizer.can', () => {
  it('operators can do everything, including other owners resources', () => {
    for (const scope of ALL_SCOPES) expect(can(operator, scope)).toBe(true);
    expect(can(operator, 'sessions:write', { kind: 'session', id: 'x', owner: 'agent-1' })).toBe(
      true,
    );
    // operator kind wins even when a token narrowed the scope list
    expect(can(operatorToken, 'vault:write')).toBe(true);
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
