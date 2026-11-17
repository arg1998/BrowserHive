/** @module app/site-packs/site-visits.test — the keeper's record of agent loads (spec 13 §9.4 `keep-alive`): main-frame commits of agent pages by registrable domain; subframes, maintenance pages and other templates do not count. */

import { describe, expect, it } from 'bun:test';
import type { Frame, Page } from 'patchright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { AgentSiteVisits } from './site-visits.ts';

/** A page whose `framenavigated` listeners the test fires. */
function fakePage() {
  const listeners: ((frame: Frame) => void)[] = [];
  const page = {
    url: () => 'about:blank',
    on: (_event: string, fn: (frame: Frame) => void) => void listeners.push(fn),
  } as unknown as Page;
  const commit = (url: string, main = true) => {
    const frame = { url: () => url, parentFrame: () => (main ? null : {}) } as unknown as Frame;
    for (const fn of listeners) fn(frame);
  };
  return { page, commit };
}

describe('AgentSiteVisits', () => {
  it('records main-frame commits of agent pages by registrable domain', async () => {
    const clock = new FakeClock(1_000);
    const visits = new AgentSiteVisits({ isAgent: (id) => id === 'agent-1', clock });
    const agent = fakePage();
    const maintenance = fakePage();
    visits.pageAttributed('tp-a', agent.page, 'agent-1');
    visits.pageAttributed('tp-a', maintenance.page, 'maint-1');
    maintenance.commit('https://www.linkedin.com/feed/');
    expect(visits.lastLoad('tp-a', ['linkedin.com'])).toBeNull();
    agent.commit('https://ads.linkedin.com/frame', false);
    expect(visits.lastLoad('tp-a', ['linkedin.com'])).toBeNull();
    await clock.advance(500);
    agent.commit('https://www.linkedin.com/feed/');
    expect(visits.lastLoad('tp-a', ['licdn.com', 'linkedin.com'])).toBe(1_500);
    expect(visits.lastLoad('tp-b', ['linkedin.com'])).toBeNull();
    visits.forget('tp-a');
    expect(visits.lastLoad('tp-a', ['linkedin.com'])).toBeNull();
  });
});
