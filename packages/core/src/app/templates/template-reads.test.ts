/** @module app/templates/template-reads.test — `publishTemplateChanged` carries the identity providers of the template's sites (spec 13 §8.6, D34): a pack's provider, else the site itself, once each. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { FakeTemplateRuntime } from '../../../test/helpers/template-kit.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { publishTemplateChanged } from './template-reads.ts';

describe('publishTemplateChanged', () => {
  it('names each identity provider of the sites once, with the time it read them', async () => {
    const repos = new InMemoryRepositories();
    const template = templateRecord();
    await repos.templates.insert(template);
    const id = template.templateId;
    await repos.templateSites.upsert(
      templateSiteRecord({ templateId: id, siteId: 'indeed.com', packId: 'indeed' }),
    );
    await repos.templateSites.upsert(
      templateSiteRecord({ templateId: id, siteId: 'glassdoor.com', packId: 'glassdoor' }),
    );
    await repos.templateSites.upsert(templateSiteRecord({ templateId: id, siteId: 'site-a.test' }));
    const bus = new RecordingEventBus<DomainEvents>();
    const clock = new FakeClock();
    const providers: Record<string, string> = { indeed: 'indeed.com', glassdoor: 'indeed.com' };
    publishTemplateChanged(
      {
        repos,
        runtime: new FakeTemplateRuntime(),
        bus,
        clock,
        packs: {
          sitePackOf: () => null,
          strategyNotes: () => [],
          providerOf: (packId) => (packId === null ? null : (providers[packId] ?? null)),
        },
      },
      id,
      new CollectingLogger(),
    );
    for (let i = 0; i < 20 && bus.published.length === 0; i++) await Promise.resolve();
    const payload = bus.published[0]?.payload as DomainEvents['template.changed'] | undefined;
    expect(payload?.template.template_id).toBe(id);
    expect([...(payload?.providers?.ids ?? [])].sort()).toEqual(['indeed.com', 'site-a.test']);
    expect(payload?.providers?.at).toBe(clock.now());
  });
});
