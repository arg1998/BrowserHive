/** @module interface/http/routes/auth-states.test — `GET /auth-states` across principals and the operator's audited `DELETE /auth-states/{owner}/{name}` (spec 03 §4.6.1). */

import { describe, expect, it } from 'bun:test';
import { ProblemDetails } from '@browserhive/contracts/errors';
import {
  AuthStatesResponse,
  DeleteAuthStateResponse,
  findEndpoint,
} from '@browserhive/contracts/http';
import { createHttpKit, type HttpKit } from '../../../../test/helpers/http-kit.ts';

async function authed(): Promise<{ kit: HttpKit; cookie: string }> {
  const kit = await createHttpKit();
  return { kit, cookie: await kit.login() };
}

/** An agent bearer token: it holds `mcp:tools` only, so every admin route refuses it. */
async function agentToken(kit: HttpKit, cookie: string): Promise<string> {
  const response = await kit.request('POST', '/api/v1/auth/tokens', {
    cookie,
    body: { owner_kind: 'agent', display: 'bot' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe('GET /auth-states', () => {
  it("lists every principal's saved logins newest first, with the source session's slug while it exists", async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request('GET', '/api/v1/auth-states', { cookie });
    expect(response.status).toBe(200);
    const body = AuthStatesResponse.parse(await response.json());
    expect(
      body.data.map((r) => [r.owner, r.name, r.kind, r.source_session_id, r.source_session_slug]),
    ).toEqual([
      ['alice', 'work', 'storage', 'gone-0000000c', null],
      ['local', 'work', 'profile', 'shop-0000000a', 'shop'],
    ]);
  });

  it('is declared under sessions:read, and an agent token (mcp:tools only) is refused', async () => {
    expect(findEndpoint('listAuthStates')?.scope).toBe('sessions:read');
    const { kit, cookie } = await authed();
    const agent = await agentToken(kit, cookie);
    const denied = await kit.request('GET', '/api/v1/auth-states', {
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(denied.status).toBe(403);
    expect(ProblemDetails.parse(await denied.json()).code).toBe('FORBIDDEN');
  });
});

describe('DELETE /auth-states/{owner}/{name}', () => {
  it("deletes another owner's saved login and writes the operator audit row", async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request('DELETE', '/api/v1/auth-states/alice/work', { cookie });
    expect(response.status).toBe(200);
    const body = DeleteAuthStateResponse.parse(await response.json());
    expect(body.deleted).toMatchObject({ owner: 'alice', name: 'work', kind: 'storage' });
    // Only alice's went; local's snapshot of the same name stays.
    expect(kit.authStates.records.map((r) => [r.owner, r.name])).toEqual([['local', 'work']]);
    const audit = await kit.services.repos.operatorActions.list({ types: ['delete'] });
    expect(
      audit.items.map((a) => [a.principalId, a.resourceKind, a.resourceId, a.details]),
    ).toEqual([
      [
        'admin',
        'auth_state',
        'alice/work',
        {
          owner: 'alice',
          name: 'work',
          kind: 'storage',
          size: 512,
          source_session_id: 'gone-0000000c',
        },
      ],
    ]);
  });

  it('answers 404 AUTH_STATE_NOT_FOUND for a missing one, and audits nothing', async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request('DELETE', '/api/v1/auth-states/bob/work', { cookie });
    expect(response.status).toBe(404);
    const problem = ProblemDetails.parse(await response.json());
    expect(problem.code).toBe('AUTH_STATE_NOT_FOUND');
    expect(problem.detail).toBe(
      "No saved auth snapshot named 'work'. Use list_saved_auths to see what is available.",
    );
    expect(kit.authStates.records).toHaveLength(2);
    expect((await kit.services.repos.operatorActions.list({ types: ['delete'] })).items).toEqual(
      [],
    );
  });

  it('is declared under sessions:write, and an agent token is refused and deletes nothing', async () => {
    expect(findEndpoint('deleteAuthState')?.scope).toBe('sessions:write');
    const { kit, cookie } = await authed();
    const agent = await agentToken(kit, cookie);
    const denied = await kit.request('DELETE', '/api/v1/auth-states/alice/work', {
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(denied.status).toBe(403);
    expect(ProblemDetails.parse(await denied.json()).code).toBe('FORBIDDEN');
    expect(kit.authStates.records).toHaveLength(2);
  });

  it('refuses a name that is not a saved-login name with 400', async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request('DELETE', '/api/v1/auth-states/alice/..%2Fx', { cookie });
    expect(response.status).toBe(400);
  });
});
