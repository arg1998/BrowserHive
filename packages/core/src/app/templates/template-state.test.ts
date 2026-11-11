/** @module app/templates/template-state.test — checkpoints and versions with a fake clock and a fake browser (spec 13 §3.9): carry-forward across a restart, rolling cookies writing no version, `signin_change`, `daily`, `manual` when nothing changed, retention keeping Last good and pinned versions, a missing key, and a failed write. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import {
  FAKE_TEMPLATE_KEY,
  FakeTemplateStateStore,
} from '../../../test/helpers/fake-state-store.ts';
import { FakeTemplateHost, fakeCookie } from '../../../test/helpers/fake-template-host.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { RecordingDegradations } from '../../../test/helpers/template-kit.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import { templateKeyOf } from '../../domain/templates/envelope.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { TemplateStateService } from './template-state.ts';

const DAY = 86_400_000;

interface World {
  repos: InMemoryRepositories;
  store: FakeTemplateStateStore;
  host: FakeTemplateHost | null;
  clock: FakeClock;
  degradations: RecordingDegradations;
  events: { name: string; payload: unknown }[];
  service: TemplateStateService;
}

let w: World;

async function world(keep = 10): Promise<World> {
  const repos = new InMemoryRepositories();
  await repos.templates.insert(templateRecord());
  await repos.templateSites.upsert(
    templateSiteRecord({
      learnedCookieNames: ['sid'],
      health: {
        state: 'signed_in',
        reason: null,
        checkedAt: 1,
        changedAt: 1,
        consecutiveInconclusive: 0,
      },
    }),
  );
  const store = new FakeTemplateStateStore();
  const clock = new FakeClock(Date.UTC(2026, 10, 10, 12));
  const degradations = new RecordingDegradations();
  const events: { name: string; payload: unknown }[] = [];
  const host = new FakeTemplateHost(TEMPLATE_ID);
  host.cookies = [fakeCookie('.site-a.test', 'sid', 'value-one-000000000')];
  host.origins = [{ origin: 'https://site-a.test', localStorage: [{ name: 'auth', value: 't' }] }];
  const out: World = {
    repos,
    store,
    host,
    clock,
    degradations,
    events,
    service: undefined as unknown as TemplateStateService,
  };
  out.service = new TemplateStateService({
    repos,
    store,
    hostOf: () => out.host,
    clock,
    logger: new CollectingLogger(),
    degradations,
    bus: { publish: (name, payload) => void events.push({ name, payload }) },
    config: { checkpointIntervalMs: 15 * 60_000, versionsKeep: keep, timeZone: 'UTC' },
  });
  return out;
}

const versions = async () =>
  (await w.repos.templateVersions.list(TEMPLATE_ID)).map((v) => [v.version, v.reason]);

beforeEach(async () => {
  w = await world();
});

describe('checkpoints (spec 13 §3.9)', () => {
  it('writes the rolling checkpoint without a version and records its time and size', async () => {
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: null });
    const template = await w.repos.templates.get(TEMPLATE_ID);
    expect(template?.checkpointAt).toBe(w.clock.now());
    expect(template?.checkpointSizeBytes).toBeGreaterThan(0);
    expect(template?.version).toBe(1);
    expect(await versions()).toEqual([]);
    expect(w.events.some((e) => e.name === 'template.checkpoint.written')).toBe(true);
  });

  it('carries origins forward across a restart (a localStorage sign-in survives)', async () => {
    await w.service.checkpoint(TEMPLATE_ID);
    // A new browser process: it has not visited the origin, so its snapshot lacks the storage.
    const restarted = new FakeTemplateHost(TEMPLATE_ID);
    restarted.cookies = w.host?.cookies ?? [];
    w.host = restarted;
    await w.clock.advance(15 * 60_000);
    await w.service.checkpoint(TEMPLATE_ID);
    const latest = w.store.stored(TEMPLATE_ID, 'latest');
    expect(latest?.origins.map((o) => o.origin)).toEqual(['https://site-a.test']);
    // The origin was visited and cleared: not carried forward.
    restarted.visited.add('https://site-a.test');
    await w.clock.advance(15 * 60_000);
    await w.service.checkpoint(TEMPLATE_ID);
    expect(w.store.stored(TEMPLATE_ID, 'latest')?.origins).toEqual([]);
  });

  it('due() follows the interval from the last checkpoint or the start', async () => {
    const now = w.clock.now();
    expect(w.service.due({ checkpointAt: null }, now, now)).toBe(false);
    expect(w.service.due({ checkpointAt: null }, now, now - 15 * 60_000)).toBe(true);
    expect(w.service.due({ checkpointAt: now - 60_000 }, now, null)).toBe(false);
  });

  it('skips without a key, and records TEMPLATE_CHECKPOINT_FAILED on a failed write', async () => {
    w.store.keys = { current: null, previous: null };
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: false, why: 'no_key' });
    w.store.keys = { current: templateKeyOf(new Uint8Array(32).fill(1)), previous: null };
    w.store.failWrite = new Error('ENOSPC: no space left on device');
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: false, why: 'failed' });
    expect(w.degradations.reports.map((r) => r.code)).toEqual(['TEMPLATE_CHECKPOINT_FAILED']);
    w.store.failWrite = null;
    await w.service.checkpoint(TEMPLATE_ID);
    expect(w.degradations.recoveries).toEqual(['TEMPLATE_CHECKPOINT_FAILED']);
  });

  it('skips a stopped browser', async () => {
    w.host = null;
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: false, why: 'not_running' });
  });
});

describe('versions (spec 13 §3.9)', () => {
  it('rolling cookie values write no version; a disappearing sign-in cookie writes signin_change', async () => {
    expect(await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'admin' })).toBe(1);
    for (const value of ['value-two-000000000', 'value-three-0000000']) {
      if (w.host !== null) w.host.cookies = [fakeCookie('.site-a.test', 'sid', value)];
      await w.clock.advance(15 * 60_000);
      expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: null });
    }
    if (w.host !== null) w.host.cookies = [fakeCookie('.site-a.test', 'other', 'x')];
    await w.clock.advance(15 * 60_000);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: 2 });
    expect(await versions()).toEqual([
      [2, 'signin_change'],
      [1, 'recording'],
    ]);
    const row = (await w.service.rows(TEMPLATE_ID))[0];
    expect(row?.summary.domains[0]?.sign_in_cookies).toEqual([]);
    expect(JSON.stringify(row)).not.toContain('value-');
  });

  it('daily: the first checkpoint of a day whose structure changed', async () => {
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'admin' });
    await w.service.checkpoint(TEMPLATE_ID);
    if (w.host !== null)
      w.host.origins = [
        ...w.host.origins,
        { origin: 'https://b.test', localStorage: [{ name: 'k', value: 'v' }] },
      ];
    await w.clock.advance(15 * 60_000);
    expect((await w.service.checkpoint(TEMPLATE_ID)).written).toBe(true);
    expect(await versions()).toEqual([[1, 'recording']]);
    await w.clock.advance(DAY);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: 2 });
    expect((await versions())[0]).toEqual([2, 'daily']);
  });

  it('manual writes null when nothing changed and refuses a stopped browser', async () => {
    expect(
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a', onlyIfChanged: true }),
    ).toBe(1);
    expect(
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a', onlyIfChanged: true }),
    ).toBeNull();
    w.host = null;
    const err = await w.service
      .saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' })
      .catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('CONFLICT');
  });

  it('retention keeps the newest N, pinned versions and Last good', async () => {
    w = await world(2);
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'a' }); // v1, all signed in
    await w.repos.templateSites.setHealth(TEMPLATE_ID, 'site-a.test', {
      state: 'signed_out',
      reason: null,
      checkedAt: 2,
      changedAt: 2,
      consecutiveInconclusive: 0,
    });
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' }); // v2
    await w.service.pin(TEMPLATE_ID, 2, true);
    for (let i = 0; i < 3; i++)
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    expect((await versions()).map(([v]) => v)).toEqual([5, 4, 2, 1]);
    const rows = await w.service.rows(TEMPLATE_ID);
    expect(rows.find((r) => r.version === 1)?.last_good).toBe(true);
    expect(rows.find((r) => r.version === 2)?.pinned).toBe(true);
    expect(w.store.stored(TEMPLATE_ID, 3)).toBeNull();
    await w.service.pin(TEMPLATE_ID, 2, false);
    expect((await versions()).map(([v]) => v)).toEqual([5, 4, 1]);
  });

  it('lists versions with the checkpoint and pages with a cursor', async () => {
    for (let i = 0; i < 3; i++)
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    const first = await w.service.list(TEMPLATE_ID, { limit: 2 });
    expect(first.data.map((r) => r.version)).toEqual([3, 2]);
    expect(first.checkpoint?.readable).toBe(true);
    const next = await w.service.list(TEMPLATE_ID, {
      limit: 2,
      cursor: first.page.next_cursor ?? '',
    });
    expect(next.data.map((r) => r.version)).toEqual([1]);
    expect(next.page.next_cursor).toBeNull();
  });

  it('marks versions on another key unreadable and refuses to read them', async () => {
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'a' });
    w.store.keys = { current: templateKeyOf(new Uint8Array(32).fill(9)), previous: null };
    expect((await w.service.rows(TEMPLATE_ID))[0]?.readable).toBe(false);
    const err = await w.service.read(TEMPLATE_ID, 1).catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('TEMPLATE_VERSION_UNREADABLE');
    const missing = await w.service.read(TEMPLATE_ID, 7).catch((e: unknown) => e);
    expect(isAppError(missing) && missing.code).toBe('TEMPLATE_VERSION_NOT_FOUND');
  });

  it('forgetDomain removes a domain from the checkpoint so it is never carried forward', async () => {
    await w.service.checkpoint(TEMPLATE_ID);
    await w.service.forgetDomain(TEMPLATE_ID, 'site-a.test');
    expect(w.store.stored(TEMPLATE_ID, 'latest')).toEqual({ cookies: [], origins: [] });
  });
});

const OLD_KEY = templateKeyOf(new Uint8Array(32).fill(1));
const signedIn = {
  state: 'signed_in' as const,
  reason: null,
  checkedAt: 1,
  changedAt: 1,
  consecutiveInconclusive: 0,
};

describe('review #79: a key change never destroys recoverable files (M-1)', () => {
  it('keeps a checkpoint on another key, records TEMPLATE_KEY_MISMATCH and prunes no old-key version', async () => {
    w = await world(2);
    w.store.keys = { current: OLD_KEY, previous: null };
    expect(await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'op' })).toBe(1);
    const before = w.store.stored(TEMPLATE_ID, 'latest');
    // A new key without templateKeyPrevious; the browser restarted (no origins visited).
    w.store.keys = { current: FAKE_TEMPLATE_KEY, previous: null };
    const restarted = new FakeTemplateHost(TEMPLATE_ID);
    restarted.cookies = w.host?.cookies ?? [];
    w.host = restarted;
    await w.clock.advance(DAY);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: false, why: 'failed' });
    expect(w.store.stored(TEMPLATE_ID, 'latest')).toEqual(before);
    expect(w.degradations.reports.map((r) => r.code)).toContain('TEMPLATE_KEY_MISMATCH');
    // Versions on the new key do not push the old one out (it does not count toward keep).
    for (const name of ['a', 'b', 'c']) {
      restarted.cookies = [...restarted.cookies, fakeCookie('.site-a.test', `x${name}`, 'v')];
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'op' }).catch(() => null);
    }
    expect((await w.repos.templateVersions.get(TEMPLATE_ID, 1))?.keyId).toBe(OLD_KEY.keyId);
  });
});

describe('review #79: retention keeps versions on another key (M-1)', () => {
  it('new-key versions do not push an old-key version out, and it does not count toward keep', async () => {
    w = await world(1);
    // Not a good version, so only the key protects it.
    await w.repos.templateSites.setHealth(TEMPLATE_ID, 'site-a.test', {
      ...signedIn,
      state: 'signed_out',
    });
    w.store.keys = { current: OLD_KEY, previous: null };
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'op' });
    // No checkpoint to carry forward (removed by hand): writes on the new key go through.
    await w.store.remove(TEMPLATE_ID, 'latest');
    await w.repos.templates.setStateFacts(TEMPLATE_ID, { checkpointAt: null });
    w.store.keys = { current: FAKE_TEMPLATE_KEY, previous: null };
    for (const name of ['a', 'b']) {
      if (w.host !== null)
        w.host.cookies = [...w.host.cookies, fakeCookie('.site-a.test', name, 'v')];
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'op' });
    }
    const left = (await w.repos.templateVersions.list(TEMPLATE_ID)).map((v) => v.version);
    expect(left).toEqual([3, 1]);
  });
});

describe('review #79: Last good needs every learned sign-in cookie (M-2)', () => {
  it('a signin_change that lost the sign-in cookie is not Last good; v1 stays good and survives retention', async () => {
    w = await world(1);
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'op' });
    if (w.host !== null) w.host.cookies = [];
    await w.clock.advance(60_000);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: 2 });
    const v2 = (await w.service.rows(TEMPLATE_ID)).find((r) => r.version === 2);
    expect(v2?.health[0]?.sign_in_complete).toBe(false);
    expect(v2?.last_good).toBe(false);
    for (let i = 0; i < 2; i++) {
      if (w.host !== null) w.host.cookies = [fakeCookie('.site-a.test', `n${i}`, 'v')];
      await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'op' });
    }
    const rows = await w.service.rows(TEMPLATE_ID);
    expect(rows.find((r) => r.last_good)?.version).toBe(1);
    expect(rows.map((r) => r.version)).toEqual([4, 1]);
  });

  it('two sites: one losing its cookie writes signin_change and is not good; a disabled site counts for neither', async () => {
    w = await world();
    await w.repos.templateSites.upsert(
      templateSiteRecord({ siteId: 'site-b.test', learnedCookieNames: ['bid'], health: signedIn }),
    );
    if (w.host !== null) {
      w.host.cookies = [
        fakeCookie('.site-a.test', 'sid', 'value-one-000000000'),
        fakeCookie('.site-b.test', 'bid', 'value-b-00000000000'),
      ];
    }
    expect(await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'op' })).toBe(1);
    // site-b loses its sign-in, site-a keeps it: a version is written, and it is not good.
    if (w.host !== null)
      w.host.cookies = [fakeCookie('.site-a.test', 'sid', 'value-one-000000000')];
    await w.clock.advance(60_000);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: 2 });
    expect((await w.service.rows(TEMPLATE_ID)).find((r) => r.last_good)?.version).toBe(1);
    // site-b disabled: its missing cookie no longer writes versions or blocks Last good.
    await w.repos.templateSites.upsert(
      templateSiteRecord({
        siteId: 'site-b.test',
        learnedCookieNames: ['bid'],
        health: signedIn,
        enabled: false,
      }),
    );
    await w.clock.advance(60_000);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: null });
    expect(await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'op' })).toBe(3);
    expect((await w.service.rows(TEMPLATE_ID)).find((r) => r.last_good)?.version).toBe(3);
  });

  it('a disabled site losing its sign-in cookie writes no version', async () => {
    w = await world();
    await w.repos.templateSites.upsert(
      templateSiteRecord({ siteId: 'site-b.test', learnedCookieNames: ['bid'], health: signedIn }),
    );
    const a = fakeCookie('.site-a.test', 'sid', 'value-one-000000000');
    if (w.host !== null)
      w.host.cookies = [a, fakeCookie('.site-b.test', 'bid', 'value-b-00000000000')];
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'op' });
    await w.repos.templateSites.upsert(
      templateSiteRecord({
        siteId: 'site-b.test',
        learnedCookieNames: ['bid'],
        health: signedIn,
        enabled: false,
      }),
    );
    if (w.host !== null) w.host.cookies = [a];
    await w.clock.advance(60_000);
    expect(await w.service.checkpoint(TEMPLATE_ID)).toEqual({ written: true, version: null });
  });

  it('every site disabled: no Last good', async () => {
    w = await world();
    await w.repos.templateSites.upsert(
      templateSiteRecord({ learnedCookieNames: ['sid'], health: signedIn, enabled: false }),
    );
    await w.service.saveVersion(TEMPLATE_ID, { reason: 'recording', by: 'op' });
    expect((await w.service.rows(TEMPLATE_ID)).some((r) => r.last_good)).toBe(false);
  });
});

describe('review #79: write failures (L-9)', () => {
  it('no file without a row: a failed row insert removes the version file', async () => {
    w = await world();
    w.repos.templateVersions.insert = async () => {
      throw new Error('disk I/O error');
    };
    const err = await w.service
      .saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'op' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(w.store.stored(TEMPLATE_ID, 1)).toBeNull();
  });

  it('numbers a version after current_version even when the newest row is gone', async () => {
    w = await world();
    await w.repos.templates.setStateFacts(TEMPLATE_ID, { currentVersion: 7 });
    expect(await w.service.saveVersion(TEMPLATE_ID, { reason: 'manual', by: 'op' })).toBe(8);
  });
});
