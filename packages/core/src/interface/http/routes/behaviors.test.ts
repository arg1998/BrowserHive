/** @module interface/http/routes/behaviors.test — route semantics beyond the table: ranges and grants, caching, idempotent bulk, gates, lifecycle conflicts, negotiation, MCP mount. */

import { describe, expect, it } from 'bun:test';
import { ProblemDetails } from '@browserhive/contracts/errors';
import {
  PagesPage,
  SCREENSHOT_CACHE_CONTROL,
  SessionsPage,
  SessionToolCallsPage,
  TOOL_ARGS_CAP_BYTES,
  ToolCallDetail,
  ToolCallsPage,
  TruncatedToolArgs,
} from '@browserhive/contracts/http';
import {
  ARCHIVED_ID,
  CLOSED_ID,
  EVENT_OK,
  sessionRecord,
} from '../../../../test/helpers/http-fixtures.ts';
import { createHttpKit, type HttpKit } from '../../../../test/helpers/http-kit.ts';
import { IDEMPOTENCY_KEY } from '../../../../test/helpers/http-route-cases.ts';
import { posixView } from '../../../../test/helpers/posix-paths.ts';
import { capToolArgs } from '../../../app/observability/tool-args-policy.ts';

async function problemCode(response: Response): Promise<string> {
  return ProblemDetails.parse(await response.json()).code;
}

async function authed(): Promise<{ kit: HttpKit; cookie: string }> {
  const kit = await createHttpKit();
  return { kit, cookie: await kit.login() };
}

describe('trace.zip', () => {
  it('serves single ranges (206), suffix ranges and 416', async () => {
    const { kit, cookie } = await authed();
    const path = `/api/v1/sessions/${CLOSED_ID}/trace.zip`;
    const partial = await kit.request('GET', path, { cookie, headers: { range: 'bytes=10-19' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    const suffix = await kit.request('GET', path, { cookie, headers: { range: 'bytes=-5' } });
    expect(suffix.headers.get('content-range')).toBe('bytes 95-99/100');
    const bad = await kit.request('GET', path, { cookie, headers: { range: 'bytes=500-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */100');
    const head = await kit.request('HEAD', path, { cookie });
    expect(head.headers.get('content-length')).toBe('100');
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts a trace grant without a cookie, only for its own session', async () => {
    const { kit, cookie } = await authed();
    const minted = await kit.request('POST', '/api/v1/auth/grants', {
      cookie,
      body: { route: 'trace', resource_id: CLOSED_ID },
    });
    const { grant } = (await minted.json()) as { grant: string };
    const ok = await kit.request('GET', `/api/v1/sessions/${CLOSED_ID}/trace.zip?grant=${grant}`);
    expect(ok.status).toBe(200);
    const other = await kit.request(
      'GET',
      `/api/v1/sessions/${ARCHIVED_ID}/trace.zip?grant=${grant}`,
    );
    expect(other.status).toBe(401);
  });

  it('TRACE_UNAVAILABLE when the file is missing', async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request('GET', `/api/v1/sessions/${ARCHIVED_ID}/trace.zip`, {
      cookie,
    });
    expect(response.status).toBe(404);
    expect(await problemCode(response)).toBe('TRACE_UNAVAILABLE');
  });
});

describe('screenshots', () => {
  it('serves bytes with the immutable private cache policy', async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request(
      'GET',
      `/api/v1/sessions/${CLOSED_ID}/screenshots/${EVENT_OK}`,
      { cookie },
    );
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(SCREENSHOT_CACHE_CONTROL);
  });

  it('SCREENSHOT_UNAVAILABLE when the file is gone; NOT_FOUND for another session', async () => {
    const { kit, cookie } = await authed();
    kit.files.files.clear();
    const gone = await kit.request('GET', `/api/v1/sessions/${CLOSED_ID}/screenshots/${EVENT_OK}`, {
      cookie,
    });
    expect(await problemCode(gone)).toBe('SCREENSHOT_UNAVAILABLE');
    const foreign = await kit.request(
      'GET',
      `/api/v1/sessions/${ARCHIVED_ID}/screenshots/${EVENT_OK}`,
      { cookie },
    );
    expect(await problemCode(foreign)).toBe('NOT_FOUND');
  });
});

describe('screenshots of template sessions (spec 13 §11.1)', () => {
  it('need templates:read, and templates:login for a maintenance session', async () => {
    const { kit, cookie } = await authed();
    const issue = async (scopes: string[]) => {
      const response = await kit.request('POST', '/api/v1/auth/tokens', {
        cookie,
        body: { owner_kind: 'operator', display: `viewer-${scopes.length}`, scopes },
      });
      const { token } = (await response.json()) as { token: string };
      return { authorization: `Bearer ${token}` };
    };
    const sessionsOnly = await issue(['sessions:read']);
    const reader = await issue(['sessions:read', 'templates:read']);
    const login = await issue(['sessions:read', 'templates:read', 'templates:login']);
    const image = `/api/v1/sessions/${CLOSED_ID}/screenshots/${EVENT_OK}`;
    const list = `/api/v1/sessions/${CLOSED_ID}/screenshots`;
    const row = kit.repos.sessions.rows.get(CLOSED_ID);
    if (row === undefined) throw new Error('no closed session row');
    const as = (mode: 'live' | 'maintenance') =>
      kit.repos.sessions.rows.set(CLOSED_ID, {
        ...row,
        template: { templateId: 'tp-fixture001', name: 'job-hunt', version: null, mode },
        sealed: mode === 'live',
      });
    as('live');
    for (const path of [image, list]) {
      expect((await kit.request('GET', path, { headers: sessionsOnly })).status).toBe(403);
      expect((await kit.request('GET', path, { headers: reader })).status).toBe(200);
    }
    as('maintenance');
    for (const path of [image, list]) {
      expect((await kit.request('GET', path, { headers: reader })).status).toBe(403);
      expect((await kit.request('GET', path, { headers: login })).status).toBe(200);
    }
  });
});

describe('sessions', () => {
  it('overlays the live registry on stored rows and 404s unknown ids', async () => {
    const { kit, cookie } = await authed();
    const live = await kit.sessions.create({ slug: 'live' }, { subject: 'admin' });
    await kit.repos.sessions.insert({
      ...sessionRecord(),
      sessionId: live.id,
      slug: 'live',
      state: 'reserved',
      closedAt: null,
      closedReason: null,
    });
    const body = SessionsPage.parse(
      await (await kit.request('GET', '/api/v1/sessions', { cookie })).json(),
    );
    expect(body.data.find((s) => s.session_id === live.id)?.state).toBe('live');
    const missing = await kit.request('GET', '/api/v1/sessions/ghost-00000009', { cookie });
    expect(await problemCode(missing)).toBe('SESSION_NOT_FOUND');
  });

  it('terminate of a closed session is 409 SESSION_NOT_LIVE; archive of a live one is 409 SESSION_LIVE', async () => {
    const { kit, cookie } = await authed();
    const closed = await kit.request('POST', `/api/v1/sessions/${CLOSED_ID}/terminate`, { cookie });
    expect(closed.status).toBe(409);
    expect(await problemCode(closed)).toBe('SESSION_NOT_LIVE');
    const live = await kit.sessions.create({ slug: 'live' }, { subject: 'admin' });
    const archive = await kit.request('POST', `/api/v1/sessions/${live.id}/archive`, { cookie });
    expect(await problemCode(archive)).toBe('SESSION_LIVE');
  });

  it('archive publishes session.removed and writes an operator action', async () => {
    const { kit, cookie } = await authed();
    await kit.request('POST', `/api/v1/sessions/${CLOSED_ID}/archive`, { cookie });
    expect(kit.events.names()).toContain('session.removed');
    expect(kit.vaultRepos.actions.rows.map((r) => r.action)).toContain('archive');
  });

  it('bulk replays the stored result for the same Idempotency-Key', async () => {
    const { kit, cookie } = await authed();
    const body = { action: 'delete', session_ids: [CLOSED_ID, 'ghost-00000009'] };
    const headers = { 'idempotency-key': IDEMPOTENCY_KEY };
    const first = await kit.request('POST', '/api/v1/sessions/bulk', { cookie, body, headers });
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ ok_count: 1, error_count: 1 });
    const replay = await kit.request('POST', '/api/v1/sessions/bulk', { cookie, body, headers });
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(await replay.json()).toEqual(firstBody);
  });

  it('input without an open takeover request is 409 INPUT_NOT_PERMITTED; viewport is never gated', async () => {
    const { kit, cookie } = await authed();
    const live = await kit.sessions.create({ slug: 'live' }, { subject: 'admin' });
    const input = await kit.request('POST', `/api/v1/sessions/${live.id}/input`, {
      cookie,
      body: { inputs: [{ type: 'key', action: 'keyDown', key: 'a' }] },
    });
    expect(await problemCode(input)).toBe('INPUT_NOT_PERMITTED');
    expect(kit.live.inputs).toEqual([]);
    const viewport = await kit.request('POST', `/api/v1/sessions/${live.id}/viewport`, {
      cookie,
      body: { width: 1024, height: 768 },
    });
    expect(viewport.status).toBe(200);
    expect(kit.live.viewports).toEqual([{ width: 1024, height: 768 }]);
  });

  it('export negotiates CSV and refuses unsupported types with 406', async () => {
    const { kit, cookie } = await authed();
    const csv = await kit.request('GET', `/api/v1/sessions/${CLOSED_ID}/export`, {
      cookie,
      headers: { accept: 'text/csv' },
    });
    const text = await csv.text();
    expect(text.split('\n')[0]).toBe('kind,ts,id,data');
    expect(text.split('\n').filter((l) => l.startsWith('tool,')).length).toBe(2);
    const refused = await kit.request('GET', `/api/v1/sessions/${CLOSED_ID}/export`, {
      cookie,
      headers: { accept: 'application/pdf' },
    });
    expect(refused.status).toBe(406);
  });

  it('reveal opens the session directory through the Desktop port', async () => {
    const { kit, cookie } = await authed();
    await kit.request('POST', `/api/v1/sessions/${CLOSED_ID}/data-dir/reveal`, { cookie });
    expect(posixView(kit.desktop.revealed)).toEqual([`/data/sessions/${CLOSED_ID}`]);
  });
});

describe('fleet lists', () => {
  it('GET /pages carries disjunctive category facets', async () => {
    const { kit, cookie } = await authed();
    const body = PagesPage.parse(
      await (await kit.request('GET', '/api/v1/pages?category=local', { cookie })).json(),
    );
    expect(body.data).toEqual([]);
    expect(body.facets.category).toEqual([{ value: 'public', count: 1 }]);
  });

  it('GET /tool-calls?has_session filters session-less calls', async () => {
    const { kit, cookie } = await authed();
    const stored = await kit.repos.toolCalls.get(EVENT_OK);
    if (stored === null) throw new Error('fixture tool call missing');
    const { sessionSlug: _slug, hasScreenshot: _shot, ...record } = stored;
    await kit.repos.toolCalls.insert({
      ...record,
      eventId: 'e-01J00000000000000000000099',
      sessionId: null,
      tool: 'scroll',
      ok: false,
      errorCode: 'INVALID_ARGUMENTS',
      seq: 99,
    });
    const ids = async (query: string) =>
      ToolCallsPage.parse(
        await (await kit.request('GET', `/api/v1/tool-calls?ok=false${query}`, { cookie })).json(),
      ).data.map((row) => row.session_id);
    expect(await ids('')).toContain(null);
    expect(await ids('&has_session=true')).not.toContain(null);
    expect(await ids('&has_session=false')).toEqual([null]);
  });

  it('serves capped arguments as the truncation marker in every detail view (D-47)', async () => {
    const { kit, cookie } = await authed();
    const stored = await kit.repos.toolCalls.get(EVENT_OK);
    if (stored === null) throw new Error('fixture tool call missing');
    const { sessionSlug: _slug, hasScreenshot: _shot, ...record } = stored;
    const eventId = 'e-01J00000000000000000000098';
    const args = capToolArgs({ text: 'a'.repeat(4 * 1024 * 1024) });
    await kit.repos.toolCalls.insert({ ...record, eventId, args, seq: 98 });
    const base = `/api/v1/sessions/${CLOSED_ID}/tool-calls`;
    const detail = ToolCallDetail.parse(
      await (await kit.request('GET', `${base}/${eventId}`, { cookie })).json(),
    );
    const listed = SessionToolCallsPage.parse(
      await (await kit.request('GET', `${base}?expand=detail`, { cookie })).json(),
    ).data.find((row) => row.event_id === eventId);
    const fleet = ToolCallsPage.parse(
      await (await kit.request('GET', '/api/v1/tool-calls?expand=detail', { cookie })).json(),
    ).data.find((row) => row.event_id === eventId);
    for (const value of [detail.args_json, listed?.args_json, fleet?.args_json]) {
      const marker = TruncatedToolArgs.parse(value);
      expect(marker.bytes).toBe(4 * 1024 * 1024 + 11);
      expect(new TextEncoder().encode(JSON.stringify(marker)).length).toBeLessThanOrEqual(
        TOOL_ARGS_CAP_BYTES,
      );
    }
  });
});

describe('auth routes', () => {
  it('logout clears the cookie and later requests are 401', async () => {
    const { kit, cookie } = await authed();
    const out = await kit.request('POST', '/api/v1/auth/logout', { cookie });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await kit.request('GET', '/api/v1/auth/me', { cookie })).status).toBe(401);
  });

  it('login sets an HttpOnly SameSite=Strict cookie; wrong password is 401 INVALID_CREDENTIALS', async () => {
    const kit = await createHttpKit({ seed: false });
    const bad = await kit.request('POST', '/api/v1/auth/login', {
      body: { password: 'nope nope nope' },
    });
    expect(await problemCode(bad)).toBe('INVALID_CREDENTIALS');
    const good = await kit.request('POST', '/api/v1/auth/login', {
      body: { password: 'correct horse battery' },
    });
    expect(good.headers.get('set-cookie')).toMatch(/browserhive_session=.+HttpOnly/);
    expect(good.headers.get('set-cookie')).toContain('SameSite=Strict');
  });
});

describe('operator requests and vault', () => {
  it('resolving twice is 409 ATTENTION_NOT_OPEN', async () => {
    const { kit, cookie } = await authed();
    const handle = await kit.broker.open({
      kind: 'attention',
      sessionId: CLOSED_ID,
      owner: 'agent-1',
      reason: 'x',
      mode: 'notify',
    });
    const path = `/api/v1/attention/${handle.id}/resolve`;
    expect(
      (await kit.request('POST', path, { cookie, body: { decision: 'resolve' } })).status,
    ).toBe(200);
    const again = await kit.request('POST', path, { cookie, body: { decision: 'reject' } });
    expect(again.status).toBe(409);
    expect(await problemCode(again)).toBe('ATTENTION_NOT_OPEN');
  });

  it('a stale If-Match version is 409 CONFLICT with current_version; If-Match is optional on create', async () => {
    const { kit, cookie } = await authed();
    const path = '/api/v1/vault/bindings/work.github';
    const stale = await kit.request('PUT', path, {
      cookie,
      body: { title: 'x' },
      headers: { 'if-match': '7' },
    });
    expect(stale.status).toBe(409);
    const problem = ProblemDetails.parse(await stale.json());
    expect(problem.code).toBe('CONFLICT');
    expect(problem.details).toEqual({ current_version: 1 });
    const created = await kit.request('PUT', '/api/v1/vault/bindings/fresh.one', {
      cookie,
      body: { item_name: 'Fresh' },
    });
    expect(created.status).toBe(200);
  });

  it('harness lists (D-48): round-trip on PUT with the version rules, field-level 400s, the picker data', async () => {
    const { kit, cookie } = await authed();
    const path = '/api/v1/vault/bindings/work.github';
    const set = await kit.request('PUT', path, {
      cookie,
      body: { harnesses: ['opencode', 'Claude-Code'] },
      headers: { 'if-match': '1' },
    });
    expect(set.status).toBe(200);
    const body = (await set.json()) as { binding: { harnesses?: string[]; version: number } };
    expect(body.binding).toMatchObject({ harnesses: ['opencode', 'Claude-Code'], version: 2 });
    const cleared = await kit.request('PUT', path, {
      cookie,
      body: { harnesses: null },
      headers: { 'if-match': '2' },
    });
    expect(((await cleared.json()) as { binding: object }).binding).not.toHaveProperty('harnesses');

    const bad = await kit.request('PUT', path, { cookie, body: { harnesses: ['bad\u0007name'] } });
    expect(bad.status).toBe(400);
    const problem = ProblemDetails.parse(await bad.json());
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(problem.details)).toContain('harnesses');
    const policy = await kit.request('PUT', '/api/v1/vault/groups/__ungrouped__/policy', {
      cookie,
      body: { access_mode: 'manual', harnesses: Array.from({ length: 33 }, (_, i) => `h${i}`) },
    });
    expect(policy.status).toBe(400);

    // The tester (D-48): a harness is checked like the broker does; a bad slug is a field-level 400.
    const tested = await kit.request('POST', '/api/v1/vault/bindings/resolve', {
      cookie,
      body: { url: 'https://github.com/login', harness: 'opencode' },
    });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ harness_lists_unchecked: [] });
    const unchecked = await kit.request('POST', '/api/v1/vault/bindings/resolve', {
      cookie,
      body: { url: 'https://github.com/login' },
    });
    expect(
      ((await unchecked.json()) as { harness_lists_unchecked: string[] }).harness_lists_unchecked,
    ).toEqual([]);
    const badSlug = await kit.request('POST', '/api/v1/vault/bindings/resolve', {
      cookie,
      body: { url: 'https://github.com/login', harness: 'Not A Slug' },
    });
    expect(badSlug.status).toBe(400);
    expect(JSON.stringify(ProblemDetails.parse(await badSlug.json()).details)).toContain('harness');

    const seen = await kit.request('GET', '/api/v1/vault/harnesses', { cookie });
    expect(seen.status).toBe(200);
    const picker = (await seen.json()) as {
      data: { harness: string; label: string; declared: string | null }[];
      principals: number;
    };
    expect(picker.data.map((d) => [d.harness, d.label, d.declared])).toContainEqual([
      'nightly-scraper',
      'nightly-scraper',
      'Nightly Scraper',
    ]);
    expect(picker.principals).toBe(1);
  });

  it('vault routes are 404 VAULT_NOT_CONFIGURED when vault=off', async () => {
    const kit = await createHttpKit({ vaultConfigured: false });
    const cookie = await kit.login();
    const response = await kit.request('GET', '/api/v1/vault/bindings', { cookie });
    expect(response.status).toBe(404);
    expect(await problemCode(response)).toBe('VAULT_NOT_CONFIGURED');
  });
});

describe('POST /auth/tokens: reserved subjects (spec 13 T0f)', () => {
  it('answers 400 VALIDATION_FAILED "subject is reserved" for Local, BrowserHive and System', async () => {
    const { kit, cookie } = await authed();
    for (const display of ['Local', 'BrowserHive', 'System', 'local ']) {
      const response = await kit.request('POST', '/api/v1/auth/tokens', {
        cookie,
        body: { owner_kind: 'agent', display },
      });
      expect(response.status).toBe(400);
      const problem = ProblemDetails.parse(await response.json());
      expect(problem).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'subject is reserved',
        retryable: 'different_args',
        details: {
          issues: [{ path: 'display', message: 'subject is reserved', code: 'reserved' }],
        },
      });
    }
    const list = await kit.request('GET', '/api/v1/auth/tokens', { cookie });
    const { data } = (await list.json()) as { data: { subject: string }[] };
    expect(data.map((t) => t.subject)).not.toContain('local');
  });

  it('still issues an ordinary agent token', async () => {
    const { kit, cookie } = await authed();
    const response = await kit.request('POST', '/api/v1/auth/tokens', {
      cookie,
      body: { owner_kind: 'agent', display: 'Local runner' },
    });
    expect(response.status).toBe(200);
  });
});

describe('transport mounts', () => {
  it('/mcp requires a bearer under auth=token and forwards the principal', async () => {
    const { kit, cookie } = await authed();
    expect((await kit.request('POST', '/mcp', {})).status).toBe(401);
    const created = await kit.request('POST', '/api/v1/auth/tokens', {
      cookie,
      body: { owner_kind: 'agent', display: 'bot' },
    });
    const { token } = (await created.json()) as { token: string };
    const response = await kit.request('POST', '/mcp', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await response.json()).toEqual({ mcp: true, principal: 'bot' });
  });

  it('the WS upgrade path without a Bun server is 426', async () => {
    const kit = await createHttpKit({ seed: false });
    expect((await kit.request('GET', '/api/v1/ws')).status).toBe(426);
  });

  it('docs 404 and a status page at / when admin=false', async () => {
    const kit = await createHttpKit({ admin: false, seed: false });
    expect((await kit.request('GET', '/api/v1/docs')).status).toBe(404);
    const root = await kit.request('GET', '/');
    expect(await root.text()).toContain('--admin');
    expect((await kit.request('GET', '/sessions')).status).toBe(404);
  });

  it('GET JSON responses carry a weak ETag honoured by If-None-Match', async () => {
    const { kit, cookie } = await authed();
    const first = await kit.request('GET', '/api/v1/blocklist', { cookie });
    const etag = first.headers.get('etag') ?? '';
    expect(etag.startsWith('W/"')).toBe(true);
    const second = await kit.request('GET', '/api/v1/blocklist', {
      cookie,
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });
});
