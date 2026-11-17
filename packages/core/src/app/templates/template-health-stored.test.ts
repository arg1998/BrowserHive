/** @module app/templates/template-health-stored.test — a stopped browser is checked from its last checkpoint: no browser start (so no window takes the operator's focus); without a checkpoint the start modes apply. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { JarCookie } from '../../domain/templates/sign-ins.ts';
import { TemplateHealthService } from './template-health.ts';

async function setup(stored: readonly JarCookie[] | null) {
  const repos = new InMemoryRepositories();
  const template = templateRecord({ status: 'ready' });
  await repos.templates.insert(template);
  await repos.templateSites.upsert(templateSiteRecord({ learnedCookieNames: ['sid'] }));
  const starts: string[] = [];
  const health = new TemplateHealthService({
    repos,
    hosts: {
      runningHost: () => null,
      withHost: async () => {
        starts.push('start');
        return [] as never;
      },
      slotFree: () => true,
      storedJar: async () => stored,
    },
    clock: new FakeClock(),
    logger: new CollectingLogger(),
    machine: 'hive-box',
  });
  return { health, starts, id: template.templateId };
}

describe('checks of a stopped browser', () => {
  it('read the last checkpoint and start nothing', async () => {
    const h = await setup([
      { name: 'sid', domain: '.site-a.test', expires: 2_000_000_000, httpOnly: true, secure: true },
    ]);
    const run = await h.health.probe(h.id, { trigger: 'schedule', start: 'if_slot_free' });
    expect(run?.map((r) => r.outcome)).toEqual(['signed_in']);
    expect(h.starts).toEqual([]);
  });

  it('without a checkpoint, start only when the mode allows it', async () => {
    const h = await setup(null);
    expect(await h.health.probe(h.id, { trigger: 'host_start', start: 'never' })).toBeNull();
    await h.health.probe(h.id, { trigger: 'manual', start: 'always' });
    expect(h.starts).toEqual(['start']);
  });
});
