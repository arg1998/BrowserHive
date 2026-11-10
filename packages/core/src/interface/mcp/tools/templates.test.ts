/** @module interface/mcp/tools/templates.test — list_templates and launch_session.template through the real server, dispatcher and schemas (spec 13 §5.1–§5.3, §6.1). The host side is a fake runtime until templates T1a-2. */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../../test/helpers/fake-transport.ts';
import {
  FakeTemplateRuntime,
  sessionInputFromRequest,
} from '../../../../test/helpers/template-kit.ts';
import { executeTool } from '../../../../test/helpers/tool-run.ts';
import { templateRecord, templateSiteRecord } from '../../../../test/persistence/helpers.ts';
import { agentPrincipal } from '../../../domain/auth/principal.ts';
import { serverInstructions, TEMPLATES_INSTRUCTION } from '../server.ts';

let h: ToolHarness;
afterEach(async () => h.close());

async function seed(overrides: Parameters<typeof templateRecord>[0] = {}): Promise<void> {
  const template = templateRecord(overrides);
  await h.templates.repos.templates.insert(template);
  await h.templates.repos.templateSites.upsert(
    templateSiteRecord({ templateId: template.templateId }),
  );
}

describe('list_templates', () => {
  it('lists the templates the caller may launch and nothing else', async () => {
    h = await createToolHarness();
    await seed();
    await seed({ templateId: 'tp-mine000001', name: 'mine', authorizedPrincipals: ['alice'] });
    await seed({ templateId: 'tp-setup00001', name: 'setup', status: 'recording' });
    const { value, result } = await executeTool(h, 'list_templates', {});
    expect(result.isError).toBeFalsy();
    expect(value).toEqual({
      templates: [
        {
          name: 'job-hunt',
          display_name: 'Job hunt',
          description: 'Signed in to the job sites.',
          sites: [
            { site: 'site-a.test', title: 'site-a.test', status: 'unknown', checked_at: null },
          ],
          availability: 'available',
          sealed: true,
        },
      ],
    });
    const alice = await h.connect(agentPrincipal('alice', {}));
    const theirs = await executeTool(h, 'list_templates', {}, alice);
    expect(
      (theirs.value as { templates: { name: string }[] }).templates.map((t) => t.name),
    ).toEqual(['job-hunt', 'mine']);
  });

  it('refuses arguments (strict empty input)', async () => {
    h = await createToolHarness();
    const result = await h.call('list_templates', { name: 'x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toStartWith('[INVALID_ARGUMENTS]');
  });

  it('answers TOOL_NOT_AVAILABLE under templates=false', async () => {
    h = await createToolHarness({ templates: false });
    const result = await h.call('list_templates', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toStartWith('[TOOL_NOT_AVAILABLE]');
  });
});

describe('launch_session with template', () => {
  it('an unknown or foreign template is TEMPLATE_NOT_FOUND with the same text', async () => {
    h = await createToolHarness();
    await seed({ authorizedPrincipals: ['alice'] });
    const texts: string[] = [];
    for (const template of ['nope', 'job-hunt']) {
      const result = await h.call('launch_session', { slug: 'jobs', template });
      expect(result.isError).toBe(true);
      texts.push(textOf(result).replace(template, '<name>'));
    }
    expect(texts[0]).toBe(
      "[TEMPLATE_NOT_FOUND] No session template named '<name>'. Use list_templates to see the templates you can use.",
    );
    expect(texts[1]).toBe(texts[0]);
    expect(h.fakeDriver?.launches).toEqual([]);
  });

  it('refuses fixed options by name and lets the five defaulted parameters pass', async () => {
    h = await createToolHarness();
    await seed();
    const refused = await h.call('launch_session', {
      slug: 'jobs',
      template: 'job-hunt',
      launch_options: { args: ['--foo'] },
      context_options: { locale: 'en-CA', viewport: { width: 800, height: 600 } },
    });
    expect(textOf(refused)).toBe(
      "[INVALID_ARGUMENTS] launch_options.args: template 'job-hunt' fixes launch_options.args; omit it",
    );
    expect(refused.structuredContent).toBeUndefined();
    const passed = await h.call('launch_session', {
      slug: 'jobs',
      template: 'job-hunt',
      channel: 'edge',
      headless: false,
      incognito: true,
      disable_evaluate: true,
      vault_enabled: false,
    });
    // Accepted by the option rules; the harness has no hosts, as the build before T1a-2.
    expect(textOf(passed)).toBe(
      "[TEMPLATE_UNAVAILABLE] Template 'job-hunt' is temporarily unavailable. Retry in a few seconds.",
    );
    expect(h.fakeDriver?.launches).toEqual([]);
  });

  it('launches from the template settings; no raw agent argument reaches the session', async () => {
    const runtime = new FakeTemplateRuntime();
    h = await createToolHarness({ templateRuntime: runtime });
    runtime.onLaunch = (request) =>
      h.services.sessions.create(sessionInputFromRequest(request), request.principal);
    await seed({ channel: 'chrome', headless: false });
    const { value } = await executeTool(h, 'launch_session', {
      slug: 'jobs',
      template: 'job-hunt',
      channel: 'edge',
      headless: true,
      incognito: true,
      vault_enabled: true,
      disable_evaluate: false,
    });
    expect(value).toMatchObject({
      session_id: 'jobs-00000001',
      slug: 'jobs',
      channel: 'chrome',
      headless: false,
      incognito: false,
      vault_enabled: false,
      persistence_mode: 'memory',
      disable_evaluate: true,
    });
    const request = runtime.launches[0];
    expect(request?.template.name).toBe('job-hunt');
    // The port carries no copy of the agent's arguments.
    expect(Object.keys(request ?? {}).sort()).toEqual([
      'client',
      'connectionId',
      'principal',
      'sealed',
      'sealing',
      'settings',
      'sites',
      'slug',
      'template',
    ]);
    const spec = h.fakeDriver?.launches[0];
    expect([spec?.channel, spec?.headless]).toEqual(['chrome', false]);
  });

  it('under templates=false every template name is TEMPLATE_NOT_FOUND', async () => {
    h = await createToolHarness({ templates: false });
    await seed();
    const result = await h.call('launch_session', { slug: 'jobs', template: 'job-hunt' });
    expect(textOf(result)).toStartWith('[TEMPLATE_NOT_FOUND]');
  });

  it('a launch without template is unchanged', async () => {
    h = await createToolHarness();
    await seed();
    const { value } = await executeTool(h, 'launch_session', { slug: 'demo' });
    expect(value).toMatchObject({ session_id: 'demo-00000001' });
    expect((value as Record<string, unknown>)['template']).toBeUndefined();
  });
});

describe('server instructions', () => {
  it('name list_templates only while templates are on', async () => {
    h = await createToolHarness();
    expect(serverInstructions(h.services.runtime)).toContain(TEMPLATES_INSTRUCTION);
    expect(serverInstructions({ ...h.services.runtime, templates: false })).not.toContain(
      'list_templates',
    );
  });
});
