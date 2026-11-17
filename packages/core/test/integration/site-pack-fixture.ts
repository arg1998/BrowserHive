/** @module test/integration/site-pack-fixture — a fixture pack for `site-a.test` over the real MCP stack and a real template host (spec 13 §9.3, §9.5, §8.1, §14): the tool gate, the challenge watch on the host's pages, the stops and the pack prober, with WP-E1's security intercepts, hit writer, rule catalog, write policies and the dispatcher's tool hold. */

import { SiteGuardHitRow } from '@browserhive/contracts/http';
import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { AgentNavigations } from '../../src/app/site-packs/agent-navigations.ts';
import { ChallengeOutcomes } from '../../src/app/site-packs/challenge-outcomes.ts';
import { ChallengeWatch } from '../../src/app/site-packs/challenge-watch.ts';
import { PackProber, packProberSelector } from '../../src/app/site-packs/pack-prober.ts';
import { maintenanceProbePages } from '../../src/app/site-packs/probe-pages.ts';
import { SecurityInterceptService } from '../../src/app/site-packs/security-intercepts.ts';
import { TemplateSiteStops } from '../../src/app/site-packs/site-stops.ts';
import { SiteToolGate } from '../../src/app/site-packs/tool-gate.ts';
import { ToolGuardHits } from '../../src/app/site-packs/tool-guard-hits.ts';
import { TemplateWritePolicies } from '../../src/app/site-packs/write-policies.ts';
import { TemplateHostOperations } from '../../src/app/templates/host-operations.ts';
import { selectGenericProber } from '../../src/app/templates/site-prober.ts';
import { TemplateHealthService } from '../../src/app/templates/template-health.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createNanoidIdGenerator } from '../../src/infra/ids/nanoid-id-generator.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { documentGuardResolver } from '../../src/infra/site-packs/document-guard.ts';
import { SiteGuardHitsWriter } from '../../src/infra/site-packs/guard-hits-writer.ts';
import { GuardRuleCatalog } from '../../src/infra/site-packs/guard-rules.ts';
import { registrableDomain } from '../../src/kernel/url.ts';
import type { ChallengeInput, SecurityIntercepts } from '../../src/ports/security-intercepts.ts';
import type { EffectivePack, SitePackLookup } from '../../src/ports/site-packs.ts';
import type { DocumentGuardResolver } from '../../src/ports/site-tool-guards.ts';
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

/** The fixture pack (LinkedIn-shaped, on `site-a.test`); `probe` names the probe path. */
export function fixturePack(
  probe = '/pack/probe/in',
  extra: Partial<SitePackV1Input> = {},
): SitePackV1 {
  return SitePackV1.parse({
    schema: 1,
    id: 'site-a.test',
    version: 1,
    min_client: '0.3.0',
    title: 'Site A',
    domains: ['site-a.test'],
    sign_in: { url: { host: 'site-a.test', path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: 'site-a.test', path: probe },
      kind: 'either',
      signed_out_redirects: ['site-a.test/login*'],
      landmark: '#feed',
    },
    guards: [
      { id: 'logout', kind: 'logout', match: { url: 'site-a.test/logout' }, action: 'block' },
    ],
    element_guards: [
      {
        id: 'signout',
        kind: 'logout',
        page: 'site-a.test/*',
        target: { selector: '#signout' },
        action: 'block',
        request_guard: 'logout',
      },
      {
        id: 'delete',
        kind: 'destructive',
        page: 'site-a.test/*',
        target: { role: 'button', name: 'Delete' },
        action: 'block',
      },
    ],
    write_policy: { default: 'confirm', stance: 'prohibited' },
    challenges: [
      {
        id: 'checkpoint',
        kind: 'checkpoint',
        match: { url: 'site-a.test/pack/checkpoint' },
        action: 'attention',
      },
      {
        id: 'suspended',
        kind: 'locked',
        match: { url: 'site-a.test/pack/suspended' },
        action: 'stop',
      },
    ],
    ...extra,
  });
}

/** A lookup over one pack (tests swap `pack`). */
export class FixtureLookup implements SitePackLookup {
  generation = 1;
  constructor(public pack: SitePackV1) {}

  #effective(): EffectivePack {
    return {
      packId: this.pack.id,
      pack: this.pack,
      version: this.pack.version,
      sha256: `fixture-${this.generation}`,
      source: 'local',
      localOverride: false,
    };
  }

  effectiveFor(hostOrDomain: string): EffectivePack | null {
    return this.pack.domains.includes(registrableDomain(hostOrDomain)) ? this.#effective() : null;
  }

  effectiveById(packId: string): EffectivePack | null {
    return packId === this.pack.id ? this.#effective() : null;
  }

  swap(pack: SitePackV1): void {
    this.pack = pack;
    this.generation += 1;
  }
}

/** One test's world. */
export interface PackWorld {
  readonly w: TemplateMcp;
  readonly lookup: FixtureLookup;
  readonly intercepts: SecurityInterceptService;
  readonly stops: TemplateSiteStops;
  readonly health: TemplateHealthService;
  /** The `site_guard_hits` rows written so far (through WP-E1's writer). */
  hits(): SiteGuardHitRow[];
  /** Every `raiseChallenge` the page watch made. */
  readonly raised: readonly ChallengeInput[];
  stop(): Promise<void>;
}

/**
 * The fixture pack's world over WP-E1's real security intercepts, hit writer, rule catalog and
 * write policies (the dispatcher's tool hold included); the request guard is not installed (the
 * network path is `site-pack-guards.test.ts`).
 */
export async function packWorld(
  pack: SitePackV1 = fixturePack(),
  options: { readonly probeTimeoutMs?: number } = {},
): Promise<PackWorld> {
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const lookup = new FixtureLookup(pack);
  const ref: {
    intercepts: SecurityInterceptService | null;
    hits: SiteGuardHitsWriter | null;
    policies: TemplateWritePolicies | null;
    documentGuard: DocumentGuardResolver | null;
    health: TemplateHealthService | null;
  } = { intercepts: null, hits: null, policies: null, documentGuard: null, health: null };
  const raised: ChallengeInput[] = [];
  // The page watch's view of the intercepts: every challenge it raises is recorded.
  const watched = (): SecurityIntercepts | null => {
    const real = ref.intercepts;
    if (real === null) return null;
    return {
      confirmer: real.confirmer,
      holdOf: (id) => real.holdOf(id),
      requestWriteApproval: (input) => real.requestWriteApproval(input),
      raiseChallenge: (input) => {
        raised.push(input);
        return real.raiseChallenge(input);
      },
    };
  };
  const built: { watch: ChallengeWatch | null; stops: TemplateSiteStops | null } = {
    watch: null,
    stops: null,
  };
  const w = await templateMcp('standard', {
    providers: true,
    sites: [{ siteId: 'site-a.test', packId: 'site-a.test', packVersion: 1 }],
    siteHolds: { holdOf: (id) => ref.intercepts?.holdOf(id) ?? null },
    siteGuards: ({ sessions, templates }) => {
      const repos = { ...templates.repos, operatorActions: templates.actions };
      const ids = createNanoidIdGenerator({ clock });
      const stops = new TemplateSiteStops({ repos, ids, clock, logger });
      const navigations = new AgentNavigations(clock);
      const gate = new SiteToolGate({
        sites: (id) => repos.templateSites.list(id),
        lookup: () => lookup,
        intercepts: () => ref.intercepts,
        documentGuard: () => ref.documentGuard,
        overrides: () => ref.policies,
        hits: new ToolGuardHits({ sink: () => ref.hits, clock }),
        navigations,
        pageOf: (session, tab) => sessions.page(session, tab),
        clock,
        logger,
      });
      const outcomes = new ChallengeOutcomes({
        modeOf: (id) => sessions.peek(id)?.template?.mode,
        repos,
        health: () => ref.health,
        stops,
        intercepts: watched,
        lookup: () => lookup,
        transport: 'http',
        logger,
      });
      built.watch = new ChallengeWatch({
        lookup: () => lookup,
        navigations,
        outcomes,
        clock,
        logger,
      });
      built.stops = stops;
      return gate;
    },
  });
  const { harness } = w;
  const sessions = harness.services.sessions;
  const repos = harness.templates.repos;
  w.driver.attachTemplatePageWatcher({
    pageAttributed: (t, page, s) => built.watch?.watch(t, page, s),
  });
  const ops = new TemplateHostOperations({
    supervisor: w.supervisor,
    sessions,
    launcher: {},
    dataDir: harness.dataDir,
    logger,
    clock,
    drainTimeoutMs: 10_000,
  });
  const prober = new PackProber({
    lookup: () => lookup,
    openPage: maintenanceProbePages({
      launchMaintenance: (launch) => w.supervisor.launchMaintenance(launch),
      close: (id) => sessions.close(id, 'operator'),
    }),
    logger,
    ...(options.probeTimeoutMs !== undefined && { navigationMs: options.probeTimeoutMs }),
  });
  const health = new TemplateHealthService({
    repos,
    hosts: {
      runningHost: (id) => w.supervisor.runningHost(id),
      withHost: (t, fn) => ops.withHost(t, fn),
      slotFree: () => true,
    },
    clock,
    logger,
    bus: harness.bus,
    machine: 'hive-box',
    probers: packProberSelector(prober, () => lookup, selectGenericProber),
  });
  const catalog = new GuardRuleCatalog();
  const hits = new SiteGuardHitsWriter({
    describe: catalog.describe,
    bus: harness.bus,
    ids: harness.services.ids,
    warn: () => undefined,
    logger,
  });
  const intercepts = new SecurityInterceptService({
    broker: harness.attentionBroker,
    sessions,
    templates: repos.templates,
    templateSites: repos.templateSites,
    health,
    describe: catalog.describe,
    packTitle: (id) => lookup.effectiveById(id)?.pack.title ?? null,
    hits,
    bus: harness.bus,
    clock,
    logger,
    config: { transport: 'http', attentionTimeoutMs: 120_000, minAttentionWaitMs: 0 },
  });
  const policies = new TemplateWritePolicies({
    sites: repos.templateSites,
    bus: harness.bus,
    logger,
  });
  await policies.load(w.template.templateId);
  Object.assign(ref, {
    intercepts,
    hits,
    policies,
    health,
    documentGuard: documentGuardResolver({ lookup, overrides: policies, catalog, logger }),
  });
  const stops = built.stops;
  if (stops === null) throw new Error('site guards not built');
  return {
    w,
    lookup,
    intercepts,
    stops,
    health,
    hits: () =>
      harness.bus.published
        .filter((p) => p.name === 'site_pack.guard_hit')
        .map((p) => SiteGuardHitRow.parse((p.payload as { row: unknown }).row)),
    raised,
    stop: async () => {
      intercepts.stop();
      policies.stop();
      await w.stop();
    },
  };
}
