/** @module interface/mcp/tools/template-refusals.test — a refused agent's view does not change when its refusal is recorded (deferred D60): through the real server and dispatcher, `list_templates` and `launch_session({template})` answer byte for byte what they answer when no template exists, and they return before the refusal is written. */

import { afterEach, describe, expect, it } from 'bun:test';
import { createToolHarness, type ToolHarness } from '../../../../test/helpers/fake-transport.ts';
import { templateRecord, templateSiteRecord } from '../../../../test/persistence/helpers.ts';

const open: ToolHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(template?: Parameters<typeof templateRecord>[0]): Promise<ToolHarness> {
  const h = await createToolHarness();
  open.push(h);
  if (template !== undefined) {
    const record = templateRecord(template);
    await h.templates.repos.templates.insert(record);
    await h.templates.repos.templateSites.upsert(
      templateSiteRecord({ templateId: record.templateId }),
    );
  }
  return h;
}

/** Everything the agent receives from both calls, serialized. */
async function agentView(h: ToolHarness): Promise<string[]> {
  const listed = await h.call('list_templates', {});
  const launched = await h.call('launch_session', { slug: 'jobs', template: 'job-hunt' });
  return [JSON.stringify(listed), JSON.stringify(launched)];
}

describe('a refused agent sees exactly what it sees without the template', () => {
  for (const [label, rule] of [
    ['principal list', { authorizedPrincipals: ['p-someone-else'] }],
    ['harness list', { harnesses: [] as string[] }],
  ] as const) {
    it(`refused by the ${label}`, async () => {
      const refused = await harness(rule);
      const absent = await harness();
      const seen = await agentView(refused);
      // The answers are back while the refusals still wait in the write queue (fire-and-forget).
      expect(refused.templates.queue.depth).toBe(2);
      expect(seen).toEqual(await agentView(absent));
      expect(JSON.parse(seen[0] ?? '')).toMatchObject({ structuredContent: { templates: [] } });
      expect(seen[1]).toContain(
        "[TEMPLATE_NOT_FOUND] No session template named 'job-hunt'. Use list_templates to see the templates you can use.",
      );

      // The operator sees both refusals; nothing was recorded where no template exists.
      const rows = (await refused.templates.refusals.list('tp-fixture001')).data;
      expect(rows.map((r) => r.kind).sort()).toEqual(['launch', 'list']);
      expect(absent.templates.queue.operations).toEqual([]);
    });
  }
});
