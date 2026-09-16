/** @module app/auth/providers/chain.test — provider chain order, hard failures, expiry, tokens, grants, local. */

import { describe, expect, it } from 'bun:test';
import { createAuthTestKit, seedOperator, view } from '../../../../test/helpers/fake-auth.ts';
import { sha256Hex } from '../../../domain/auth/digest.ts';
import { LOCAL_PRINCIPAL } from '../../../domain/auth/principal.ts';
import { isAppError } from '../../../kernel/errors/app-error.ts';
import { secret } from '../../../kernel/secret.ts';
import { createAuthAudit } from '../audit.ts';
import { createAuthService } from '../auth-service.ts';
import { createAuthenticator } from '../authenticate.ts';
import type { AuthConfig, AuthRequestView } from '../types.ts';
import { lookupConfigToken, parseConfigTokens } from './bearer-token.ts';
import { adminProviderChain, mcpProviderChain } from './index.ts';
import { createLocalProvider } from './local.ts';

const CONFIG_TOKEN = 'ci-token-with-at-least-32-characters-1234';

async function setup(config: Partial<AuthConfig> = {}) {
  const kit = createAuthTestKit(config);
  await seedOperator(kit, { password: 'correct horse battery' });
  const service = createAuthService(kit.deps);
  const audit = createAuthAudit(kit.deps);
  const admin = createAuthenticator({
    ...kit.deps,
    audit,
    providers: adminProviderChain(kit.deps),
  });
  const mcp = createAuthenticator({ ...kit.deps, audit, providers: mcpProviderChain(kit.deps) });
  const login = () =>
    service.login({ password: secret('correct horse battery'), ip: '127.0.0.1', userAgent: 'ua' });
  return { kit, service, admin, mcp, login };
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAppError(error, 'UNAUTHORIZED')) return error.message;
    throw error;
  }
  throw new Error('expected UNAUTHORIZED');
}

describe('password-session provider', () => {
  it('a valid cookie yields the operator and slides the idle window', async () => {
    const { kit, admin, login } = await setup();
    const { token, session } = await login();
    const cookie = `browserhive_session=${token.reveal()}`;
    await kit.clock.set(kit.clock.now() + 10 * 60_000);
    const principal = await admin.authenticate(view({ headers: { cookie } }));
    expect(principal?.subject).toBe('admin');
    expect(principal?.auth).toEqual({
      method: 'password-session',
      sessionId: session.authSessionId,
      expiresAt: session.expiresAt,
    });
    expect(kit.repos.tables.authSessions.get(session.authSessionId)?.lastSeenAt).toBe(
      kit.clock.now(),
    );
    // 14 minutes later (24 since login) still fine because the window slid
    await kit.clock.set(kit.clock.now() + 14 * 60_000);
    expect((await admin.authenticate(view({ headers: { cookie } })))?.subject).toBe('admin');
  });

  it('idle timeout (15 min) revokes the session; absolute lifetime (8 h) expires it', async () => {
    const { kit, admin, login } = await setup();
    const first = await login();
    await kit.clock.set(kit.clock.now() + 15 * 60_000 + 1);
    const idleReason = await expectUnauthorized(
      admin.authenticate(
        view({ headers: { cookie: `browserhive_session=${first.token.reveal()}` } }),
      ),
    );
    expect(idleReason).toContain('idle');
    expect(
      kit.repos.tables.authSessions.get(first.session.authSessionId)?.revokedAt,
    ).not.toBeNull();

    const second = await login();
    const cookie = `browserhive_session=${second.token.reveal()}`;
    for (let i = 0; i < 40; i += 1) {
      await kit.clock.set(kit.clock.now() + 10 * 60_000);
      if (kit.clock.now() >= second.session.expiresAt) break;
      await admin.authenticate(view({ headers: { cookie } }));
    }
    await kit.clock.set(second.session.expiresAt);
    const absReason = await expectUnauthorized(admin.authenticate(view({ headers: { cookie } })));
    expect(absReason).toContain('expired');
  });

  it('an unknown cookie fails hard and writes an unauthorized auth_events row', async () => {
    const { kit, admin } = await setup();
    await expectUnauthorized(
      admin.authenticate(view({ headers: { cookie: 'browserhive_session=nope' } })),
    );
    const row = kit.repos.tables.authEvents.at(-1);
    expect(row?.type).toBe('unauthorized');
    expect(row?.details).toMatchObject({ provider: 'password-session', transport: 'http' });
    expect(kit.published.at(-1)?.name).toBe('auth.unauthorized');
  });
});

describe('bearer-token provider', () => {
  it('stored api tokens: prefix lookup + hash compare, touch, scopes from the credential', async () => {
    const { kit, admin, mcp, service, login } = await setup({ mode: 'token' });
    const { principal } = await login();
    const issued = await service.createToken(principal, {
      ownerKind: 'agent',
      display: 'CI Runner',
    });
    const literal = issued.token.reveal();
    const cred = kit.repos.tables.credentials.get(issued.credentialId);
    expect(cred?.publicPrefix).toBe(issued.publicPrefix);
    expect(cred?.secretHash).toBe(sha256Hex(literal));
    expect(literal).not.toContain(cred?.secretHash ?? 'x');
    await kit.clock.set(kit.clock.now() + 1000);
    const agent = await mcp.authenticate(view({ headers: { authorization: `Bearer ${literal}` } }));
    expect(agent?.subject).toBe('ci-runner');
    expect(agent?.kind).toBe('agent');
    expect(agent?.scopes).toEqual(['mcp:tools']);
    expect(agent?.auth).toEqual({ method: 'bearer', credentialId: issued.credentialId });
    expect(kit.repos.tables.credentials.get(issued.credentialId)?.lastUsedAt).toBe(kit.clock.now());
    // the same token is accepted by the admin chain (spec 03 §3.2 bearer column)
    expect(
      (await admin.authenticate(view({ headers: { authorization: `Bearer ${literal}` } })))
        ?.subject,
    ).toBe('ci-runner');
  });

  it('operator tokens carry a scope subset and the operator kind', async () => {
    const { admin, service, login } = await setup();
    const { principal } = await login();
    const issued = await service.createToken(principal, {
      ownerKind: 'operator',
      display: 'script',
      scopes: ['sessions:read'],
    });
    const op = await admin.authenticate(
      view({ headers: { authorization: `Bearer ${issued.token.reveal()}` } }),
    );
    expect(op?.kind).toBe('operator');
    expect(op?.scopes).toEqual(['sessions:read']);
  });

  it('wrong secret with a known prefix, revoked, expired, malformed and non-bearer all fail hard', async () => {
    const { kit, mcp, service, login } = await setup({ mode: 'token' });
    const { principal } = await login();
    const issued = await service.createToken(principal, {
      ownerKind: 'agent',
      display: 'a',
      expiresInMs: 60_000,
    });
    const literal = issued.token.reveal();
    const forged = `${literal.slice(0, -4)}AAAA`;
    expect(
      await expectUnauthorized(
        mcp.authenticate(view({ headers: { authorization: `Bearer ${forged}` } })),
      ),
    ).toContain('unknown');
    expect(
      await expectUnauthorized(
        mcp.authenticate(view({ headers: { authorization: 'Bearer not-a-token' } })),
      ),
    ).toContain('malformed');
    expect(
      await expectUnauthorized(mcp.authenticate(view({ headers: { authorization: 'Basic abc' } }))),
    ).toContain('scheme');
    const other = await service.createToken(principal, { ownerKind: 'agent', display: 'b' });
    await service.revokeToken(principal, other.publicPrefix);
    expect(
      await expectUnauthorized(
        mcp.authenticate(view({ headers: { authorization: `Bearer ${other.token.reveal()}` } })),
      ),
    ).toContain('unknown');
    await kit.clock.set(kit.clock.now() + 60_000);
    expect(
      await expectUnauthorized(
        mcp.authenticate(view({ headers: { authorization: `Bearer ${literal}` } })),
      ),
    ).toContain('expired');
  });

  it('authTokens config items are hashed at boot and resolve to agent principals', async () => {
    const { mcp } = await setup({
      mode: 'token',
      authTokens: [`ci-runner:${CONFIG_TOKEN}`, 'bad-item'],
    });
    const parsed = parseConfigTokens([`ci-runner:${CONFIG_TOKEN}`, 'bad-item', 'x:']);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.hash).toBe(sha256Hex(CONFIG_TOKEN));
    expect(lookupConfigToken(parsed, CONFIG_TOKEN)?.principalId).toBe('ci-runner');
    expect(lookupConfigToken(parsed, `${CONFIG_TOKEN}x`)).toBeUndefined();
    const agent = await mcp.authenticate(
      view({ headers: { authorization: `Bearer ${CONFIG_TOKEN}` }, remoteLoopback: false }),
    );
    expect(agent).toMatchObject({
      subject: 'ci-runner',
      kind: 'agent',
      scopes: ['mcp:tools'],
      auth: { method: 'bearer' },
    });
  });
});

describe('grant provider', () => {
  const trace = (id: string): Pick<AuthRequestView, 'grantRoute'> => ({
    grantRoute: { route: 'trace', resourceId: id },
  });

  it('is single-use, bound to route+resource, and dies with the parent session', async () => {
    const { kit, admin, service, login } = await setup();
    const { principal } = await login();
    const { grant, expiresAt } = await service.createGrant(principal, {
      route: 'trace',
      resourceId: 's-1',
    });
    const literal = grant.reveal();
    expect(literal.startsWith('bh_grant_')).toBe(true);
    expect(expiresAt).toBe(kit.clock.now() + 10 * 60_000);
    expect(kit.repos.tables.authEvents.at(-1)?.type).toBe('grant_issued');

    expect(
      await expectUnauthorized(admin.authenticate(view({ query: { grant: literal } }))),
    ).toContain('does not accept');
    expect(
      await expectUnauthorized(
        admin.authenticate(view({ query: { grant: literal }, ...trace('s-2') })),
      ),
    ).toContain('another resource');
    const p = await admin.authenticate(view({ query: { grant: literal }, ...trace('s-1') }));
    expect(p?.subject).toBe('admin');
    expect(p?.auth).toEqual({
      method: 'grant',
      sessionId: principal.auth.sessionId ?? '',
      expiresAt,
    });
    expect(
      await expectUnauthorized(
        admin.authenticate(view({ query: { grant: literal }, ...trace('s-1') })),
      ),
    ).toContain('already used');

    const second = await service.createGrant(principal, { route: 'trace', resourceId: 's-1' });
    await service.logout(principal);
    expect(
      await expectUnauthorized(
        admin.authenticate(view({ query: { grant: second.grant.reveal() }, ...trace('s-1') })),
      ),
    ).toContain('parent session');
  });

  it('expires after the TTL and honours the reuse window when configured', async () => {
    const { kit, admin, service, login } = await setup({ grantReuseWindowMs: 5_000 });
    const { principal } = await login();
    const { grant } = await service.createGrant(principal, {
      route: 'screenshot',
      resourceId: 'e-1',
    });
    const q = view({
      query: { grant: grant.reveal() },
      grantRoute: { route: 'screenshot', resourceId: 'e-1' },
    });
    expect((await admin.authenticate(q))?.subject).toBe('admin');
    await kit.clock.set(kit.clock.now() + 4_000);
    expect((await admin.authenticate(q))?.subject).toBe('admin');
    await kit.clock.set(kit.clock.now() + 2_000);
    expect(await expectUnauthorized(admin.authenticate(q))).toContain('already used');
    const late = await service.createGrant(principal, { route: 'screenshot', resourceId: 'e-1' });
    await kit.clock.set(late.expiresAt);
    expect(
      await expectUnauthorized(
        admin.authenticate(
          view({
            query: { grant: late.grant.reveal() },
            grantRoute: { route: 'screenshot', resourceId: 'e-1' },
          }),
        ),
      ),
    ).toContain('expired');
  });
});

describe('chain semantics', () => {
  it('first non-null wins: a cookie beats a bearer, and an invalid cookie never falls through', async () => {
    const { admin, service, login } = await setup();
    const { token, principal } = await login();
    const issued = await service.createToken(principal, { ownerKind: 'agent', display: 'a' });
    const both = view({
      headers: {
        cookie: `browserhive_session=${token.reveal()}`,
        authorization: `Bearer ${issued.token.reveal()}`,
      },
    });
    expect((await admin.authenticate(both))?.subject).toBe('admin');
    const badCookie = view({
      headers: {
        cookie: 'browserhive_session=bad',
        authorization: `Bearer ${issued.token.reveal()}`,
      },
    });
    await expectUnauthorized(admin.authenticate(badCookie));
  });

  it('no credential → null for authenticate, UNAUTHORIZED for require; admin chain never yields local', async () => {
    const { admin } = await setup();
    expect(await admin.authenticate(view())).toBeNull();
    await expectUnauthorized(admin.require(view()));
    expect(await admin.authenticate(view({ transport: 'stdio' }))).toBeNull();
  });
});

describe('local provider', () => {
  it('yields LOCAL_PRINCIPAL only under auth=off on loopback/stdio (or allowInsecureBind)', async () => {
    const off = createLocalProvider({ config: { ...createAuthTestKit().deps.config } });
    expect(await off.authenticate(view({ remoteLoopback: true }), { now: 0 })).toBe(
      LOCAL_PRINCIPAL,
    );
    expect(
      await off.authenticate(view({ transport: 'stdio', remoteLoopback: false }), { now: 0 }),
    ).toBe(LOCAL_PRINCIPAL);
    expect(await off.authenticate(view({ remoteLoopback: false }), { now: 0 })).toBeNull();
    const insecure = createLocalProvider({
      config: { ...createAuthTestKit({ allowInsecureBind: true }).deps.config },
    });
    expect(await insecure.authenticate(view({ remoteLoopback: false }), { now: 0 })).toBe(
      LOCAL_PRINCIPAL,
    );
    const token = createLocalProvider({
      config: { ...createAuthTestKit({ mode: 'token' }).deps.config },
    });
    expect(await token.authenticate(view({ remoteLoopback: true }), { now: 0 })).toBeNull();
  });

  it('the MCP chain: bearer present-but-invalid fails even under auth=off; missing → local', async () => {
    const { mcp } = await setup({ mode: 'off' });
    expect(await mcp.authenticate(view())).toBe(LOCAL_PRINCIPAL);
    await expectUnauthorized(
      mcp.authenticate(view({ headers: { authorization: 'Bearer bogus' } })),
    );
    const strict = await setup({ mode: 'token' });
    expect(await strict.mcp.authenticate(view())).toBeNull();
  });
});
