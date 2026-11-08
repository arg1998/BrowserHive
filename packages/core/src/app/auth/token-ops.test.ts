/** @module app/auth/token-ops.test — reserved agent subjects (spec 13 T0f): token creation refuses `local`, `browserhive`, `system` and `template:*`, given or derived from the display name; other tokens are unchanged. */

import { describe, expect, it } from 'bun:test';
import { createAuthTestKit, seedOperator } from '../../../test/helpers/fake-auth.ts';
import { isReservedSubject, RESERVED_SUBJECTS } from '../../domain/auth/reserved-subjects.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { secret } from '../../kernel/secret.ts';
import { createAuthService } from './auth-service.ts';
import type { CreateTokenInput } from './token-ops.ts';

const PW = 'correct horse battery';

async function setup() {
  const kit = createAuthTestKit({ mode: 'token' });
  await seedOperator(kit, { password: PW });
  const service = createAuthService(kit.deps);
  const { principal } = await service.login({ password: secret(PW), ip: '1.1.1.1' });
  return { kit, service, principal };
}

/** The refusal's public message and issues; throws when the call did not refuse. */
async function refusal(promise: Promise<unknown>): Promise<{ message: string; issues: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error, 'VALIDATION_FAILED')) {
      return { message: error.publicMessage, issues: error.details.issues };
    }
    throw error;
  }
  throw new Error('expected VALIDATION_FAILED');
}

describe('createToken: reserved subjects', () => {
  const derived: readonly string[] = [
    'Local',
    'BrowserHive',
    'System',
    'local ',
    'LOCAL',
    '-system-',
  ];
  for (const display of derived) {
    it(`refuses an agent token displayed ${JSON.stringify(display)}`, async () => {
      const { kit, service, principal } = await setup();
      const before = kit.repos.tables.credentials.size;
      const r = await refusal(service.createToken(principal, { ownerKind: 'agent', display }));
      expect(r).toEqual({
        message: 'subject is reserved',
        issues: [{ path: 'display', message: 'subject is reserved', code: 'reserved' }],
      });
      // Nothing was written: no principal, no credential, no audit row.
      expect(kit.repos.tables.credentials.size).toBe(before);
      expect(await kit.repos.principals.get('local')).toBeNull();
      expect(kit.repos.tables.authEvents.some((e) => e.type === 'token_issued')).toBe(false);
    });
  }

  const given: readonly string[] = [
    'template:x',
    'Template:Daily-Report',
    'local',
    'browserhive',
    'system',
  ];
  for (const subject of given) {
    it(`refuses the given subject ${JSON.stringify(subject)}`, async () => {
      const { service, principal } = await setup();
      const input: CreateTokenInput = { ownerKind: 'agent', display: 'ci runner', subject };
      expect(await refusal(service.createToken(principal, input))).toEqual({
        message: 'subject is reserved',
        issues: [{ path: 'subject', message: 'subject is reserved', code: 'reserved' }],
      });
    });
  }

  it('still issues ordinary agent tokens, including names that only contain a reserved word', async () => {
    const { service, principal } = await setup();
    for (const display of ['ci-runner', 'Local runner', 'system-2', 'templates']) {
      const issued = await service.createToken(principal, { ownerKind: 'agent', display });
      expect(issued.token.reveal().startsWith('bh_agent_')).toBe(true);
    }
    expect((await service.listTokens()).map((t) => t.subject)).toEqual([
      'ci-runner',
      'local-runner',
      'system-2',
      'templates',
    ]);
  });

  it('leaves operator tokens alone (their subject is the issuing operator)', async () => {
    const { service, principal } = await setup();
    const issued = await service.createToken(principal, {
      ownerKind: 'operator',
      display: 'System',
      scopes: ['sessions:read'],
    });
    expect(issued.principalId).toBe('admin');
  });
});

describe('isReservedSubject', () => {
  it('names exactly the reserved subjects and the template: prefix', () => {
    expect([...RESERVED_SUBJECTS]).toEqual(['local', 'browserhive', 'system']);
    for (const s of [
      'local',
      'Local',
      ' local',
      'ＬＯＣＡＬ',
      'bröwserhive',
      'SYSTEM',
      'template:',
      'template:x',
      ' Template:Y',
    ]) {
      expect(isReservedSubject(s)).toBe(true);
    }
    for (const s of [
      'agent-1',
      'locals',
      'local-1',
      'system2',
      'template-x',
      'templates',
      'my:template:x',
    ]) {
      expect(isReservedSubject(s)).toBe(false);
    }
  });
});
