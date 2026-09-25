/** @module test/persistence/conformance-identity.test — principals, credentials, auth sessions, grants, auth events, MCP connections. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  AuthSessionRecord,
  CredentialRecord,
  GrantRecord,
  McpConnectionRecord,
  PrincipalRecord,
} from '../../src/ports/persistence/records.ts';
import { openMemory, type TestDb } from './setup.ts';

let t: TestDb;
beforeEach(async () => {
  t = await openMemory();
});
afterEach(async () => {
  await t.close();
});

const principal: PrincipalRecord = {
  principalId: 'local',
  kind: 'operator',
  display: 'Operator',
  tenantId: null,
  mustChangePassword: true,
  createdAt: 1,
  updatedAt: 1,
  disabledAt: null,
};
const credential: CredentialRecord = {
  credentialId: 'c-1',
  principalId: 'local',
  kind: 'api_token',
  publicPrefix: 'bh_abc',
  secretHash: 'h',
  display: 'ci',
  scopes: ['tools:*'],
  createdAt: 1,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};
const authSession: AuthSessionRecord = {
  authSessionId: 'as-1',
  principalId: 'local',
  tokenHash: 'th-1',
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: 100,
  userAgent: 'ua',
  ip: '::1',
  revokedAt: null,
};
const grant: GrantRecord = {
  grantId: 'g-1',
  tokenHash: 'gh-1',
  authSessionId: 'as-1',
  route: 'trace',
  resourceId: 's-1',
  createdAt: 1,
  expiresAt: 50,
  usedAt: null,
};

describe('PrincipalRepository and CredentialRepository', () => {
  it('round-trips principals and credentials', async () => {
    await t.repos.principals.insert(principal);
    await t.repos.principals.insert({ ...principal, display: 'dup' });
    expect(await t.repos.principals.get('local')).toEqual(principal);
    expect(
      await t.repos.principals.update('local', { mustChangePassword: false, updatedAt: 2 }),
    ).toBe(true);
    expect((await t.repos.principals.get('local'))?.mustChangePassword).toBe(false);
    expect((await t.repos.principals.list('operator')).length).toBe(1);
    expect((await t.repos.principals.list('agent')).length).toBe(0);
    await t.repos.credentials.insert(credential);
    expect(await t.repos.credentials.get('c-1')).toEqual(credential);
    expect(await t.repos.credentials.findByPrefix('bh_abc')).toEqual(credential);
    await t.repos.credentials.touch('c-1', 5);
    expect((await t.repos.credentials.listActive('api_token'))[0]?.lastUsedAt).toBe(5);
    expect(await t.repos.credentials.replaceSecret('c-1', 'h2')).toBe(true);
    expect(await t.repos.credentials.revoke('c-1', 9)).toBe(true);
    expect(await t.repos.credentials.revoke('c-1', 10)).toBe(false);
    expect(await t.repos.credentials.findByPrefix('bh_abc')).toBeNull();
    expect((await t.repos.credentials.listByPrincipal('local', 'api_token')).length).toBe(1);
  });

  it('cascades credentials and auth sessions when the principal is removed', async () => {
    await t.repos.principals.insert(principal);
    await t.repos.credentials.insert(credential);
    await t.repos.authSessions.insert(authSession);
    await t.handle.db.deleteFrom('principals').where('principal_id', '=', 'local').execute();
    expect(await t.repos.credentials.get('c-1')).toBeNull();
    expect(await t.repos.authSessions.get('as-1')).toBeNull();
  });
});

describe('AuthSessionRepository and GrantRepository', () => {
  it('finds by token hash, touches, revokes, prunes', async () => {
    await t.repos.principals.insert(principal);
    await t.repos.authSessions.insert(authSession);
    await t.repos.authSessions.insert({
      ...authSession,
      authSessionId: 'as-2',
      tokenHash: 'th-2',
      createdAt: 2,
    });
    expect(await t.repos.authSessions.findByTokenHash('th-1', 10)).toEqual(authSession);
    expect(await t.repos.authSessions.findByTokenHash('th-1', 100)).toBeNull();
    await t.repos.authSessions.touch('as-1', 20, 200);
    expect((await t.repos.authSessions.get('as-1'))?.expiresAt).toBe(200);
    expect((await t.repos.authSessions.listActive('local')).map((s) => s.authSessionId)).toEqual([
      'as-2',
      'as-1',
    ]);
    expect(await t.repos.authSessions.revokeAll('local', 30, 'as-1')).toBe(1);
    expect(await t.repos.authSessions.revoke('as-1', 31)).toBe(true);
    expect(await t.repos.authSessions.revoke('as-1', 32)).toBe(false);
    expect(await t.repos.authSessions.pruneExpired(1_000)).toBe(2);
  });

  it('handles grants and cascades from the auth session', async () => {
    await t.repos.principals.insert(principal);
    await t.repos.authSessions.insert(authSession);
    await t.repos.grants.insert(grant);
    expect(await t.repos.grants.findByTokenHash('gh-1', 10)).toEqual(grant);
    expect(await t.repos.grants.findByTokenHash('gh-1', 60)).toBeNull();
    await t.repos.grants.markUsed('g-1', 5);
    expect((await t.repos.grants.findByTokenHash('gh-1', 10))?.usedAt).toBe(5);
    expect(await t.repos.grants.pruneExpired(10)).toBe(0);
    await t.repos.authSessions.revoke('as-1', 1);
    await t.repos.authSessions.pruneExpired(2);
    expect(await t.repos.grants.findByTokenHash('gh-1', 10)).toBeNull();
  });
});

describe('AuthEventRepository', () => {
  it('appends and lists with cursors', async () => {
    for (let i = 1; i <= 3; i++) {
      expect(
        await t.repos.authEvents.append({
          eventId: `ae-${i}`,
          type: i === 2 ? 'login_failure' : 'login_success',
          principalId: 'local',
          ip: null,
          userAgent: null,
          details: { n: i },
          occurredAt: i,
        }),
      ).toBe(i);
    }
    const page = await t.repos.authEvents.list({ limit: 2 });
    expect(page.items.map((e) => e.seq)).toEqual([3, 2]);
    expect(
      (await t.repos.authEvents.list({ limit: 2, cursor: page.nextCursor })).items.map(
        (e) => e.seq,
      ),
    ).toEqual([1]);
    expect((await t.repos.authEvents.list({ types: ['login_failure'] })).items[0]?.details).toEqual(
      { n: 2 },
    );
  });
});

describe('McpConnectionRepository', () => {
  const connection: McpConnectionRecord = {
    connectionId: 'c-1',
    principalId: null,
    transport: 'http',
    mcpSessionId: null,
    clientName: null,
    clientVersion: null,
    protocolVersion: null,
    capabilities: null,
    agentName: null,
    model: null,
    harness: null,
    clientTitle: null,
    workspace: null,
    modelSource: null,
    harnessSource: null,
    conflicts: [],
    meta: {},
    ip: '127.0.0.1',
    userAgent: null,
    connectedAt: 1,
    lastSeenAt: 1,
    closedAt: null,
  };

  it('inserts, updates metadata, lists open and closes all', async () => {
    await t.repos.mcpConnections.insert(connection);
    expect(
      await t.repos.mcpConnections.update('c-1', {
        clientName: 'claude',
        capabilities: { roots: {} },
        lastSeenAt: 5,
      }),
    ).toBe(true);
    expect(await t.repos.mcpConnections.get('c-1')).toEqual({
      ...connection,
      clientName: 'claude',
      capabilities: { roots: {} },
      lastSeenAt: 5,
    });
    expect((await t.repos.mcpConnections.listOpen()).length).toBe(1);
    expect(await t.repos.mcpConnections.closeAll(9)).toBe(1);
    expect((await t.repos.mcpConnections.listOpen()).length).toBe(0);
  });

  it('round-trips the resolved identity and lists live connections first', async () => {
    const identity = {
      harness: 'claude-code',
      harnessSource: 'injected_env',
      model: 'opus',
      modelSource: 'env',
      workspace: 'shop',
      agentName: 'shop',
      clientTitle: 'Claude Code',
      conflicts: [{ source: 'client_info', value: 'cursor-vscode', harness: 'cursor' }],
      meta: { team: 'growth' },
    };
    await t.repos.mcpConnections.insert({ ...connection, ...identity, closedAt: 3, lastSeenAt: 9 });
    await t.repos.mcpConnections.insert({ ...connection, connectionId: 'c-2', lastSeenAt: 2 });
    expect(await t.repos.mcpConnections.get('c-1')).toEqual({
      ...connection,
      ...identity,
      closedAt: 3,
      lastSeenAt: 9,
    });
    expect(
      await t.repos.mcpConnections.update('c-2', { meta: {}, conflicts: [], ip: '10.0.0.2' }),
    ).toBe(true);
    const recent = await t.repos.mcpConnections.listRecent(10);
    expect(recent.live).toBe(1);
    expect(recent.rows.map((r) => [r.connectionId, r.sessions])).toEqual([
      ['c-2', 0],
      ['c-1', 0],
    ]);
    expect(recent.rows[0]?.ip).toBe('10.0.0.2');
    expect(recent.total).toBe(2);
    expect((await t.repos.mcpConnections.listRecent(1)).rows).toHaveLength(1);
    const second = await t.repos.mcpConnections.listRecent(1, 1);
    expect(second.rows.map((r) => r.connectionId)).toEqual(['c-1']);
    expect([second.live, second.total]).toEqual([1, 2]);
    expect((await t.repos.mcpConnections.listRecent(10, 2)).rows).toEqual([]);
  });
});
