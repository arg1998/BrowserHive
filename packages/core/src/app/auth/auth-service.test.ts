/** @module app/auth/auth-service.test — login limits, password change, seed flow, tokens, sessions, sweep, audit rows. */

import { describe, expect, it } from 'bun:test';
import { createAuthTestKit, seedOperator } from '../../../test/helpers/fake-auth.ts';
import { SEED_ALPHABET } from '../../domain/auth/token-format.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { secret } from '../../kernel/secret.ts';
import { createAuthService } from './auth-service.ts';

const PW = 'correct horse battery';

async function failWith<C extends string>(
  promise: Promise<unknown>,
  code: C,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error) && error.code === code) return error.details as Record<string, unknown>;
    throw error;
  }
  throw new Error(`expected ${code}`);
}

describe('login', () => {
  it('returns a session token, cookie data and must_change_password; writes login_success', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW, mustChangePassword: true });
    const service = createAuthService(kit.deps);
    const result = await service.login({
      password: secret(PW),
      ip: '10.0.0.1',
      userAgent: 'ua',
      secure: true,
    });
    expect(result.mustChangePassword).toBe(true);
    expect(result.principal.mustChangePassword).toBe(true);
    expect(result.cookie).toEqual({
      name: 'browserhive_session',
      attributes: { httpOnly: true, sameSite: 'Strict', path: '/', secure: true, maxAge: 28800 },
    });
    expect(result.session.expiresAt).toBe(kit.clock.now() + 8 * 60 * 60_000);
    expect(result.session.idPrefix).toBe(result.session.authSessionId.slice(0, 8));
    expect(kit.registered).toContain(result.token.reveal());
    const stored = kit.repos.tables.authSessions.get(result.session.authSessionId);
    expect(stored).toMatchObject({ principalId: 'admin', ip: '10.0.0.1', userAgent: 'ua' });
    expect(stored?.tokenHash).not.toBe(result.token.reveal());
    expect(kit.repos.tables.authEvents.map((e) => e.type)).toEqual(['login_success']);
    expect(JSON.stringify(result)).not.toContain(result.token.reveal());
  });

  it('wrong password → INVALID_CREDENTIALS + login_failure row; rehashes weak hashes on success', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW });
    await kit.repos.credentials.replaceSecret('cred-admin', `weak$${PW}`);
    const service = createAuthService(kit.deps);
    await failWith(
      service.login({ password: secret('nope'), ip: '1.1.1.1' }),
      'INVALID_CREDENTIALS',
    );
    expect(kit.repos.tables.authEvents.at(-1)).toMatchObject({
      type: 'login_failure',
      principalId: 'admin',
      ip: '1.1.1.1',
    });
    await service.login({ password: secret(PW), ip: '1.1.1.1' });
    expect(kit.repos.tables.credentials.get('cred-admin')?.secretHash).toBe(`fake$${PW}`);
  });

  it('rate limit: 6th attempt within a minute locks for 5 min with retry_after_ms; lockout audited once', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW });
    const service = createAuthService(kit.deps);
    for (let i = 0; i < 5; i += 1) {
      await failWith(
        service.login({ password: secret('bad'), ip: '9.9.9.9' }),
        'INVALID_CREDENTIALS',
      );
    }
    const details = await failWith(
      service.login({ password: secret(PW), ip: '9.9.9.9' }),
      'RATE_LIMITED',
    );
    expect(details['retry_after_ms']).toBe(300_000);
    await kit.clock.set(kit.clock.now() + 60_000);
    const again = await failWith(
      service.login({ password: secret(PW), ip: '9.9.9.9' }),
      'RATE_LIMITED',
    );
    expect(again['retry_after_ms']).toBe(240_000);
    expect(kit.repos.tables.authEvents.filter((e) => e.type === 'lockout')).toHaveLength(1);
    // another IP is unaffected; after the lockout the IP logs in and is reset
    await service.login({ password: secret(PW), ip: '8.8.8.8' });
    await kit.clock.set(kit.clock.now() + 240_000);
    await service.login({ password: secret(PW), ip: '9.9.9.9' });
  });

  it('no operator yet → INVALID_CREDENTIALS', async () => {
    const kit = createAuthTestKit();
    const service = createAuthService(kit.deps);
    await failWith(service.login({ password: secret(PW), ip: '1.1.1.1' }), 'INVALID_CREDENTIALS');
  });
});

describe('sessions', () => {
  it('me/list/revoke/revoke-all/logout/touch', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW });
    const service = createAuthService(kit.deps);
    const a = await service.login({ password: secret(PW), ip: '1.1.1.1', userAgent: 'A' });
    await kit.clock.set(kit.clock.now() + 1000);
    const b = await service.login({ password: secret(PW), ip: '2.2.2.2', userAgent: 'B' });
    const c = await service.login({ password: secret(PW), ip: '3.3.3.3' });

    const me = await service.me(a.principal);
    expect(me.principal).toEqual({
      subject: 'admin',
      kind: 'operator',
      display: 'admin',
      scopes: a.principal.scopes,
      mustChangePassword: false,
    });
    expect(me.session?.idPrefix).toBe(a.session.idPrefix);

    const list = await service.listSessions(a.principal);
    expect(list.map((s) => [s.idPrefix, s.current])).toEqual([
      [b.session.idPrefix, false],
      [c.session.idPrefix, false],
      [a.session.idPrefix, true],
    ]);

    await service.revokeSession(a.principal, b.session.idPrefix);
    await failWith(service.revokeSession(a.principal, b.session.idPrefix), 'NOT_FOUND');
    expect(await service.revokeAllSessions(a.principal)).toBe(1);
    expect((await service.listSessions(a.principal)).map((s) => s.idPrefix)).toEqual([
      a.session.idPrefix,
    ]);

    expect(await service.touchSession(a.session.authSessionId)).toBe(true);
    expect(await service.touchSession(c.session.authSessionId)).toBe(false);
    const cookie = await service.logout(a.principal);
    expect(cookie.attributes.maxAge).toBe(0);
    expect(await service.touchSession(a.session.authSessionId)).toBe(false);
    const types = kit.repos.tables.authEvents.map((e) => e.type);
    expect(types.filter((t) => t === 'session_revoked')).toHaveLength(2);
    expect(types.at(-1)).toBe('logout');
    expect(kit.published.filter((e) => e.name === 'auth.session_revoked')).toHaveLength(2);
  });
});

describe('changePassword', () => {
  it('verifies current, applies policy, revokes other sessions, shreds the seed file, clears must_change', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW, mustChangePassword: true });
    kit.credentialsFile.content = 'seed\n';
    const service = createAuthService(kit.deps);
    const me = await service.login({ password: secret(PW), ip: '1.1.1.1' });
    await service.login({ password: secret(PW), ip: '1.1.1.2' });
    await service.login({ password: secret(PW), ip: '1.1.1.3' });

    await failWith(
      service.changePassword(me.principal, secret('wrong'), secret('a brand new password')),
      'BAD_CURRENT_PASSWORD',
    );
    const weak = await failWith(
      service.changePassword(me.principal, secret(PW), secret('short')),
      'WEAK_PASSWORD',
    );
    expect(weak['min_length']).toBe(12);
    await failWith(service.changePassword(me.principal, secret(PW), secret(PW)), 'WEAK_PASSWORD');

    const result = await service.changePassword(
      me.principal,
      secret(PW),
      secret('a brand new password'),
    );
    expect(result.revokedSessions).toBe(2);
    expect(kit.credentialsFile.shredCount).toBe(1);
    expect(kit.credentialsFile.content).toBeNull();
    expect(kit.repos.tables.principals.get('admin')?.mustChangePassword).toBe(false);
    expect(kit.repos.tables.credentials.get('cred-admin')?.secretHash).toBe(
      'fake$a brand new password',
    );
    expect(await service.touchSession(me.session.authSessionId)).toBe(true);
    expect(kit.repos.tables.authEvents.at(-1)).toMatchObject({
      type: 'password_changed',
      details: { revoked_sessions: 2 },
    });
    await service.login({ password: secret('a brand new password'), ip: '1.1.1.1' });
  });
});

describe('seed flow', () => {
  it('seedAdmin creates admin with a 24-char unbiased password, must_change, file written, callback once', async () => {
    const kit = createAuthTestKit();
    const seen: string[] = [];
    const service = createAuthService({
      ...kit.deps,
      onSeed: (s) => seen.push(s.password.reveal()),
    });
    const first = await service.seedAdmin();
    expect(first.seeded).toBe(true);
    if (!first.seeded) return;
    const pw = first.password.reveal();
    expect(pw).toHaveLength(24);
    for (const ch of pw) expect(SEED_ALPHABET.includes(ch)).toBe(true);
    expect(first.credentialsPath).toBe(kit.credentialsFile.path);
    expect(kit.credentialsFile.content).toBe(`${pw}\n`);
    expect(seen).toEqual([pw]);
    expect(kit.registered).toContain(pw);
    expect(kit.repos.tables.principals.get('admin')).toMatchObject({
      kind: 'operator',
      mustChangePassword: true,
    });
    expect(String(first.password)).toBe('[secret]');
    expect(await service.seedAdmin()).toEqual({ seeded: false });
    const login = await service.login({ password: secret(pw), ip: '1.1.1.1' });
    expect(login.mustChangePassword).toBe(true);
  });

  it('resetPassword re-seeds, sets must_change and revokes every session', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW });
    const service = createAuthService(kit.deps);
    const s = await service.login({ password: secret(PW), ip: '1.1.1.1' });
    const reset = await service.resetPassword();
    expect(reset.password.reveal()).toHaveLength(24);
    expect(kit.repos.tables.principals.get('admin')?.mustChangePassword).toBe(true);
    expect(await service.touchSession(s.session.authSessionId)).toBe(false);
    await failWith(service.login({ password: secret(PW), ip: '1.1.1.1' }), 'INVALID_CREDENTIALS');
    await service.login({ password: secret(reset.password.reveal()), ip: '1.1.1.1' });
    expect(
      kit.repos.tables.authEvents.some(
        (e) => e.type === 'password_changed' && e.details?.['reason'] === 'reset',
      ),
    ).toBe(true);
  });
});

describe('tokens', () => {
  it('create/list/revoke; plaintext once; scopes validated; seedAgentToken only when nothing exists', async () => {
    const kit = createAuthTestKit({ mode: 'token' });
    await seedOperator(kit, { password: PW });
    const service = createAuthService(kit.deps);
    const seeded = await service.seedAgentToken();
    expect(seeded.seeded).toBe(true);
    if (!seeded.seeded) return;
    expect(seeded.principalId).toBe('agent-1');
    expect(seeded.token.reveal().startsWith('bh_agent_')).toBe(true);
    expect(await service.seedAgentToken()).toEqual({ seeded: false });

    const { principal } = await service.login({ password: secret(PW), ip: '1.1.1.1' });
    const issued = await service.createToken(principal, {
      ownerKind: 'operator',
      display: 'script',
      scopes: ['sessions:read', 'logs:read'],
      expiresInMs: 1000,
    });
    expect(issued.token.reveal().startsWith('bh_operator_')).toBe(true);
    expect(issued.expiresAt).toBe(kit.clock.now() + 1000);
    await failWith(
      service.createToken(principal, {
        ownerKind: 'agent',
        display: 'x',
        scopes: ['sessions:read'],
      }),
      'VALIDATION_FAILED',
    );

    const list = await service.listTokens();
    expect(list.map((t) => [t.subject, t.ownerKind, t.scopes])).toEqual([
      ['agent-1', 'agent', ['mcp:tools']],
      ['admin', 'operator', ['sessions:read', 'logs:read']],
    ]);
    expect(JSON.stringify(list)).not.toContain(issued.token.reveal());

    await service.revokeToken(principal, issued.credentialId);
    await failWith(service.revokeToken(principal, issued.credentialId), 'NOT_FOUND');
    expect((await service.listTokens()).map((t) => t.subject)).toEqual(['agent-1']);
    expect(
      kit.repos.tables.authEvents.map((e) => e.type).filter((t) => t.startsWith('token')),
    ).toEqual(['token_issued', 'token_issued', 'token_revoked']);
  });

  it('config tokens suppress the seed token', async () => {
    const kit = createAuthTestKit({
      mode: 'token',
      authTokens: ['ci:0123456789abcdef0123456789abcdef'],
    });
    const service = createAuthService(kit.deps);
    expect(await service.seedAgentToken()).toEqual({ seeded: false });
  });
});

describe('sweep', () => {
  it('prunes expired sessions, grants and stale rate buckets', async () => {
    const kit = createAuthTestKit();
    await seedOperator(kit, { password: PW });
    const service = createAuthService(kit.deps);
    const { principal } = await service.login({ password: secret(PW), ip: '1.1.1.1' });
    await service.createGrant(principal, { route: 'trace', resourceId: 's' });
    await failWith(
      service.login({ password: secret('bad'), ip: '2.2.2.2' }),
      'INVALID_CREDENTIALS',
    );
    expect(await service.sweep()).toEqual({ sessions: 0, grants: 0, rateBuckets: 0 });
    await kit.clock.set(kit.clock.now() + 9 * 60 * 60_000);
    expect(await service.sweep()).toEqual({ sessions: 1, grants: 1, rateBuckets: 1 });
  });
});
