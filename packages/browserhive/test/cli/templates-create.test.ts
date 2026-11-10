/** @module test/cli/templates-create.test — `browserhive templates create | finish` over the REST API (spec 13 §7.2, §11.5): the body built from the flags, usage errors, `--noLogin`, the remote-machine warning, the sign-in wait (polls, Enter, timeout, Ctrl+C), confirming unsigned sites, removing unlisted sign-ins and the exit codes. */

import { describe, expect, it } from 'bun:test';
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { cliHarness } from './helpers.ts';
import {
  BASE,
  fakeServer,
  http,
  ID,
  listPage,
  operator,
  paths,
  problem,
  run,
  URL_FLAGS,
} from './template-fakes.ts';

describe('templates create: flags', () => {
  it('maps every flag to the POST /templates body', async () => {
    const server = fakeServer({ 'linkedin.com': 'unknown' });
    const result = await run(server, [
      'create',
      'job-hunt',
      '--sites',
      ' LinkedIn.com, indeed.com,linkedin.com,',
      '--displayName',
      'Job hunt',
      '--description',
      'Applications',
      '--channel',
      'chrome',
      '--headless',
      '--stealth',
      'max',
      '--proxy',
      'http://proxy.test:8080',
      '--proxyUsername',
      'me',
      '--proxyPasswordEnv',
      'BH_PROXY_PASSWORD',
      '--locale',
      'en-CA',
      '--timezone',
      'America/Toronto',
      '--maxConcurrent',
      '3',
      '--principal',
      'agent-1',
      '--principal',
      'agent-2',
      '--noLogin',
      ...URL_FLAGS,
    ]);
    expect(result.code).toBe(0);
    expect(paths(server)).toEqual([`POST ${BASE}`]);
    expect(server.calls[0]?.body).toEqual({
      name: 'job-hunt',
      sites: [{ site_id: 'linkedin.com' }, { site_id: 'indeed.com' }],
      display_name: 'Job hunt',
      description: 'Applications',
      channel: 'chrome',
      headless: true,
      stealth: 'max',
      proxy: {
        server: 'http://proxy.test:8080',
        username: 'me',
        password_env: 'BH_PROXY_PASSWORD',
      },
      locale: 'en-CA',
      timezone_id: 'America/Toronto',
      policy: { max_concurrent: 3, authorized_principals: ['agent-1', 'agent-2'] },
    });
    expect(result.stdout).toContain(`created template job-hunt (${ID})`);
  });

  it('sends only the sites without optional flags, and [] for --allPrincipals', async () => {
    const plain = fakeServer({ 'a.test': 'unknown' });
    await run(plain, ['create', 'job-hunt', '--sites', 'a.test', '--noLogin', ...URL_FLAGS]);
    expect(plain.calls[0]?.body).toEqual({ name: 'job-hunt', sites: [{ site_id: 'a.test' }] });
    const all = fakeServer({ 'a.test': 'unknown' });
    await run(all, [
      'create',
      'job-hunt',
      '--sites=a.test',
      '--allPrincipals',
      '--noHeadless',
      '--noLogin',
      ...URL_FLAGS,
    ]);
    expect(all.calls[0]?.body).toEqual({
      name: 'job-hunt',
      sites: [{ site_id: 'a.test' }],
      headless: false,
      policy: { authorized_principals: [] },
    });
  });

  it.each([
    [['--sites', 'a.test', '--allPrincipals', '--principal', 'agent-1'], 'mutually exclusive'],
    [[], 'requires --sites <site,…>'],
    [['--sites', ' , '], '--sites needs at least one site.'],
    [['--sites', 'a test'], "invalid site 'a test'"],
    [['--sites', 'a.test', '--maxConcurrent', '21'], 'from 1 to 20'],
    [['--sites', 'a.test', '--maxConcurrent', '2.5'], 'from 1 to 20'],
    [['--sites', 'a.test', '--timeout', 'soon'], 'invalid value for --timeout'],
    [['--sites', 'a.test', '--proxyUsername', 'me'], '--proxyUsername requires --proxy.'],
    [['--sites', 'a.test', '--channel', 'firefox'], 'invalid value for --channel'],
    [['--sites', 'a.test', '--stealth', 'ultra'], 'invalid value for --stealth'],
  ])('rejects %j as a usage error (64)', async (flags, message) => {
    const server = fakeServer({});
    const result = await run(server, ['create', 'job-hunt', ...flags, ...URL_FLAGS]);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(message);
    expect(server.calls).toEqual([]);
  });

  it('rejects an invalid name and needs the name argument', async () => {
    const server = fakeServer({});
    const bad = await run(server, ['create', 'Job_Hunt', '--sites', 'a.test', ...URL_FLAGS]);
    expect(bad.code).toBe(64);
    expect(bad.stderr).toContain("invalid template name 'Job_Hunt'");
    const missing = await run(server, ['create', '--sites', 'a.test', ...URL_FLAGS]);
    expect(missing.code).toBe(64);
  });

  it('--noLogin --json prints the created template', async () => {
    const server = fakeServer({ 'a.test': 'unknown' });
    const result = await run(server, [
      'create',
      'job-hunt',
      '--sites',
      'a.test',
      '--noLogin',
      '--json',
      ...URL_FLAGS,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ template_id: ID, status: 'recording' });
  });
});

describe('templates create: signing in', () => {
  const CREATE = ['create', 'job-hunt', '--sites', 'a.test,b.test,c.test'];

  it('warns when the window opens on another machine, not on loopback', async () => {
    const remote = fakeServer({ 'a.test': 'signed_in' });
    const far = await run(remote, [
      'create',
      'job-hunt',
      '--sites',
      'a.test',
      '--url',
      'http://bh.example:9876',
    ]);
    expect(far.stderr).toContain('This opens a window on bh.example, not on this device.');
    const local = fakeServer({ 'a.test': 'signed_in' });
    const near = await run(local, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS]);
    expect(near.stderr).not.toContain('This opens a window');
  });

  it('Enter confirms only the unsigned sites; a 409 is reported as not signed in (exit 2)', async () => {
    const server = fakeServer({ 'a.test': 'unknown', 'b.test': 'unknown', 'c.test': 'unknown' });
    server.refuse.add('c.test');
    server.unlisted = ['google.com'];
    server.uncleared = ['google.com'];
    const op = operator();
    server.onPoll = (poll) => {
      if (poll === 1) server.sites.set('a.test', 'signed_in');
      if (poll === 2) op.enter();
    };
    const result = await run(server, [...CREATE, ...URL_FLAGS], { op });
    expect(result.code).toBe(2);
    expect(paths(server)).toEqual([
      `POST ${BASE}`,
      `POST ${BASE}/${ID}/recording`,
      `GET ${BASE}/${ID}`,
      `GET ${BASE}/${ID}`,
      `GET ${BASE}/${ID}`,
      `GET ${BASE}/${ID}`,
      `POST ${BASE}/${ID}/recording/confirm`,
      `POST ${BASE}/${ID}/recording/confirm`,
      `GET ${BASE}/${ID}`,
      `POST ${BASE}/${ID}/recording/finish`,
    ]);
    const confirmed = server.calls
      .filter((c) => c.path.endsWith('/confirm'))
      .map((c) => (c.body as { site_id: string }).site_id);
    expect(confirmed).toEqual(['b.test', 'c.test']);
    expect(op.slept).toEqual([2000, 2000, 2000]);
    expect(result.stdout).toContain('Press Enter here when you are signed in to every site');
    expect(result.stdout).toContain('a.test  · waiting');
    expect(result.stdout).toContain('a.test  ✓ signed in');
    expect(result.stdout).toContain('c.test  ✗ not signed in');
    expect(result.stdout).toContain('template job-hunt is ready');
    expect(result.stdout).toContain('c.test is not signed in');
    expect(result.stderr).toContain('c.test: not signed in (no new sign-in cookie appeared');
    // Without a terminal the unlisted sign-ins are removed (preselected).
    expect(result.stdout).toContain('Also signed in to: google.com — agents can use this.');
    expect(server.calls.at(-1)?.body).toEqual({ remove_sign_ins: ['google.com'] });
    // Site data the server could not clear is reported, never silent (review H-1).
    expect(`${result.stdout}${result.stderr}`).toContain(
      'google.com: site data not cleared for https://google.com',
    );
  });

  it('on a terminal, answering n keeps the unlisted sign-ins; Enter alone removes them', async () => {
    const keep = fakeServer({ 'a.test': 'unknown' });
    keep.unlisted = ['google.com'];
    const op = operator();
    keep.onPoll = (poll) => {
      if (poll === 0) op.enter();
    };
    const kept = await run(keep, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS], {
      op,
      answers: ['n'],
    });
    expect(kept.code).toBe(0);
    expect(kept.prompts).toEqual(['Remove these sign-ins? [Y/n] ']);
    expect(keep.calls.at(-1)?.body).toEqual({});

    const remove = fakeServer({ 'a.test': 'unknown' });
    remove.unlisted = ['google.com', 'gstatic.com'];
    const op2 = operator();
    remove.onPoll = (poll) => {
      if (poll === 0) op2.enter();
    };
    await run(remove, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS], {
      op: op2,
      answers: [''],
    });
    expect(remove.calls.at(-1)?.body).toEqual({ remove_sign_ins: ['google.com', 'gstatic.com'] });
  });

  it('finishes without Enter once every site is signed in (exit 0)', async () => {
    const server = fakeServer({ 'a.test': 'unknown' });
    server.onPoll = (poll) => {
      if (poll === 1) server.sites.set('a.test', 'signed_in');
    };
    const result = await run(server, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(paths(server).some((p) => p.endsWith('/confirm'))).toBe(false);
    expect(paths(server).at(-1)).toBe(`POST ${BASE}/${ID}/recording/finish`);
    expect(result.stdout).toContain('a.test  ✓ signed in');
  });

  it('prints the other states while waiting', async () => {
    const server = fakeServer({ 'a.test': 'unknown', 'bb.test': 'unknown' });
    server.onPoll = (poll) => {
      if (poll === 1) {
        server.sites.set('a.test', 'challenged');
        server.sites.set('bb.test', 'inconclusive');
      }
      if (poll === 2) server.sites.set('a.test', 'signed_out');
      if (poll === 3) {
        server.sites.set('a.test', 'signed_in');
        server.sites.set('bb.test', 'signed_in');
      }
    };
    const result = await run(server, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    for (const line of [
      'a.test   ! check needed',
      "bb.test  ? couldn't tell",
      'a.test   ✗ signed out',
      'bb.test  ✓ signed in',
    ]) {
      expect(result.stdout).toContain(line);
    }
  });

  it('at --timeout the template stays in setup: hint, exit 2, no finish', async () => {
    const server = fakeServer({ 'a.test': 'unknown' });
    const op = operator();
    const result = await run(
      server,
      ['create', 'job-hunt', '--sites', 'a.test', '--timeout', '5s', ...URL_FLAGS],
      { op },
    );
    expect(result.code).toBe(2);
    expect(op.slept).toEqual([2000, 2000, 1000]);
    expect(result.stderr).toContain('Timed out after 5s; template job-hunt stays in setup.');
    expect(result.stderr).toContain('browserhive templates finish job-hunt');
    expect(paths(server).some((p) => p.includes('/confirm') || p.endsWith('/finish'))).toBe(false);
  });

  it('Ctrl+C leaves the recording open: hint, exit 1, no finish', async () => {
    const server = fakeServer({ 'a.test': 'unknown' });
    const op = operator();
    server.onPoll = (poll) => {
      if (poll === 1) op.interrupt();
    };
    const result = await run(server, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS], {
      op,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the sign-in window stays open');
    expect(result.stderr).toContain('browserhive templates finish job-hunt');
    expect(paths(server).some((p) => p.endsWith('/finish') || p.includes('confirm'))).toBe(false);
  });

  it('a refused recording keeps the template and exits 1', async () => {
    const server = fakeServer({ 'a.test': 'unknown' });
    server.startFails = { status: 409, code: 'TEMPLATE_DISABLED' };
    const result = await run(server, ['create', 'job-hunt', '--sites', 'a.test', ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[TEMPLATE_DISABLED] no display');
    expect(result.stderr).toContain('Template job-hunt was created and stays in setup');
  });

  it('--json prints only the final result', async () => {
    const server = fakeServer({ 'a.test': 'unknown', 'b.test': 'unknown' });
    server.unlisted = ['google.com'];
    server.refuse.add('b.test');
    const op = operator();
    server.onPoll = (poll) => {
      if (poll === 0) op.enter();
    };
    const result = await run(
      server,
      ['create', 'job-hunt', '--sites', 'a.test,b.test', '--json', ...URL_FLAGS],
      { op, answers: ['n'] },
    );
    expect(result.code).toBe(2);
    expect(result.prompts).toEqual([]);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['template', 'version', 'sites', 'removed_sign_ins']);
    expect(json['removed_sign_ins']).toEqual(['google.com']);
    expect(json['version']).toBeNull();
    expect((json['sites'] as TemplateSiteView[]).map((s) => s.health.state)).toEqual([
      'signed_in',
      'signed_out',
    ]);
  });
});

describe('templates finish', () => {
  it('resolves the name, confirms the unsigned sites and finishes (exit 0)', async () => {
    const server = fakeServer({ 'a.test': 'signed_in', 'b.test': 'unknown' });
    const result = await run(server, ['finish', 'job-hunt', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(paths(server)).toEqual([
      `GET ${BASE}?sort=name&dir=asc&limit=500`,
      `GET ${BASE}/${ID}`,
      `POST ${BASE}/${ID}/recording/confirm`,
      `GET ${BASE}/${ID}`,
      `POST ${BASE}/${ID}/recording/finish`,
    ]);
    expect(server.calls[2]?.body).toEqual({ site_id: 'b.test' });
    expect(result.stdout).toContain('template job-hunt is ready');
  });

  it('exits 2 when a site is not signed in, 1 for an unknown name or another error', async () => {
    const server = fakeServer({ 'a.test': 'unknown' });
    server.refuse.add('a.test');
    const unsigned = await run(server, ['finish', 'job-hunt', ...URL_FLAGS]);
    expect(unsigned.code).toBe(2);
    expect(unsigned.stdout).toContain('a.test  ✗ not signed in');

    const unknown = await run(fakeServer({}), ['finish', 'nope', ...URL_FLAGS]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("no session template named 'nope'");

    const broken = fakeServer({ 'a.test': 'unknown' });
    const failing = await cliHarness({
      argv: ['templates', 'finish', 'job-hunt', ...URL_FLAGS],
      http: async (url, init) => {
        if (url.endsWith('/confirm')) {
          const body = JSON.stringify(problem(500, 'INTERNAL_ERROR', 'boom'));
          return { status: 500, json: async () => JSON.parse(body), text: async () => body };
        }
        return http(broken)(url, init);
      },
    });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain('boom');
    expect(paths(broken).some((p) => p.endsWith('/finish'))).toBe(false);
  });
});

describe('templates list: empty', () => {
  it('points to templates create', async () => {
    const result = await cliHarness({
      argv: ['templates', 'list', ...URL_FLAGS],
      http: async () => {
        const body = JSON.stringify(listPage([]));
        return { status: 200, json: async () => JSON.parse(body), text: async () => body };
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('browserhive templates create <name> --sites <site,…>');
  });
});
