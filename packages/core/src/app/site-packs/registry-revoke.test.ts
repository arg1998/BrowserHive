/** @module app/site-packs/registry-revoke.test — `SitePackRegistry.revoke` on the in-memory registry (spec 13 §9.7 revocation): a tightening or neutral fallback applies at once, a loosening one stays behind a pending decision marked `revoked` that Apply can take from BrowserHive's copy, no fallback keeps and reports, a revoked candidate is withdrawn, a pinned pack follows the rule. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { createMemorySitePacks } from '../../../test/helpers/in-memory-site-packs.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { packSha, sitePack } from '../../../test/helpers/site-pack-kit.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import type { DomainEvents } from '../events/catalog.ts';

const PACK = 'pack-a.test';
const EXTRA_GUARD = {
  id: 'account',
  kind: 'account' as const,
  match: { url: `www.${PACK}/account/delete*` },
  action: 'block' as const,
};

/** v1 approved, then v2 (`v2Extra`) applied: v1 is the fallback. */
async function withApplied(v2Extra: Parameters<typeof sitePack>[2]) {
  const repos = new InMemoryRepositories();
  const actions = new InMemoryOperatorActionRepository();
  const bus = new RecordingEventBus<DomainEvents>();
  const { registry, bundled } = await createMemorySitePacks({
    repos: { ...repos, operatorActions: actions },
    clock: new FakeClock(),
    ids: new FakeIdGenerator(),
    logger: createCollectingLogger(),
    bus,
  });
  await registry.approveSite(PACK, packSha(sitePack(PACK, 1)), 'p-op');
  bundled.put(sitePack(PACK, 2, v2Extra));
  await registry.reload();
  await registry.apply(PACK, 2, 'p-op');
  return { registry, repos, actions, bus, bundled };
}

describe('SitePackRegistry.revoke', () => {
  it('a tightening fallback applies at once (an automatic decision)', async () => {
    // v2 dropped the logout guard: going back to v1 adds it again.
    const { registry, repos, actions } = await withApplied({ guards: [] });
    const result = await registry.revoke(PACK, 2, 'browserhive');
    expect(result).toMatchObject({ outcome: 'fallback_applied', classification: 'tightening' });
    expect(result.view.approved?.version).toBe(1);
    expect(registry.effectiveFor(PACK)?.version).toBe(1);
    const auto = repos.sitePackChanges.rows.find((r) => r.decision === 'auto');
    expect(auto).toMatchObject({ fromVersion: 2, toVersion: 1, classification: 'tightening' });
    expect(actions.rows.at(-1)?.action).toBe('site_pack.revoke');
  });

  it('a neutral fallback applies at once', async () => {
    const { registry } = await withApplied({ title: 'Renamed' });
    expect(await registry.revoke(PACK, 2, 'browserhive')).toMatchObject({
      outcome: 'fallback_applied',
      classification: 'neutral',
    });
  });

  it('a loosening fallback keeps the revoked version and opens a decision marked revoked', async () => {
    const { registry, bus } = await withApplied({
      guards: [sitePack(PACK, 1).guards?.[0] ?? EXTRA_GUARD, EXTRA_GUARD],
    });
    const result = await registry.revoke(PACK, 2, 'browserhive');
    expect(result).toMatchObject({ outcome: 'decision_opened', classification: 'loosening' });
    expect(registry.effectiveFor(PACK)?.version).toBe(2);
    expect(result.view.pending).toMatchObject([{ version: 1, classification: 'revoked' }]);
    expect(registry.pending()).toMatchObject([{ toVersion: 1, classification: 'revoked' }]);
    const events = bus.published.filter((e) => e.name === 'site_pack.pending');
    expect(events.at(-1)?.payload).toMatchObject({ to_version: 1, classification: 'revoked' });
    // The decision survives a reload (not superseded as "older than approved").
    await registry.reload();
    expect(registry.get(PACK)?.pending).toMatchObject([{ version: 1, classification: 'revoked' }]);
    // The operator applies it: v1 again, from the release or BrowserHive's copy.
    await registry.apply(PACK, 1, 'p-op');
    expect(registry.effectiveFor(PACK)?.version).toBe(1);
  });

  it('a pinned pack follows the same rule, and its decision is listed', async () => {
    const { registry } = await withApplied({
      guards: [sitePack(PACK, 1).guards?.[0] ?? EXTRA_GUARD, EXTRA_GUARD],
    });
    await registry.pin(PACK, 2, 'p-op');
    expect((await registry.revoke(PACK, 2, 'browserhive')).outcome).toBe('decision_opened');
    expect(registry.pending()).toMatchObject([{ toVersion: 1, classification: 'revoked' }]);
  });

  it('with no fallback the revoked version stays in force and is reported', async () => {
    const repos = new InMemoryRepositories();
    const actions = new InMemoryOperatorActionRepository();
    const { registry } = await createMemorySitePacks({
      repos: { ...repos, operatorActions: actions },
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: createCollectingLogger(),
    });
    await registry.approveSite(PACK, packSha(sitePack(PACK, 1)), 'p-op');
    expect(await registry.revoke(PACK, 1, 'browserhive')).toMatchObject({
      outcome: 'kept',
      reason: 'no_fallback',
    });
    expect(registry.effectiveFor(PACK)?.version).toBe(1);
    expect(actions.rows.at(-1)).toMatchObject({
      action: 'site_pack.revoke',
      details: { version: 1, outcome: 'kept', reason: 'no_fallback' },
    });
  });

  it('a revoked pending candidate is withdrawn; an unknown version is not in force', async () => {
    const repos = new InMemoryRepositories();
    const { registry, bundled } = await createMemorySitePacks({
      repos: { ...repos, operatorActions: new InMemoryOperatorActionRepository() },
      clock: new FakeClock(),
      ids: new FakeIdGenerator(),
      logger: createCollectingLogger(),
    });
    await registry.approveSite(PACK, packSha(sitePack(PACK, 1)), 'p-op');
    bundled.put(sitePack(PACK, 2, { title: 'v2' }));
    await registry.reload();
    expect((await registry.revoke(PACK, 2, 'browserhive')).outcome).toBe('candidate_withdrawn');
    expect(registry.get(PACK)?.pending).toEqual([]);
    expect((await registry.revoke(PACK, 9, 'browserhive')).outcome).toBe('not_in_force');
  });
});
