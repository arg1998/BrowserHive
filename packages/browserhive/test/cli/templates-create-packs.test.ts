/** @module test/cli/templates-create-packs.test — `templates create --sites` shows the site pack of each site and sends the reviewed `pack_sha256`, confirming on a terminal or with `--yes`; nothing is created when the operator does not approve (spec 13 §9.6 first use, D-67; review S-M4) */
import { describe, expect, it } from 'bun:test';
import { problem as packProblem, packView, SHA_A } from './sitepacks-fakes.ts';
import { BASE, created, fakeServer, run, URL_FLAGS } from './template-fakes.ts';

const offered = () =>
  packView({
    approved: null,
    pending: [],
    used_by: [],
    offer: {
      version: 3,
      sha256: SHA_A,
      source: 'bundled',
      provenance: { kind: 'bundled', release: '0.3.0' },
    },
  });

const create = ['create', 'job-hunt', '--sites', 'linkedin.com,a.test', '--noLogin'];

describe('templates create with site packs', () => {
  it('without a terminal refuses unless --yes, after printing the pack; nothing is created', async () => {
    const server = fakeServer({ 'linkedin.com': 'unknown', 'a.test': 'unknown' });
    server.packs = [offered()];
    const result = await run(server, [...create, ...URL_FLAGS]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('linkedin.com  LinkedIn v3 · bundled with BrowserHive 0.3.0');
    expect(result.stdout).toContain(`SHA-256 ${SHA_A}`);
    expect(result.stderr).toContain('adding these sites approves the site packs linkedin.com');
    expect(created(server)).toBeUndefined();
  });

  it('--yes sends the reviewed SHA-256 with the site its pack covers, only there', async () => {
    const server = fakeServer({ 'linkedin.com': 'unknown', 'a.test': 'unknown' });
    server.packs = [offered()];
    const result = await run(server, [...create, '--yes', ...URL_FLAGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("the site's terms prohibit automated access");
    expect(result.stdout).toContain('writes: confirm by default');
    expect(created(server)?.body).toMatchObject({
      sites: [{ site_id: 'linkedin.com', pack_sha256: SHA_A }, { site_id: 'a.test' }],
    });
  });

  it('on a terminal asks; "yes" creates, anything else aborts', async () => {
    const yes = fakeServer({ 'linkedin.com': 'unknown' });
    yes.packs = [offered()];
    const ok = await run(
      yes,
      ['create', 'job-hunt', '--sites', 'linkedin.com', '--noLogin', ...URL_FLAGS],
      {
        answers: ['yes'],
      },
    );
    expect(ok.code).toBe(0);
    expect(ok.prompts).toEqual(['Type yes to approve and create the template: ']);
    expect(created(yes)).toBeDefined();
    const no = fakeServer({ 'linkedin.com': 'unknown' });
    no.packs = [offered()];
    const aborted = await run(
      no,
      ['create', 'job-hunt', '--sites', 'linkedin.com', '--noLogin', ...URL_FLAGS],
      {
        answers: ['no'],
      },
    );
    expect(aborted.code).toBe(1);
    expect(aborted.stdout).toContain('Aborted — nothing was created.');
    expect(created(no)).toBeUndefined();
  });

  it('an already approved pack needs no confirmation and sends its approved SHA-256', async () => {
    const server = fakeServer({ 'www.linkedin.com': 'unknown' });
    server.packs = [packView()];
    const result = await run(server, [
      'create',
      'job-hunt',
      '--sites',
      'www.linkedin.com',
      '--noLogin',
      ...URL_FLAGS,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already approved');
    expect(created(server)?.body).toMatchObject({
      sites: [{ site_id: 'www.linkedin.com', pack_sha256: SHA_A }],
    });
  });

  it('a pack with no write guards says the write policy has no effect yet', async () => {
    const server = fakeServer({ 'linkedin.com': 'unknown' });
    server.packs = [packView({ write_guards: 0 })];
    const result = await run(server, [
      'create',
      'job-hunt',
      '--sites',
      'linkedin.com',
      '--noLogin',
      ...URL_FLAGS,
    ]);
    expect(result.stdout).toContain(
      'no write guards: the write policy has no effect for this pack yet',
    );
  });

  it('pack strings are printed without control characters', async () => {
    const server = fakeServer({ 'linkedin.com': 'unknown' });
    server.packs = [packView({ title: 'Linked\u001b[8mIn‮' })];
    const result = await run(server, [
      'create',
      'job-hunt',
      '--sites',
      'linkedin.com',
      '--noLogin',
      ...URL_FLAGS,
    ]);
    expect(result.stdout).toContain('Linked�[8mIn�');
  });

  it('a catalog that cannot be read stops before anything is created', async () => {
    const server = fakeServer({ 'linkedin.com': 'unknown' });
    server.routes = (method, path) =>
      method === 'GET' && path === '/api/v1/site-packs'
        ? [403, packProblem(403, 'FORBIDDEN', 'Missing scope sitepacks:read.')]
        : undefined;
    const result = await run(server, [
      'create',
      'job-hunt',
      '--sites',
      'linkedin.com',
      '--noLogin',
      ...URL_FLAGS,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('templates create needs them (scope sitepacks:read)');
    expect(server.calls.some((c) => c.method === 'POST' && c.path === BASE)).toBe(false);
  });
});
