/** @module app/templates/template-service.test — templates as data: creation with its validation and defaults, the operator list, read and delete, and the agent list and launch gate (spec 13 §2, §5.1–§5.3, §6.1, §11.1). */

import { beforeEach, describe, expect, it } from 'bun:test';
import { ERROR_REGISTRY, renderMessage } from '@browserhive/contracts/errors';
import { TemplateInput, TemplatesQuery } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import {
  createTemplateKit,
  FakeTemplateRuntime,
  type TemplateKit,
} from '../../../test/helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { CreateSessionInput } from '../../domain/session/create-request.ts';
import type { Session } from '../../domain/session/session.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { ListAllOptions } from '../../ports/persistence/templates.ts';
import type { TemplateServiceConfig } from './template-service.ts';

const CALLER = {
  principal: { subject: 'p-agent' },
  client: { name: 'c', version: null, agentName: null, model: null, harness: 'claude-code' },
};
const LAUNCH: CreateSessionInput = {
  slug: 'jobs',
  channel: 'chromium',
  incognito: false,
  headless: true,
  disableEvaluate: false,
  vaultEnabled: true,
};

let clock: FakeClock;
let logger: CollectingLogger;
let runtime: FakeTemplateRuntime;
let kit: TemplateKit;

function build(config: Partial<TemplateServiceConfig> = {}): TemplateKit {
  return createTemplateKit({ clock, ids: new FakeIdGenerator(), logger, runtime, config });
}

beforeEach(() => {
  clock = new FakeClock();
  logger = new CollectingLogger();
  runtime = new FakeTemplateRuntime();
  kit = build();
});

function input(overrides: Record<string, unknown> = {}): TemplateInput {
  return TemplateInput.parse({
    name: 'job-hunt',
    sites: [{ site_id: 'www.site-a.test' }],
    ...overrides,
  });
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
}

async function seedReady(overrides: Parameters<typeof templateRecord>[0] = {}): Promise<void> {
  const template = templateRecord(overrides);
  await kit.repos.templates.insert(template);
  await kit.repos.templateSites.upsert(templateSiteRecord({ templateId: template.templateId }));
}

describe('TemplateService.create', () => {
  it('creates a recording template with its sites reduced to registrable domains and defaults', async () => {
    const created = await kit.service.create(
      input({
        sites: [
          { site_id: 'www.site-a.test' },
          { site_id: 'jobs.site-b.test', write_policy: 'confirm' },
        ],
      }),
      'local',
    );
    expect(created).toMatchObject({
      name: 'job-hunt',
      display_name: 'job-hunt',
      description: '',
      status: 'recording',
      owner: 'local',
      channel: 'chromium',
      headless: false,
      stealth: 'standard',
      fingerprint: false,
      humanize: false,
      proxy: null,
      agent_windows: 'normal',
      identity_observed: null,
      current_version: null,
      version: 1,
      policy: {
        authorized_principals: ['local'],
        max_concurrent: 5,
        health_interval_ms: 21_600_000,
        prelaunch_check: true,
        unseal: {
          cookie_values: false,
          evaluate: false,
          cookie_writes: false,
          state_export: false,
        },
      },
    });
    expect(created.template_id).toMatch(/^tp-[A-Za-z0-9_-]{10}$/);
    expect(created.policy.harnesses).toBeUndefined();
    expect(created.sites.map((s) => [s.site_id, s.write_policy, s.health.state])).toEqual([
      ['site-a.test', null, 'unknown'],
      ['site-b.test', 'confirm', 'unknown'],
    ]);
    expect(created.identity).toEqual({
      seed: expect.stringMatching(/^.{21}$/),
      locale: 'en-US',
      languages: ['en-US', 'en'],
      timezone_id: 'UTC',
      country_code: 'US',
    });
    expect(kit.actions.rows.map((r) => [r.action, r.resourceKind, r.resourceId])).toEqual([
      ['template.create', 'template', created.template_id],
    ]);
  });

  it('pins an explicit locale, time zone and coordinates', async () => {
    const created = await kit.service.create(
      input({
        locale: 'de-DE',
        timezone_id: 'Europe/Berlin',
        geolocation: { latitude: 52.5, longitude: 13.4 },
      }),
      'local',
    );
    expect(created.identity).toMatchObject({
      locale: 'de-DE',
      languages: ['de-DE', 'de'],
      country_code: 'DE',
      timezone_id: 'Europe/Berlin',
      geolocation: { latitude: 52.5, longitude: 13.4 },
    });
  });

  it('derives fingerprint and humanize from the stealth level as sessions do', async () => {
    const max = await kit.service.create(input({ name: 'max-one', stealth: 'max' }), 'local');
    expect([max.fingerprint, max.humanize]).toEqual([true, false]);
    const off = await kit.service.create(
      input({ name: 'off-one', stealth: 'off', fingerprint: true, humanize: true }),
      'local',
    );
    expect([off.fingerprint, off.humanize]).toEqual([false, false]);
  });

  it('stores a proxy without credentials, labelled by its host', async () => {
    const created = await kit.service.create(
      input({
        proxy: { server: 'http://proxy.test:8080', username: 'u', password_env: 'JOB_PROXY' },
        locale: 'en-CA',
        timezone_id: 'America/Toronto',
      }),
      'local',
    );
    expect(created.proxy).toEqual({
      server: 'http://proxy.test:8080',
      bypass: null,
      username: 'u',
      password_env: 'JOB_PROXY',
      label: 'proxy.test:8080',
    });
  });

  it('refuses with field-level issues what the schema cannot express', async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ sites: [{ site_id: '127.0.0.1' }] }, 'sites.0.site_id', 'not_registrable'],
      [{ sites: [{ site_id: 'co.uk' }] }, 'sites.0.site_id', 'not_registrable'],
      [
        { sites: [{ site_id: 'a.github.io' }, { site_id: 'b.github.io' }] },
        'sites.1.site_id',
        'duplicate_site',
      ],
      [
        {
          proxy: { server: 'http://user:pass@proxy.test:8080' },
          locale: 'en-CA',
          timezone_id: 'UTC',
        },
        'proxy.server',
        'proxy_credentials_inline',
      ],
      [
        { proxy: { server: 'ftp://proxy.test:21' }, locale: 'en-CA', timezone_id: 'UTC' },
        'proxy.server',
        'invalid_proxy',
      ],
      [
        { proxy: { server: 'http://proxy.test:8080' }, timezone_id: 'UTC' },
        'locale',
        'required_with_proxy',
      ],
      [
        { proxy: { server: 'http://proxy.test:8080' }, locale: 'en-CA' },
        'timezone_id',
        'required_with_proxy',
      ],
      [{ timezone_id: 'Mars/Olympus' }, 'timezone_id', 'invalid_timezone'],
      [
        { policy: { authorized_principals: ['p-bot', 'browserhive'] } },
        'policy.authorized_principals.1',
        'reserved',
      ],
      [
        { policy: { authorized_principals: ['template:tp-0000000001'] } },
        'policy.authorized_principals.0',
        'reserved',
      ],
      [
        { policy: { unseal: { evaluate: true, principals: ['System'] } } },
        'policy.unseal.principals.0',
        'reserved',
      ],
    ];
    for (const [overrides, path, code] of cases) {
      const error = await refusal(kit.service.create(input(overrides), 'local'));
      expect(isAppError(error, 'VALIDATION_FAILED')).toBe(true);
      if (isAppError(error, 'VALIDATION_FAILED')) {
        expect(error.details.issues.map((i) => [i.path, i.code])).toContainEqual([path, code]);
      }
    }
    expect(await kit.repos.templates.count()).toBe(0);
  });

  it('a password_env starting with BROWSERHIVE_ never passes the schema (D-33)', () => {
    const parsed = TemplateInput.safeParse({
      name: 'job-hunt',
      sites: [{ site_id: 'site-a.test' }],
      proxy: { server: 'http://p.test:1', password_env: 'BROWSERHIVE_X' },
    });
    expect(parsed.success).toBe(false);
  });

  it('under auth=off an omitted access is local, an explicit [] stays every principal', async () => {
    const implicit = await kit.service.create(input(), 'local');
    expect(implicit.policy.authorized_principals).toEqual(['local']);
    const explicit = await kit.service.create(
      input({ name: 'open-one', policy: { authorized_principals: [] } }),
      'local',
    );
    expect(explicit.policy.authorized_principals).toEqual([]);
    // Every caller under auth=off is local, so both are listed to it.
    await kit.repos.templates.update(implicit.template_id, { status: 'ready' });
    const listed = await kit.service.listForAgent({
      principal: { subject: 'local' },
      client: null,
    });
    expect(listed.map((t) => t.name)).toEqual(['job-hunt']);
    // A token principal (after a switch to auth=token) does not reach the implicit one.
    await kit.repos.templates.update(explicit.template_id, { status: 'ready' });
    const token = await kit.service.listForAgent({ principal: { subject: 'p-bot' }, client: null });
    expect(token.map((t) => t.name)).toEqual(['open-one']);
  });

  it('under auth=token an explicit access choice is required; [] is a choice', async () => {
    kit = build({ authMode: 'token' });
    const error = await refusal(kit.service.create(input(), 'local'));
    expect(isAppError(error, 'VALIDATION_FAILED')).toBe(true);
    if (isAppError(error, 'VALIDATION_FAILED')) {
      expect(error.details.issues[0]?.path).toBe('policy.authorized_principals');
    }
    const created = await kit.service.create(
      input({ policy: { authorized_principals: [] } }),
      'local',
    );
    expect(created.policy.authorized_principals).toEqual([]);
  });

  it('refuses a taken name', async () => {
    await kit.service.create(input(), 'local');
    const error = await refusal(kit.service.create(input(), 'local'));
    expect(isAppError(error, 'TEMPLATE_NAME_TAKEN')).toBe(true);
    if (isAppError(error, 'TEMPLATE_NAME_TAKEN')) {
      expect(error.publicMessage).toBe("A session template named 'job-hunt' already exists.");
    }
  });
});

describe('TemplateService.list and get', () => {
  const query = (q: Record<string, unknown> = {}) => TemplatesQuery.parse(q);

  it('lists summaries with facets, filters and keyset pages', async () => {
    for (const name of ['alpha', 'bravo', 'charlie']) {
      await kit.service.create(input({ name }), 'local');
      await clock.advance(1_000);
    }
    const first = await kit.service.list(query({ sort: 'name', dir: 'asc', limit: '2' }));
    expect(first.data.map((t) => t.name)).toEqual(['alpha', 'bravo']);
    expect(first.data[0]).toMatchObject({
      status: 'recording',
      host: { state: 'stopped', since: null, pages: 0 },
      in_use: 0,
      cap: 5,
      sealed: true,
      sites: [{ site_id: 'site-a.test', title: 'site-a.test', health_state: 'unknown' }],
    });
    expect(first.facets.status).toEqual([{ value: 'recording', count: 3 }]);
    expect(first.page.next_cursor).not.toBeNull();
    const second = await kit.service.list(
      query({ sort: 'name', dir: 'asc', limit: '2', cursor: first.page.next_cursor ?? '' }),
    );
    expect(second.data.map((t) => t.name)).toEqual(['charlie']);
    expect(second.page.next_cursor).toBeNull();
    const newest = await kit.service.list(query({ sort: 'created_at' }));
    expect(newest.data.map((t) => t.name)).toEqual(['charlie', 'bravo', 'alpha']);
    const filtered = await kit.service.list(query({ q: 'BRAV', status: 'recording' }));
    expect(filtered.data.map((t) => t.name)).toEqual(['bravo']);
    expect((await kit.service.list(query({ site: 'site-b.test' }))).data).toEqual([]);
    // `?site=` reduces a host like creation does.
    const byHost = await kit.service.list(query({ site: 'www.site-a.test' }));
    expect(byHost.data).toHaveLength(3);
    expect(byHost.applied.filters).toEqual({ site: 'site-a.test' });
    const bad = await refusal(kit.service.list(query({ cursor: 'nope' })));
    expect(isAppError(bad, 'VALIDATION_FAILED')).toBe(true);
  });

  it('reads one template with its host view; unknown ids are TEMPLATE_NOT_FOUND', async () => {
    const created = await kit.service.create(input(), 'local');
    runtime.sessions.set(created.template_id, ['jobs-11111111']);
    runtime.hosts.set(created.template_id, { state: 'running', since: 5, pages: 3 });
    const detail = await kit.service.get(created.template_id);
    expect(detail).toMatchObject({
      template: { template_id: created.template_id },
      host: { state: 'running', since: 5, pages: 3, parked_pages: 0, sandboxed: null },
      sessions_live: 1,
      parked_pages: [],
      shared_windows: [],
      unlisted_domains: [],
    });
    expect(isAppError(await refusal(kit.service.get('tp-unknown000')), 'TEMPLATE_NOT_FOUND')).toBe(
      true,
    );
  });
});

describe('TemplateService.remove', () => {
  it('refuses while sessions are live, then force closes them and deletes everything', async () => {
    const created = await kit.service.create(input(), 'local');
    const id = created.template_id;
    runtime.sessions.set(id, ['jobs-11111111', 'jobs-22222222']);
    kit.files.bytes.set(id, 4096);
    const busy = await refusal(kit.service.remove(id, { force: false, by: 'local' }));
    expect(isAppError(busy, 'TEMPLATE_IN_USE')).toBe(true);
    if (isAppError(busy, 'TEMPLATE_IN_USE')) {
      expect(busy.details).toEqual({ template_id: id, live_sessions: 2 });
    }
    expect(await kit.repos.templates.count()).toBe(1);
    const done = await kit.service.remove(id, { force: true, by: 'local' });
    expect(done).toEqual({
      ok: true,
      closed_sessions: ['jobs-11111111', 'jobs-22222222'],
      deleted_bytes: 4096,
    });
    expect(runtime.shutdowns).toEqual([id]);
    expect(kit.files.removed).toEqual([id]);
    expect(await kit.repos.templates.count()).toBe(0);
    expect(await kit.repos.templateSites.list(id)).toEqual([]);
    expect(kit.actions.rows.at(-1)).toMatchObject({ action: 'template.delete', resourceId: id });
  });

  it('a template without sessions is deleted without force; unknown ids are TEMPLATE_NOT_FOUND', async () => {
    const created = await kit.service.create(input(), 'local');
    expect((await kit.service.remove(created.template_id, { force: false, by: 'local' })).ok).toBe(
      true,
    );
    expect(
      isAppError(
        await refusal(kit.service.remove(created.template_id, { force: false, by: 'local' })),
        'TEMPLATE_NOT_FOUND',
      ),
    ).toBe(true);
  });
});

describe('TemplateService.remove during an operation (review #79 H-1)', () => {
  it('answers CONFLICT while a restore, seed or clearing of saved passwords holds the template', async () => {
    const ops = new FakeTemplateHostOps();
    kit = createTemplateKit({ clock, ids: new FakeIdGenerator(), logger, runtime, ops });
    const created = await kit.service.create(input(), 'local');
    ops.holds.add(created.template_id);
    const busy = await refusal(
      kit.service.remove(created.template_id, { force: true, by: 'local' }),
    );
    expect(isAppError(busy, 'CONFLICT')).toBe(true);
    expect(runtime.shutdowns).toEqual([]);
    expect(await kit.repos.templates.count()).toBe(1);
    ops.holds.delete(created.template_id);
    expect((await kit.service.remove(created.template_id, { force: true, by: 'local' })).ok).toBe(
      true,
    );
    // The delete held the template while it ran, and released it.
    expect(ops.holds.size).toBe(0);
  });
});

describe('TemplateService.listForAgent', () => {
  it('lists only templates the caller may launch, sorted, with agent-safe fields', async () => {
    await seedReady({ templateId: 'tp-zulu000001', name: 'zulu' });
    await seedReady({ templateId: 'tp-alpha00001', name: 'alpha', description: 'A' });
    await seedReady({ templateId: 'tp-setup00001', name: 'setup', status: 'recording' });
    await seedReady({ templateId: 'tp-other00001', name: 'other', authorizedPrincipals: ['p-x'] });
    await seedReady({ templateId: 'tp-codex00001', name: 'codex', harnesses: ['codex'] });
    await seedReady({ templateId: 'tp-off0000001', name: 'off', status: 'disabled' });
    await kit.repos.templateSites.upsert(
      templateSiteRecord({ templateId: 'tp-alpha00001', siteId: 'hidden.test', enabled: false }),
    );
    const listed = await kit.service.listForAgent(CALLER);
    expect(listed.map((t) => [t.name, t.availability])).toEqual([
      ['alpha', 'available'],
      ['off', 'unavailable'],
      ['zulu', 'available'],
    ]);
    expect(listed[0]).toEqual({
      name: 'alpha',
      display_name: 'Job hunt',
      description: 'A',
      sites: [{ site: 'site-a.test', title: 'site-a.test', status: 'unknown', checked_at: null }],
      availability: 'available',
      sealed: true,
    });
  });

  it('reports sealed per caller and nothing under templates=false', async () => {
    await seedReady({
      unseal: {
        cookieValues: true,
        evaluate: true,
        cookieWrites: true,
        stateExport: true,
        principals: ['p-agent'],
      },
    });
    expect((await kit.service.listForAgent(CALLER))[0]?.sealed).toBe(false);
    expect(
      (await kit.service.listForAgent({ ...CALLER, principal: { subject: 'p-b' } }))[0]?.sealed,
    ).toBe(true);
    kit = build({ enabled: false });
    await seedReady();
    expect(await kit.service.listForAgent(CALLER)).toEqual([]);
  });
});

describe('TemplateService.launch', () => {
  const notFound = (name: string) =>
    renderMessage(ERROR_REGISTRY.TEMPLATE_NOT_FOUND.message, { template: name });

  it('answers unknown, unauthorized, still-recording and disabled-feature launches identically', async () => {
    await seedReady({ templateId: 'tp-other00001', name: 'other', authorizedPrincipals: ['p-x'] });
    await seedReady({ templateId: 'tp-codex00001', name: 'codex', harnesses: ['codex'] });
    await seedReady({ templateId: 'tp-setup00001', name: 'setup', status: 'recording' });
    for (const name of ['nope', 'other', 'codex', 'setup']) {
      const error = await refusal(kit.service.launch(name, LAUNCH, CALLER));
      expect(isAppError(error, 'TEMPLATE_NOT_FOUND')).toBe(true);
      if (isAppError(error, 'TEMPLATE_NOT_FOUND')) {
        expect(error.details).toEqual({ template: name });
        expect(error.publicMessage).toBe(notFound(name));
      }
    }
    // The operator sees the real reason in the log, never the agent.
    const refused = logger.records.filter((r) => r.msg === 'template launch refused');
    expect(refused.map((r) => r.fields['reason'])).toEqual([
      'principal_not_allowed',
      'harness_not_allowed',
      'recording',
    ]);
    expect(runtime.launches).toEqual([]);
    kit = build({ enabled: false });
    await seedReady();
    expect(
      isAppError(
        await refusal(kit.service.launch('job-hunt', LAUNCH, CALLER)),
        'TEMPLATE_NOT_FOUND',
      ),
    ).toBe(true);
  });

  it('refuses a disabled template with TEMPLATE_DISABLED', async () => {
    await seedReady({ status: 'disabled' });
    const error = await refusal(kit.service.launch('job-hunt', LAUNCH, CALLER));
    expect(isAppError(error, 'TEMPLATE_DISABLED')).toBe(true);
    if (isAppError(error, 'TEMPLATE_DISABLED')) {
      expect(error.details).toEqual({ template: 'job-hunt', reason: 'disabled' });
      expect(error.publicMessage).toBe(
        "Template 'job-hunt' cannot be used until the operator fixes it.",
      );
    }
  });

  it('refuses fixed options with INVALID_ARGUMENTS naming each, after the access check', async () => {
    await seedReady();
    const error = await refusal(
      kit.service.launch(
        'job-hunt',
        { ...LAUNCH, launchOptions: { args: [] }, contextOptions: { locale: 'en-CA' } },
        CALLER,
      ),
    );
    expect(isAppError(error, 'INVALID_ARGUMENTS')).toBe(true);
    if (isAppError(error, 'INVALID_ARGUMENTS')) {
      expect(error.details.issues.map((i) => i.path)).toEqual([
        'launch_options.args',
        'context_options.locale',
      ]);
      expect(error.publicMessage).toBe(
        "launch_options.args: template 'job-hunt' fixes launch_options.args; omit it",
      );
    }
    const hidden = await refusal(
      kit.service.launch('nope', { ...LAUNCH, launchOptions: { args: [] } }, CALLER),
    );
    expect(isAppError(hidden, 'TEMPLATE_NOT_FOUND')).toBe(true);
  });

  it('hands an accepted launch to the runtime with the sealing and settings', async () => {
    await seedReady();
    const session = { id: 'jobs-12345678' } as unknown as Session;
    runtime.onLaunch = () => Promise.resolve(session);
    expect(await kit.service.launch('job-hunt', { ...LAUNCH, humanize: true }, CALLER)).toBe(
      session,
    );
    expect(runtime.launches).toHaveLength(1);
    expect(runtime.launches[0]).toMatchObject({
      template: { name: 'job-hunt' },
      sites: [{ siteId: 'site-a.test' }],
      principal: { subject: 'p-agent' },
      sealed: true,
      sealing: { hideCookieValues: true, forceDisableEvaluate: true },
      settings: { disableEvaluate: true, humanize: true, contextOptions: {} },
    });
  });

  it('without hosts (before T1a-2) a launch answers TEMPLATE_UNAVAILABLE', async () => {
    await seedReady();
    const error = await refusal(kit.service.launch('job-hunt', LAUNCH, CALLER));
    expect(isAppError(error, 'TEMPLATE_UNAVAILABLE')).toBe(true);
    if (isAppError(error, 'TEMPLATE_UNAVAILABLE')) {
      expect(error.details).toEqual({
        template: 'job-hunt',
        reason: 'starting',
        retry_after_ms: 5000,
      });
    }
  });
});

describe('TemplateService delete and launch exclusion', () => {
  /** A launch that stays in flight until `finish` is called. */
  function holdLaunches(): { finish: () => void } {
    let finish: () => void = () => undefined;
    runtime.onLaunch = () =>
      new Promise<Session>((_, reject) => {
        finish = () => {
          reject(new Error('host gone'));
        };
      });
    return { finish: () => finish() };
  }

  async function launchStarted(): Promise<void> {
    while (runtime.launches.length === 0) await Promise.resolve();
  }

  it('a delete refuses a launch in flight with TEMPLATE_IN_USE', async () => {
    await seedReady();
    const held = holdLaunches();
    const launching = kit.service.launch('job-hunt', LAUNCH, CALLER).catch((e: unknown) => e);
    await launchStarted();
    const busy = await refusal(kit.service.remove('tp-fixture001', { force: false, by: 'local' }));
    expect(isAppError(busy, 'TEMPLATE_IN_USE')).toBe(true);
    if (isAppError(busy, 'TEMPLATE_IN_USE')) expect(busy.details.live_sessions).toBe(1);
    held.finish();
    await launching;
    expect(await kit.repos.templates.count()).toBe(1);
  });

  it('a forced delete waits for the launch to settle, and later launches find nothing', async () => {
    await seedReady();
    const held = holdLaunches();
    const launching = kit.service.launch('job-hunt', LAUNCH, CALLER).catch((e: unknown) => e);
    await launchStarted();
    let deleted = false;
    const removing = kit.service.remove('tp-fixture001', { force: true, by: 'local' }).then((r) => {
      deleted = true;
      return r;
    });
    // While the delete waits, a new launch is refused as if the template were gone.
    const late = await refusal(kit.service.launch('job-hunt', LAUNCH, CALLER));
    expect(isAppError(late, 'TEMPLATE_NOT_FOUND')).toBe(true);
    await Promise.resolve();
    expect(deleted).toBe(false);
    expect(runtime.shutdowns).toEqual([]);
    held.finish();
    await launching;
    expect((await removing).ok).toBe(true);
    expect(runtime.shutdowns).toEqual(['tp-fixture001']);
    expect(runtime.launches).toHaveLength(1);
  });

  it('a second delete while one runs is a CONFLICT', async () => {
    await seedReady();
    const held = holdLaunches();
    const launching = kit.service.launch('job-hunt', LAUNCH, CALLER).catch((e: unknown) => e);
    await launchStarted();
    const first = kit.service.remove('tp-fixture001', { force: true, by: 'local' });
    const second = await refusal(kit.service.remove('tp-fixture001', { force: true, by: 'local' }));
    expect(isAppError(second, 'CONFLICT')).toBe(true);
    held.finish();
    await launching;
    expect((await first).ok).toBe(true);
  });
});

describe('TemplateService unreadable rows', () => {
  it('list_templates skips an unreadable row, logs and records a degradation; a clean list recovers', async () => {
    await seedReady({ templateId: 'tp-good000001', name: 'good' });
    await seedReady({ templateId: 'tp-bad0000001', name: 'bad' });
    const templates = kit.repos.templates;
    const original = templates.listAll.bind(templates);
    templates.listAll = async (options?: ListAllOptions) => {
      const all = await original();
      return all.filter((t) => {
        if (t.templateId !== 'tp-bad0000001') return true;
        options?.onUnreadable?.(t.templateId, new Error('templates.identity_json: invalid json'));
        return false;
      });
    };
    const listed = await kit.service.listForAgent(CALLER);
    expect(listed.map((t) => t.name)).toEqual(['good']);
    expect(kit.degradations.reports).toEqual([
      {
        code: 'TEMPLATE_ROW_UNREADABLE',
        severity: 'warn',
        message:
          "A stored row of template 'tp-bad0000001' cannot be read; agents do not see the template.",
        details: {
          template_id: 'tp-bad0000001',
          table: 'templates',
          reason: 'templates.identity_json: invalid json',
        },
      },
    ]);
    expect(logger.records.some((r) => r.msg === 'template row unreadable')).toBe(true);
    templates.listAll = original;
    await kit.service.listForAgent(CALLER);
    expect(kit.degradations.recoveries).toEqual(['TEMPLATE_ROW_UNREADABLE']);
  });

  it('a template with an unreadable site row is left out of the agent list', async () => {
    await seedReady({ templateId: 'tp-good000001', name: 'good' });
    await seedReady({ templateId: 'tp-bad0000001', name: 'bad' });
    const sites = kit.repos.templateSites;
    const original = sites.listAll.bind(sites);
    sites.listAll = async (options?: ListAllOptions) => {
      const all = await original();
      return all.filter((s) => {
        if (s.templateId !== 'tp-bad0000001') return true;
        options?.onUnreadable?.(s.templateId, new Error('form_json'));
        return false;
      });
    };
    expect((await kit.service.listForAgent(CALLER)).map((t) => t.name)).toEqual(['good']);
    expect(kit.degradations.reports[0]?.details?.['table']).toBe('template_sites');
  });
});

describe('TemplateService.pageCaps', () => {
  it('reads templateMaxPagesPerHost and the template cap', () => {
    expect(
      build({ maxPagesPerHost: 30 }).service.pageCaps(templateRecord({ maxConcurrent: 3 })),
    ).toEqual({
      host: 30,
      perSession: 10,
    });
  });
});
