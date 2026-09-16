/** @module infra/persistence/mappers/mappers.test — row ↔ record round-trips and corrupt-row rejection. */

import { describe, expect, it } from 'bun:test';
import {
  sessionRecord,
  toolCallRecord,
  vaultAccessRecord,
} from '../../../../test/persistence/helpers.ts';
import { isAppError } from '../../../kernel/errors/app-error.ts';
import {
  boolToInt,
  intToBool,
  parseEnum,
  parseJsonObject,
  parseStringArray,
  toJson,
} from './codec.ts';
import { toolCallFromRow, toolCallToRow, vaultAccessFromRow, vaultAccessToRow } from './facts.ts';
import {
  credentialFromRow,
  credentialToRow,
  principalFromRow,
  principalToRow,
} from './identity.ts';
import {
  mcpConnectionFromRow,
  mcpConnectionToRow,
  notificationFromRow,
  notificationToRow,
} from './operations.ts';
import { operatorRequestFromRow, operatorRequestToRow } from './operator-request.ts';
import { sessionFromRow, sessionPatchToRow, sessionToRow } from './session.ts';
import {
  vaultBindingFromRow,
  vaultBindingToRow,
  vaultGroupPolicyFromRow,
  vaultGroupPolicyToRow,
} from './vault-policy.ts';

describe('codec', () => {
  it('converts booleans and JSON', () => {
    expect(boolToInt(true)).toBe(1);
    expect(intToBool(0)).toBe(false);
    expect(parseJsonObject('{"a":1}', 'x')).toEqual({ a: 1 });
    expect(parseStringArray('["a"]', 'x')).toEqual(['a']);
    expect(toJson({ b: undefined, a: 1 })).toBe('{"a":1}');
    expect(parseEnum(['a', 'b'] as const, 'b', 'x')).toBe('b');
  });

  it('rejects corrupt values with INTERNAL_ERROR', () => {
    for (const fn of [
      () => parseJsonObject('[1]', 'x'),
      () => parseJsonObject('{', 'x'),
      () => parseStringArray('[1]', 'x'),
      () => parseEnum(['a'] as const, 'z', 'x'),
    ]) {
      let error: unknown;
      try {
        fn();
      } catch (e) {
        error = e;
      }
      expect(isAppError(error, 'INTERNAL_ERROR')).toBe(true);
    }
  });
});

describe('round-trips', () => {
  it('session', () => {
    const record = sessionRecord({
      identity: { ua: 'x' },
      closedAt: 5,
      closedReason: 'crash',
      state: 'crashed',
      tenantId: 't',
    });
    expect(sessionFromRow(sessionToRow(record))).toEqual(record);
    expect(sessionPatchToRow({ lastUrl: null, leasePausedAt: 3 })).toEqual({
      last_url: null,
      lease_paused_at: 3,
    });
    expect(sessionPatchToRow({})).toEqual({});
  });

  it('tool call and vault access', () => {
    const call = toolCallRecord({ ok: false, errorCode: 'X', args: { nested: { a: [1] } } });
    expect(toolCallFromRow(toolCallToRow(call))).toEqual(call);
    const access = vaultAccessRecord({ details: { selectors: ['#u'] }, evaluateEnabled: true });
    expect(vaultAccessFromRow(vaultAccessToRow(access))).toEqual(access);
  });

  it('operator request inserts as pending', () => {
    const row = operatorRequestToRow({
      requestId: 'a-1',
      kind: 'vault_confirm',
      sessionId: 's',
      owner: 'o',
      reason: 'r',
      mode: null,
      entryName: 'e',
      tool: 'vault_fill',
      toolEventId: 'e-1',
      pageUrl: 'https://x/',
      options: null,
      idempotencyKey: null,
      createdAt: 1,
      deadlineAt: 2,
    });
    expect(operatorRequestFromRow(row)).toMatchObject({
      status: 'pending',
      resolvedAt: null,
      entryName: 'e',
    });
  });

  it('identity records', () => {
    const principal = {
      principalId: 'p',
      kind: 'agent' as const,
      display: 'A',
      tenantId: null,
      mustChangePassword: false,
      createdAt: 1,
      updatedAt: 2,
      disabledAt: 3,
    };
    expect(principalFromRow(principalToRow(principal))).toEqual(principal);
    const credential = {
      credentialId: 'c',
      principalId: 'p',
      kind: 'api_token' as const,
      publicPrefix: 'bh_x',
      secretHash: 'h',
      display: null,
      scopes: ['a', 'b'],
      createdAt: 1,
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    expect(credentialFromRow(credentialToRow(credential))).toEqual(credential);
  });

  it('vault policy records', () => {
    const binding = {
      handle: 'h',
      tenantId: null,
      title: 't',
      itemName: 'i',
      itemId: '',
      groupId: null,
      allowedOrigins: ['https://a'],
      authorizedPrincipals: [],
      authorizedSessionSlugs: ['*'],
      allowAllSessions: true,
      redactUsername: false,
      requireNoEvaluate: true,
      dashboardConfirm: true,
      version: 4,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(vaultBindingFromRow(vaultBindingToRow(binding))).toEqual(binding);
    const policy = {
      groupKey: '__ungrouped__',
      groupId: null,
      tenantId: null,
      accessMode: 'reject_all' as const,
      allowAllSessions: false,
      sessionSlugGlobs: [],
      authorizedPrincipals: ['x'],
      dashboardConfirm: false,
      requireNoEvaluate: false,
      redactUsername: true,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(vaultGroupPolicyFromRow(vaultGroupPolicyToRow(policy))).toEqual(policy);
  });

  it('notification and mcp connection', () => {
    const notification = {
      notificationId: 'n',
      principalId: null,
      type: 'vault' as const,
      title: 't',
      body: 'b',
      sessionId: null,
      target: null,
      sourceEventId: 'e',
      createdAt: 1,
      updatedAt: 4,
      count: 3,
      groupKey: 'tool-errors:s',
      readAt: null,
      dismissedAt: 2,
    };
    expect(notificationFromRow(notificationToRow(notification))).toEqual(notification);
    const connection = {
      connectionId: 'c',
      principalId: 'p',
      transport: 'stdio' as const,
      mcpSessionId: null,
      clientName: 'x',
      clientVersion: '1',
      protocolVersion: null,
      capabilities: { a: true },
      agentName: null,
      model: 'm',
      harness: null,
      ip: null,
      userAgent: null,
      connectedAt: 1,
      lastSeenAt: 2,
      closedAt: null,
    };
    expect(mcpConnectionFromRow(mcpConnectionToRow(connection))).toEqual(connection);
  });
});
