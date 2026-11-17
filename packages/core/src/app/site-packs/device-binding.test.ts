/** @module app/site-packs/device-binding.test — `device-bound-session` (spec 13 §9.4): a response carrying `Sec-Session-Registration` or `Sec-Session-Id` on a URL whose pack selects the strategy marks the URL's template site `device_bound` once and publishes the change; other packs, other headers, sites already marked and a missing lookup (`sitePacks=false`) change nothing, and headers are read only when the pack selects the strategy. */

import { describe, expect, it } from 'bun:test';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { TEMPLATE_ID, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { SitePackLookup } from '../../ports/site-packs.ts';
import { DeviceBindingWatch } from './device-binding.ts';
import { effective, lookupOf } from './strategy-test-packs.ts';

const bound = effective({ strategies: [{ id: 'device-bound-session', params: {} }] });

async function world(lookup: SitePackLookup | null) {
  const repos = new InMemoryRepositories();
  await repos.templateSites.upsert(
    templateSiteRecord({ siteId: 'linkedin.com', packId: 'linkedin.com' }),
  );
  const changed: string[] = [];
  const watch = new DeviceBindingWatch({
    lookup: () => lookup,
    uow: new InMemoryUnitOfWork(repos),
    changed: (id) => void changed.push(id),
    logger: createCollectingLogger(),
  });
  let reads = 0;
  const respond = (url: string, headers: Record<string, string>) =>
    watch.responseReceived(TEMPLATE_ID, {
      url,
      headers: () => {
        reads += 1;
        return headers;
      },
    });
  const marked = async () => {
    await new Promise((r) => setTimeout(r, 5));
    return (await repos.templateSites.list(TEMPLATE_ID))[0]?.deviceBound;
  };
  return { respond, marked, changed, reads: () => reads };
}

describe('DeviceBindingWatch', () => {
  it('marks the site of a DBSC response once and publishes the change', async () => {
    const w = await world(lookupOf(bound));
    w.respond('https://static.licdn.com/x.js', { 'content-type': 'text/javascript' });
    expect(await w.marked()).toBe(false);
    w.respond('https://www.linkedin.com/feed/', {
      'sec-session-registration': '(ES256);path="/dbsc/start";challenge="c"',
    });
    expect(await w.marked()).toBe(true);
    w.respond('https://www.linkedin.com/feed/', { 'sec-session-id': 'abc' });
    await w.marked();
    expect(w.changed).toEqual([TEMPLATE_ID]);
  });

  it('Sec-Session-Id alone marks the site too', async () => {
    const w = await world(lookupOf(bound));
    w.respond('https://www.linkedin.com/x', { 'sec-session-id': 'abc' });
    expect(await w.marked()).toBe(true);
  });

  it('nothing without the strategy, outside every pack, or with packs off; headers unread', async () => {
    for (const lookup of [lookupOf(effective()), null]) {
      const w = await world(lookup);
      w.respond('https://www.linkedin.com/', { 'sec-session-registration': 'x' });
      expect(await w.marked()).toBe(false);
      expect(w.reads()).toBe(0);
    }
    const outside = await world(lookupOf(bound));
    outside.respond('https://elsewhere.test/', { 'sec-session-registration': 'x' });
    expect(await outside.marked()).toBe(false);
    expect(outside.reads()).toBe(0);
    expect(outside.changed).toEqual([]);
  });
});
