/** @module test/persistence/conformance-templates.test — `TemplateRepository` and `TemplateSiteRepository`: the SQLite repositories and the in-memory doubles every service and MCP test runs on behave the same (spec 13 §2.6, spec 09). */

import { afterEach, describe, expect, it } from 'bun:test';
import { isAppError } from '../../src/kernel/errors/app-error.ts';
import type {
  TemplateRepository,
  TemplateSiteRepository,
} from '../../src/ports/persistence/templates.ts';
import {
  InMemoryTemplateRepository,
  InMemoryTemplateSiteRepository,
} from '../helpers/in-memory-template-repos.ts';
import { TEMPLATE_ID, templateRecord, templateSiteRecord } from './helpers.ts';
import { openMemory } from './setup.ts';

interface Pair {
  readonly templates: TemplateRepository;
  readonly sites: TemplateSiteRepository;
  close(): Promise<void>;
}

const IMPLEMENTATIONS: readonly [string, () => Promise<Pair>][] = [
  [
    'sqlite',
    async () => {
      const t = await openMemory();
      return { templates: t.repos.templates, sites: t.repos.templateSites, close: t.close };
    },
  ],
  [
    'in-memory',
    async () => {
      const sites = new InMemoryTemplateSiteRepository();
      return {
        templates: new InMemoryTemplateRepository(sites),
        sites,
        close: async () => undefined,
      };
    },
  ],
];

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
}

for (const [name, open] of IMPLEMENTATIONS) {
  describe(`template repositories (${name})`, () => {
    let pair: Pair;
    afterEach(async () => pair.close());

    it('inserts at version 1 and refuses a taken name with its public text', async () => {
      pair = await open();
      await pair.templates.insert(templateRecord({ version: 7 }));
      expect((await pair.templates.get(TEMPLATE_ID))?.version).toBe(1);
      expect((await pair.templates.getByName('job-hunt'))?.templateId).toBe(TEMPLATE_ID);
      const taken = await refusal(
        pair.templates.insert(templateRecord({ templateId: 'tp-other00001' })),
      );
      expect(isAppError(taken, 'TEMPLATE_NAME_TAKEN')).toBe(true);
      if (isAppError(taken, 'TEMPLATE_NAME_TAKEN')) {
        expect(taken.publicMessage).toBe("A session template named 'job-hunt' already exists.");
      }
      expect(await pair.templates.count()).toBe(1);
    });

    it('updates with optimistic versions, refuses a stale one and a colliding rename', async () => {
      pair = await open();
      await pair.templates.insert(templateRecord());
      await pair.templates.insert(templateRecord({ templateId: 'tp-other00001', name: 'other' }));
      const updated = await pair.templates.update(TEMPLATE_ID, { description: 'x' }, 1);
      expect([updated.version, updated.description]).toEqual([2, 'x']);
      const stale = await refusal(pair.templates.update(TEMPLATE_ID, { description: 'y' }, 1));
      expect(isAppError(stale, 'CONFLICT')).toBe(true);
      if (isAppError(stale, 'CONFLICT')) expect(stale.details).toEqual({ current_version: 2 });
      const taken = await refusal(pair.templates.update(TEMPLATE_ID, { name: 'other' }));
      expect(isAppError(taken, 'TEMPLATE_NAME_TAKEN')).toBe(true);
      const missing = await refusal(pair.templates.update('tp-missing000', { description: 'z' }));
      expect(isAppError(missing, 'TEMPLATE_NOT_FOUND')).toBe(true);
      if (isAppError(missing, 'TEMPLATE_NOT_FOUND')) {
        expect(missing.publicMessage).toBe("No session template 'tp-missing000'.");
      }
      await pair.templates.touchLastUsed(TEMPLATE_ID, 42);
      expect(await pair.templates.get(TEMPLATE_ID)).toMatchObject({ lastUsedAt: 42, version: 2 });
    });

    it('lists by name in binary order', async () => {
      pair = await open();
      for (const [id, n] of [
        ['tp-b00000001', 'bravo'],
        ['tp-a00000001', 'Zulu'],
        ['tp-c00000001', 'alpha'],
      ] as const) {
        await pair.templates.insert(templateRecord({ templateId: id, name: n }));
      }
      expect((await pair.templates.listAll()).map((t) => t.name)).toEqual([
        'Zulu',
        'alpha',
        'bravo',
      ]);
    });

    it('sites: upsert keeps added_at, lists in order, sets health, and cascade on delete', async () => {
      pair = await open();
      await pair.templates.insert(templateRecord());
      await pair.sites.upsert(templateSiteRecord({ siteId: 'b.test', addedAt: 5 }));
      await pair.sites.upsert(templateSiteRecord({ siteId: 'a.test', addedAt: 5 }));
      await pair.sites.upsert(templateSiteRecord({ siteId: 'c.test', addedAt: 1 }));
      await pair.sites.upsert(
        templateSiteRecord({ siteId: 'b.test', addedAt: 99, writePolicy: 'warn' }),
      );
      const listed = await pair.sites.list(TEMPLATE_ID);
      expect(listed.map((s) => [s.siteId, s.addedAt, s.writePolicy])).toEqual([
        ['c.test', 1, null],
        ['a.test', 5, null],
        ['b.test', 5, 'warn'],
      ]);
      const health = {
        state: 'signed_in' as const,
        reason: 'cookies_present',
        checkedAt: 3,
        changedAt: 3,
        consecutiveInconclusive: 0,
      };
      expect(await pair.sites.setHealth(TEMPLATE_ID, 'a.test', health)).toBe(true);
      expect(await pair.sites.setHealth(TEMPLATE_ID, 'nope.test', health)).toBe(false);
      expect((await pair.sites.list(TEMPLATE_ID))[1]?.health).toEqual(health);
      expect(await pair.sites.remove(TEMPLATE_ID, 'c.test')).toBe(true);
      expect(await pair.sites.remove(TEMPLATE_ID, 'c.test')).toBe(false);
      expect((await pair.sites.listAll()).map((s) => s.siteId)).toEqual(['a.test', 'b.test']);
      expect(await pair.templates.remove(TEMPLATE_ID)).toBe(true);
      expect(await pair.templates.remove(TEMPLATE_ID)).toBe(false);
      expect(await pair.sites.listAll()).toEqual([]);
    });
  });
}

describe('template repositories (sqlite): unreadable rows', () => {
  it('listAll skips and reports a row it cannot read when asked to, else fails', async () => {
    const t = await openMemory();
    try {
      await t.repos.templates.insert(templateRecord());
      await t.repos.templates.insert(templateRecord({ templateId: 'tp-bad0000001', name: 'bad' }));
      await t.repos.templateSites.upsert(templateSiteRecord({ templateId: 'tp-bad0000001' }));
      t.handle.raw
        .query("UPDATE templates SET identity_json = '{' WHERE template_id = 'tp-bad0000001'")
        .run();
      t.handle.raw
        .query("UPDATE template_sites SET form_json = '[1]' WHERE template_id = 'tp-bad0000001'")
        .run();
      const skipped: string[] = [];
      const onUnreadable = (id: string) => {
        skipped.push(id);
      };
      expect((await t.repos.templates.listAll({ onUnreadable })).map((r) => r.templateId)).toEqual([
        TEMPLATE_ID,
      ]);
      expect(await t.repos.templateSites.listAll({ onUnreadable })).toEqual([]);
      expect(skipped).toEqual(['tp-bad0000001', 'tp-bad0000001']);
      const loud = await refusal(t.repos.templates.listAll());
      expect(isAppError(loud, 'INTERNAL_ERROR')).toBe(true);
    } finally {
      await t.close();
    }
  });
});
