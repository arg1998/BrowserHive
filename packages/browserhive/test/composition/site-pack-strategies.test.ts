/** @module test/composition/site-pack-strategies.test — the T3b host strategies' composition (spec 13 §9.4, §9.6): nothing is built under `templates=false` or `sitePacks=false` (every strategy inert); built, a host start asks for the switches of the template's sites, and the joined page watcher calls every watcher even when one throws. */

import { describe, expect, it } from 'bun:test';
import {
  createLogger,
  createSystemClock,
  type DomainEvents,
  type Logger,
} from '@browserhive/core/runtime';
import { InProcessEventBus } from '@browserhive/core/server';
import {
  buildSiteStrategies,
  joinPageWatchers,
  type SiteStrategiesInput,
} from '../../src/composition/site-pack-strategies.ts';
import { resolvedFor } from './support.ts';

const clock = createSystemClock();
const logger: Logger = createLogger({
  level: 'error',
  format: 'json',
  clock,
  stream: { write: () => true },
});

function input(overrides: { templates: boolean; sitePacks: boolean }): SiteStrategiesInput {
  const sites = { list: async () => [], listAll: async () => [] };
  return {
    config: resolvedFor(overrides).config,
    registry: {
      effectiveFor: () => null,
      effectiveById: () => null,
      generation: 0,
    } as unknown as SiteStrategiesInput['registry'],
    uow: { transaction: async () => undefined } as unknown as SiteStrategiesInput['uow'],
    repos: { templates: {}, templateSites: sites } as unknown as SiteStrategiesInput['repos'],
    sessions: {} as SiteStrategiesInput['sessions'],
    bus: new InProcessEventBus<DomainEvents>({ clock, logger }),
    clock,
    logger,
  };
}

describe('buildSiteStrategies', () => {
  it('builds nothing under sitePacks=false or templates=false', () => {
    expect(buildSiteStrategies(input({ templates: true, sitePacks: false }))).toBeNull();
    expect(buildSiteStrategies(input({ templates: false, sitePacks: true }))).toBeNull();
  });

  it('built: a host start of a template without pack strategies gets no switch', async () => {
    const built = buildSiteStrategies(input({ templates: true, sitePacks: true }));
    if (built === null) throw new Error('not built');
    expect(
      await built.hostFlags({ templateId: 'tp-a' } as Parameters<typeof built.hostFlags>[0]),
    ).toEqual([]);
    expect(built.pageWatcher.responseReceived).toBeDefined();
    built.stop();
  });
});

describe('joinPageWatchers', () => {
  it('calls every watcher in order; one that throws does not stop the next', () => {
    const calls: string[] = [];
    const joined = joinPageWatchers(
      logger,
      {
        pageAttributed: () => {
          calls.push('a');
          throw new Error('boom');
        },
      },
      null,
      {
        pageAttributed: () => void calls.push('b'),
        responseReceived: (_t, r) => void calls.push(`r:${r.url}`),
      },
    );
    joined.pageAttributed('tp-a', {} as Parameters<typeof joined.pageAttributed>[1], 's');
    joined.responseReceived?.('tp-a', { url: 'https://x.test/', headers: () => ({}) });
    expect(calls).toEqual(['a', 'b', 'r:https://x.test/']);
    expect(joinPageWatchers(logger, { pageAttributed: () => undefined }).responseReceived).toBe(
      undefined,
    );
  });
});
