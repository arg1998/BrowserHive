/** @module app/site-packs/write-policies.test — a template site's write-policy override is found by its pack id, else by a pack domain; reloaded on `template.changed`, dropped on `template.removed`. */

import { describe, expect, it } from 'bun:test';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type { DomainEvents } from '../events/catalog.ts';
import { TemplateWritePolicies } from './write-policies.ts';

const TID = 'tp-aaaaaaaaaa';
const PACK = { id: 'linkedin.com', domains: ['linkedin.com', 'licdn.com'] };

describe('TemplateWritePolicies', () => {
  it('reads overrides by pack id, then by domain; null before a load or without one', async () => {
    let sites: TemplateSiteRecord[] = [
      templateSiteRecord({ templateId: TID, siteId: 'licdn.com', writePolicy: 'warn' }),
    ];
    const bus = new RecordingEventBus<DomainEvents>();
    const policies = new TemplateWritePolicies({
      sites: { list: async () => sites },
      bus,
      logger: createCollectingLogger(),
    });
    expect(policies.overrideFor(TID, PACK)).toBeNull();
    await policies.load(TID);
    expect(policies.overrideFor(TID, PACK)).toBe('warn');
    sites = [
      ...sites,
      templateSiteRecord({
        templateId: TID,
        siteId: 'linkedin.com',
        packId: 'linkedin.com',
        writePolicy: 'allow',
      }),
    ];
    bus.publish('template.changed', {
      type: 'template.changed',
      template: { template_id: TID },
    } as unknown as DomainEvents['template.changed']);
    await new Promise((r) => setTimeout(r, 0));
    expect(policies.overrideFor(TID, PACK)).toBe('allow');
    bus.publish('template.removed', { type: 'template.removed', template_id: TID });
    expect(policies.overrideFor(TID, PACK)).toBeNull();
    policies.stop();
  });
});
