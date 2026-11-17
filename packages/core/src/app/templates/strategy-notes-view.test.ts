/** @module app/templates/strategy-notes-view.test — the sites' strategy notes on the operator views (spec 13 §9.4, §11.4; D49, D50): `hostTemplatePacks` answers them from the approved pack and the machine's platform, and every site view of a template (create, detail, site add) carries them; a view without its template, or packs without notes, carries none. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { TemplateStrategyNote } from '@browserhive/contracts/http';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import {
  createSitePackKit,
  makeDirs,
  packSha,
  removeDirs,
  type SitePackDirs,
  type SitePackKit,
  sitePack,
  writePack,
} from '../../../test/helpers/site-pack-kit.ts';
import {
  FAKE_TEMPLATE_GEO,
  FakeTemplateFiles,
  FakeTemplateRuntime,
  RecordingDegradations,
} from '../../../test/helpers/template-kit.ts';
import type { Repositories } from '../../ports/persistence/index.ts';
import { TemplateEditService } from './template-edit.ts';
import { hostTemplatePacks } from './template-packs.ts';
import { TemplateService } from './template-service.ts';
import { toSiteView } from './views.ts';

const STRATEGIES = [
  { id: 'humanize-input' as const, params: {} },
  { id: 'single-focus' as const, params: {} },
];
const PACKED = sitePack('paced.test', 1, { strategies: STRATEGIES });
const PLAIN = sitePack('plain.test', 1);

let dirs: SitePackDirs;
let kit: SitePackKit;
let repos: Repositories;

beforeEach(async () => {
  dirs = makeDirs();
  writePack(dirs.bundled, PACKED);
  writePack(dirs.bundled, PLAIN);
  kit = createSitePackKit({ dirs });
  await kit.registry.reload();
  repos = { ...kit.repos, operatorActions: kit.actions };
});
afterEach(() => removeDirs(dirs));

function services(platform: string) {
  const packs = hostTemplatePacks(kit.registry, platform);
  const runtime = new FakeTemplateRuntime();
  const logger = new CollectingLogger();
  const service = new TemplateService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    runtime,
    geo: FAKE_TEMPLATE_GEO,
    files: new FakeTemplateFiles(),
    degradations: new RecordingDegradations(),
    ids: { opaque: (n) => 'x'.repeat(n), eventId: () => kit.ids.eventId() },
    clock: kit.clock,
    logger,
    packs,
    config: {
      enabled: true,
      authMode: 'off',
      maxPagesPerHost: 40,
      defaults: { channel: 'chromium', stealth: 'standard', fingerprint: false, humanize: false },
    },
  });
  const edit = new TemplateEditService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    runtime,
    ops: new FakeTemplateHostOps(),
    sessions: { peek: () => undefined, close: () => Promise.resolve(true) },
    ids: kit.ids,
    clock: kit.clock,
    logger,
    changed: () => undefined,
    packs,
  });
  return { service, edit, packs };
}

const site = { site_id: 'paced.test', pack_sha256: packSha(PACKED) };

describe('strategy notes on the template views', () => {
  it('stealth off and headless on macOS: both notes, on create, detail and the template', async () => {
    const { service } = services('darwin');
    const created = await service.create(
      {
        name: 'notes',
        headless: true,
        sites: [site, { site_id: 'plain.test', pack_sha256: packSha(PLAIN) }],
      },
      'p-op',
    );
    // No stealth in the input: the default (`standard`) applies, so only single-focus.
    expect(created.sites[0]?.strategy_notes.map((n) => n.code)).toEqual(['single_focus_limited']);
    const off = await service.create(
      { name: 'notes-off', stealth: 'off', headless: true, sites: [site] },
      'p-op',
    );
    const codes: TemplateStrategyNote['code'][] = [
      'humanize_needs_stealth',
      'single_focus_limited',
    ];
    expect(off.sites[0]?.strategy_notes.map((n) => n.code)).toEqual(codes);
    const detail = await service.get(off.template_id);
    expect(detail.sites[0]?.strategy_notes.map((n) => n.code)).toEqual(codes);
    expect(detail.template.sites[0]?.strategy_notes.map((n) => n.code)).toEqual(codes);
    expect(detail.sites[0]?.strategy_notes[0]?.message).toContain('Site paced.test');
    // A pack without those strategies, and a generic site, carry none.
    expect(created.sites[1]?.strategy_notes).toEqual([]);
  });

  it('on Linux, or headed: only the humanize note; stealth on: none', async () => {
    const linux = services('linux');
    const a = await linux.service.create(
      { name: 'linux', stealth: 'off', headless: true, sites: [site] },
      'p-op',
    );
    expect(a.sites[0]?.strategy_notes.map((n) => n.code)).toEqual(['humanize_needs_stealth']);
    const win = services('win32');
    const headed = await win.service.create(
      { name: 'headed', stealth: 'off', headless: false, sites: [site] },
      'p-op',
    );
    expect(headed.sites[0]?.strategy_notes.map((n) => n.code)).toEqual(['humanize_needs_stealth']);
    const on = await win.service.create(
      { name: 'on', stealth: 'max', headless: false, sites: [site] },
      'p-op',
    );
    expect(on.sites[0]?.strategy_notes).toEqual([]);
  });

  it('adding a site answers its notes; a view without its template or without notes has none', async () => {
    const { service, edit, packs } = services('win32');
    const t = await service.create(
      { name: 'add', stealth: 'off', headless: true, sites: [{ site_id: 'other.test' }] },
      'p-op',
    );
    const added = await edit.putSite(t.template_id, 'paced.test', site, 'p-op');
    expect(added.strategy_notes.map((n) => n.code)).toEqual([
      'humanize_needs_stealth',
      'single_focus_limited',
    ]);
    const record = (await repos.templateSites.list(t.template_id)).find(
      (s) => s.siteId === 'paced.test',
    );
    if (record === undefined) throw new Error('site missing');
    expect(toSiteView(record, packs).strategy_notes).toEqual([]);
    expect(
      toSiteView(record, kit.registry, { stealth: 'off', headless: true }).strategy_notes,
    ).toEqual([]);
    // The adapter answers the registry's other reads unchanged.
    expect(packs.sitePackOf('paced.test')).toEqual(kit.registry.sitePackOf('paced.test'));
    expect(packs.strategyNotes?.(null, { stealth: 'off', headless: true })).toEqual([]);
  });
});
