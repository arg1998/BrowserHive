/** @module test/integration/site-pack-pages.test — spec 13 §17 T3a acceptance for page enforcement on real Chromium with the HTTPS fixture sites: element guards (a `<span>` inside a guarded button, a newline into a guarded form, `press_key` on the focused field) answer `SITE_ACTION_BLOCKED` with the browser untouched; a `GET` logout navigation is `URL_BLOCKED` `site-a.test#logout`; a Cloudflare-style interstitial raises one `security_intercept` that holds the session's tools until it is resolved; an invisible reCAPTCHA v3 anchor and an invisible Turnstile frame raise nothing; an agent's own navigation to a challenge URL changes nothing while a redirect into it does; `stop` holds the site until **Clear stop**. */

import { afterEach, describe, expect, it } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ERROR_META_KEY } from '../../src/interface/mcp/shape.ts';
import { textOf } from '../helpers/fake-transport.ts';
import { type PackWorld, packWorld } from './site-pack-fixture.ts';
import { until } from './template-fixture.ts';

let world: PackWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

const SITE = 'site-a.test';

function ok(result: CallToolResult): CallToolResult {
  if (result.isError === true) throw new Error(textOf(result));
  return result;
}

/** The error code and details of a refused call. */
function refusal(result: CallToolResult): { code: string; details: Record<string, unknown> } {
  expect(result.isError).toBe(true);
  const meta = (result._meta?.[ERROR_META_KEY] ?? {}) as {
    code?: string;
    details?: Record<string, unknown>;
  };
  return { code: meta.code ?? textOf(result), details: meta.details ?? {} };
}

async function session(p: PackWorld) {
  const { session_id: id } = await p.w.harness.callJson<{ session_id: string }>('launch_session', {
    slug: 'packs',
    template: p.w.template.name,
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    p.w.harness.call(name, { session_id: id, ...args });
  const page = () => {
    const s = p.w.harness.services.sessions.peek(id);
    if (s === undefined) throw new Error('no session');
    return s.tabs.resolve();
  };
  return { id, call, page };
}

const paths = (p: PackWorld) => p.w.sites.requests.map((r) => r.path);
const siteRow = async (p: PackWorld) =>
  (await p.w.harness.templates.repos.templateSites.list(p.w.template.templateId))[0];

describe('site pack page enforcement', () => {
  it('a click on a <span> inside a guarded button is SITE_ACTION_BLOCKED and the browser untouched', async () => {
    world = await packWorld();
    const p = world;
    const { call, page } = await session(p);
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/guarded') }));
    const blocked = refusal(await call('click', { selector: '#signout-label' }));
    expect(blocked).toEqual({
      code: 'SITE_ACTION_BLOCKED',
      details: expect.objectContaining({ site: SITE, guard: 'site-a.test#signout' }),
    });
    expect(refusal(await call('hover', { selector: '#signout' })).code).toBe('SITE_ACTION_BLOCKED');
    // The role guard (`button` "Delete").
    expect(refusal(await call('click', { selector: '#danger-submit' })).code).toBe(
      'SITE_ACTION_BLOCKED',
    );
    expect(page().url()).toBe('https://site-a.test/pack/guarded');
    expect(paths(p)).not.toContain('/logout');
    ok(await call('click', { selector: '#safe' }));
    expect(await page().title()).toBe('safe clicked');
    expect(p.hits.map((h) => [h.source, h.guardId, h.action, h.tool])).toEqual([
      ['element', 'signout', 'block', 'click'],
      ['element', 'signout', 'block', 'hover'],
      ['element', 'delete', 'block', 'click'],
    ]);
  });

  it('a newline into a guarded form and Enter on its focused field are refused; other forms submit', async () => {
    world = await packWorld();
    const p = world;
    const { call, page } = await session(p);
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/guarded') }));
    ok(await call('type_text', { selector: '#danger-field', text: 'abc' }));
    expect(refusal(await call('type_text', { selector: '#danger-field', text: 'x\n' })).code).toBe(
      'SITE_ACTION_BLOCKED',
    );
    // `press_key` without a selector acts on the focused element (the guarded form's field).
    ok(await call('press_key', { key: 'a' }));
    expect(refusal(await call('press_key', { key: 'Enter' })).code).toBe('SITE_ACTION_BLOCKED');
    expect(refusal(await call('press_key', { key: 'Enter', selector: '#signout' })).code).toBe(
      'SITE_ACTION_BLOCKED',
    );
    expect(paths(p)).not.toContain('/logout?d=abca');
    expect(page().url()).toBe('https://site-a.test/pack/guarded');
    ok(await call('type_text', { selector: '#q', text: 'hello\n' }));
    await until(() => page().url().includes('/pack/searched'), 10_000, 'the search submitted');
  });

  it('navigate to a guarded logout is URL_BLOCKED with the pack#guard pattern and never sent', async () => {
    world = await packWorld();
    const p = world;
    const { call } = await session(p);
    const blocked = refusal(await call('navigate', { url: p.w.sites.url(SITE, '/logout?next=/') }));
    expect(blocked).toEqual({
      code: 'URL_BLOCKED',
      details: { url: 'https://site-a.test/logout?next=/', pattern: 'site-a.test#logout' },
    });
    expect(refusal(await call('new_tab', { url: p.w.sites.url(SITE, '/logout') })).code).toBe(
      'URL_BLOCKED',
    );
    expect(paths(p).some((path) => path.startsWith('/logout'))).toBe(false);
    expect(p.hits.map((h) => [h.source, h.guardId, h.method, h.url])).toEqual([
      ['tool', 'logout', 'GET', 'https://site-a.test/logout'],
      ['tool', 'logout', 'GET', 'https://site-a.test/logout'],
    ]);
  });

  it('a Cloudflare-style interstitial raises one security_intercept that holds the tools until resolved', async () => {
    world = await packWorld();
    const p = world;
    const intercepts = p.intercepts;
    if (intercepts === null) throw new Error('no intercepts');
    const { id, call } = await session(p);
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/cf') }));
    await until(() => intercepts.raised.length > 0, 10_000, 'the site check');
    expect(intercepts.raised[0]).toMatchObject({
      sessionId: id,
      site: SITE,
      packId: null,
      challenge: { id: 'cloudflare-interstitial', kind: 'captcha', action: 'attention' },
      pageUrl: 'https://site-a.test/pack/cf',
    });
    const hold = intercepts.holdOf(id);
    if (hold === null) throw new Error('not held');
    const held = refusal(await call('get_content', {}));
    expect(held).toEqual({
      code: 'SITE_OPERATOR_PENDING',
      details: expect.objectContaining({ request_id: hold.requestId, reason: 'challenge' }),
    });
    // Inspecting tools stay open; the request is a takeover (live-view input permitted).
    ok(await call('screenshot'));
    ok(await call('session_info'));
    const open = p.w.harness.attentionBroker.listOpen('security_intercept');
    expect(open.map((r) => [r.requestId, r.mode])).toEqual([[hold.requestId, 'takeover']]);
    expect((await siteRow(p))?.health).toMatchObject({
      state: 'challenged',
      reason: 'challenge:captcha',
    });
    await p.w.harness.attentionBroker.resolve(hold.requestId, { status: 'resolved' }, 'admin');
    ok(await call('get_content', {}));
    expect(intercepts.raised).toHaveLength(1);
  });

  it('an invisible reCAPTCHA v3 anchor and an invisible Turnstile frame raise nothing; a visible widget only marks health', async () => {
    world = await packWorld();
    const p = world;
    const intercepts = p.intercepts;
    if (intercepts === null) throw new Error('no intercepts');
    const { call } = await session(p);
    for (const path of ['/pack/recaptcha-v3', '/pack/turnstile-invisible']) {
      ok(await call('navigate', { url: p.w.sites.url(SITE, path) }));
      // The frame's `load` plus the 2 s second look, on this document.
      await Bun.sleep(3_500);
      expect(intercepts.raised).toEqual([]);
      expect((await siteRow(p))?.health.state).toBe('unknown');
    }
    // The fake provider frames did load (the resolver rule maps the provider hosts).
    expect(p.w.sites.requests.map((r) => r.host)).toContain('www.google.com');
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/turnstile') }));
    await until(
      () => p.w.harness.templates.repos.templateProbes.rows.length > 0,
      10_000,
      'the health row',
    );
    expect((await siteRow(p))?.health.state).toBe('challenged');
    expect(intercepts.raised).toEqual([]);
    ok(await call('get_content', {}));
  });

  it("an agent's own navigate to a challenge URL changes nothing; a redirect into it does", async () => {
    world = await packWorld();
    const p = world;
    const intercepts = p.intercepts;
    if (intercepts === null) throw new Error('no intercepts');
    const { call } = await session(p);
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/checkpoint') }));
    await Bun.sleep(1_000);
    expect(intercepts.raised).toEqual([]);
    expect((await siteRow(p))?.health.state).toBe('unknown');
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/go-checkpoint') }));
    await until(() => intercepts.raised.length > 0, 10_000, 'the site check');
    expect(intercepts.raised[0]?.challenge).toEqual({
      id: 'checkpoint',
      kind: 'checkpoint',
      action: 'attention',
    });
  });

  it('stop holds the site until Clear stop', async () => {
    world = await packWorld(undefined, { intercepts: false });
    const p = world;
    const { call } = await session(p);
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/pack/go-suspended') }));
    await until(
      () => p.w.harness.templates.repos.templateProbes.rows.length > 0,
      10_000,
      'the stop',
    );
    expect((await siteRow(p))?.stoppedAt).not.toBeNull();
    const stopped = refusal(await call('navigate', { url: p.w.sites.url(SITE, '/') }));
    expect(stopped).toEqual({
      code: 'SITE_OPERATOR_PENDING',
      details: expect.objectContaining({
        site: SITE,
        request_id: null,
        reason: 'stopped',
        wait_text: 'Do not retry until the operator clears the site.',
      }),
    });
    expect(refusal(await call('get_content', {})).code).toBe('SITE_OPERATOR_PENDING');
    ok(await call('screenshot'));
    // Another site stays usable in a new tab.
    ok(await call('new_tab', { url: p.w.sites.url('site-b.test', '/landing') }));
    expect(refusal(await call('new_tab', { url: p.w.sites.url(SITE, '/') })).code).toBe(
      'SITE_OPERATOR_PENDING',
    );
    await p.stops.clear(p.w.template.templateId, SITE, 'admin');
    expect((await siteRow(p))?.stoppedAt).toBeNull();
    ok(await call('navigate', { url: p.w.sites.url(SITE, '/') }));
  });
});
