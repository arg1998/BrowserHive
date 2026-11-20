/** @module app/templates/template-reads.test — `publishTemplateChanged` after a site's removal carries its identity provider and the providers left (spec 13 §8.6, D34; review #93 L3): a pack's provider, else the site itself, once each; a plain change carries none. */

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
      // Glassdoor (provider indeed.com) was just removed; indeed.com still uses that provider.
      templateSiteRecord({ templateId: id, siteId: 'glassdoor.com', packId: 'glassdoor' }),
    );
    for (let i = 0; i < 20 && bus.published.length === 0; i++) await Promise.resolve();
    const payload = bus.published[0]?.payload as DomainEvents['template.changed'] | undefined;
    expect(payload?.template.template_id).toBe(id);
    expect(payload?.site_removed?.provider).toBe('indeed.com');
    expect([...(payload?.site_removed?.providers ?? [])].sort()).toEqual([
      'indeed.com',
      'site-a.test',
    ]);
    expect(payload?.site_removed?.at).toBe(clock.now());
  });

  it('a change that removed no site carries no removal', async () => {
    const repos = new InMemoryRepositories();
    const template = templateRecord();
    await repos.templates.insert(template);
    await repos.templateSites.upsert(templateSiteRecord({ templateId: template.templateId }));
    const bus = new RecordingEventBus<DomainEvents>();
    publishTemplateChanged(
      { repos, runtime: new FakeTemplateRuntime(), bus, clock: new FakeClock() },
      template.templateId,
      new CollectingLogger(),
    );
    for (let i = 0; i < 20 && bus.published.length === 0; i++) await Promise.resolve();
    const payload = bus.published[0]?.payload as DomainEvents['template.changed'] | undefined;
    expect(payload?.template.template_id).toBe(template.templateId);
    expect(payload?.site_removed).toBeUndefined();
  });
});
