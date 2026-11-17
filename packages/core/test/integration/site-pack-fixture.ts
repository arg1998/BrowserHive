/** @module test/integration/site-pack-fixture — a fixture pack for `site-a.test` over the real MCP stack and a real template host (spec 13 §9.3, §9.5, §8.1, §14): the tool gate, the challenge watch on the host's pages, the stops, the pack prober and a minimal in-test `SecurityIntercepts` over the real operator-request broker (WP-E1 ships the real one; the lead re-runs these suites with it). */

import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import { AgentNavigations } from '../../src/app/site-packs/agent-navigations.ts';
import { ChallengeOutcomes } from '../../src/app/site-packs/challenge-outcomes.ts';
import { ChallengeWatch } from '../../src/app/site-packs/challenge-watch.ts';
import { PackProber, packProberSelector } from '../../src/app/site-packs/pack-prober.ts';
import { maintenanceProbePages } from '../../src/app/site-packs/probe-pages.ts';
import { siteOperatorPending } from '../../src/app/site-packs/site-errors.ts';
import { TemplateSiteStops } from '../../src/app/site-packs/site-stops.ts';
import { SITE_HOLD_EXEMPT_TOOLS, SiteToolGate } from '../../src/app/site-packs/tool-gate.ts';
import { ToolGuardHits } from '../../src/app/site-packs/tool-guard-hits.ts';
import { TemplateHostOperations } from '../../src/app/templates/host-operations.ts';
import { selectGenericProber } from '../../src/app/templates/site-prober.ts';
import { TemplateHealthService } from '../../src/app/templates/template-health.ts';
import type { OperatorRequestBroker } from '../../src/domain/operator-requests/broker.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createNanoidIdGenerator } from '../../src/infra/ids/nanoid-id-generator.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { registrableDomain } from '../../src/kernel/url.ts';
import type { SiteGuardHitRecord } from '../../src/ports/persistence/site-packs.ts';
import type {
  ChallengeInput,
  SecurityIntercepts,
  SiteHold,
  WriteApprovalResult,
} from '../../src/ports/security-intercepts.ts';
import type { EffectivePack, SitePackLookup } from '../../src/ports/site-packs.ts';
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

/** A minimal `SecurityIntercepts` over the broker: site checks only (one open per session). */
export class TestIntercepts implements SecurityIntercepts {
  readonly confirmer = null;
  readonly raised: ChallengeInput[] = [];
  readonly #open = new Map<string, { requestId: string; site: string }>();

  constructor(
    private readonly broker: OperatorRequestBroker,
    private readonly ownerOf: (sessionId: string) => string,
  ) {}

  holdOf(sessionId: string): SiteHold | null {
    const open = this.#open.get(sessionId);
    if (open === undefined) return null;
    if (!this.broker.hasOpen(sessionId, (r) => r.requestId === open.requestId)) return null;
    return { requestId: open.requestId, site: open.site, reason: 'challenge' };
  }

  async requestWriteApproval(): Promise<WriteApprovalResult> {
    return { kind: 'blocked', reason: 'no_operator' };
  }

  async raiseChallenge(input: ChallengeInput): Promise<string | null> {
    const held = this.holdOf(input.sessionId);
    if (held !== null) return held.requestId;
    this.raised.push(input);
    const handle = await this.broker.open({
      kind: 'security_intercept',
      sessionId: input.sessionId,
      owner: this.ownerOf(input.sessionId),
      reason: `${input.siteTitle} security check`,
      mode: 'takeover',
      pageUrl: input.pageUrl,
      options: {
        reason: 'challenge',
        site: input.site,
        challenge: input.challenge.id,
        kind: input.challenge.kind,
        action: input.challenge.action,
        page_url: input.pageUrl,
      },
    });
    this.#open.set(input.sessionId, { requestId: handle.id, site: input.site });
    return handle.id;
  }
}

/** One test's world. */
export interface PackWorld {
  readonly w: TemplateMcp;
  readonly lookup: FixtureLookup;
  readonly intercepts: TestIntercepts | null;
  readonly stops: TemplateSiteStops;
  readonly health: TemplateHealthService;
  readonly hits: readonly SiteGuardHitRecord[];
  stop(): Promise<void>;
}

/** The fixture pack's world; `intercepts: false` leaves the session without requests (health only). */
export async function packWorld(
  pack: SitePackV1 = fixturePack(),
  options: { readonly intercepts?: boolean; readonly probeTimeoutMs?: number } = {},
): Promise<PackWorld> {
  const clock = createSystemClock();
  const logger = createCollectingLogger();
  const ids = createNanoidIdGenerator({ clock });
  const lookup = new FixtureLookup(pack);
  const hits: SiteGuardHitRecord[] = [];
  const late: {
    watch: ChallengeWatch | null;
    health: TemplateHealthService | null;
    intercepts: TestIntercepts | null;
    stops: TemplateSiteStops | null;
  } = { watch: null, health: null, intercepts: null, stops: null };
  const w = await templateMcp('standard', {
    providers: true,
    sites: [{ siteId: 'site-a.test', packId: 'site-a.test', packVersion: 1 }],
    pageWatcher: { pageAttributed: (t, page, s) => late.watch?.watch(t, page, s) },
    siteGuards: ({ sessions, templates, broker }) => {
      const repos = { ...templates.repos, operatorActions: templates.actions };
      const intercepts =
        options.intercepts === false
          ? null
          : new TestIntercepts(broker, (id) => sessions.peek(id)?.owner ?? 'local');
      const stops = new TemplateSiteStops({ repos, ids, clock, logger });
      const navigations = new AgentNavigations(clock);
      const gate = new SiteToolGate({
        sites: (id) => repos.templateSites.list(id),
        lookup: () => lookup,
        intercepts: () => intercepts,
        hits: new ToolGuardHits({ sink: (r) => hits.push(r), ids, clock }),
        navigations,
        pageOf: (session, tab) => sessions.page(session, tab),
        clock,
        logger,
      });
      const outcomes = new ChallengeOutcomes({
        modeOf: (id) => sessions.peek(id)?.template?.mode,
        repos,
        health: () => late.health,
        stops,
        intercepts: () => intercepts,
        lookup: () => lookup,
        transport: 'http',
        logger,
      });
      late.watch = new ChallengeWatch({
        lookup: () => lookup,
        navigations,
        outcomes,
        clock,
        logger,
      });
      late.intercepts = intercepts;
      late.stops = stops;
      return {
        // The tool hold is WP-E1's dispatcher policy; simulated here over the same port.
        async beforeTool(call) {
          const hold = intercepts?.holdOf(call.session.id) ?? null;
          if (hold !== null && !SITE_HOLD_EXEMPT_TOOLS.has(call.tool)) {
            throw siteOperatorPending(call.session.id, hold.site, hold.requestId, 'challenge');
          }
          await gate.beforeTool(call);
        },
      };
    },
  });
  const sessions = w.harness.services.sessions;
  const ops = new TemplateHostOperations({
    supervisor: w.supervisor,
    sessions,
    launcher: {},
    dataDir: w.harness.dataDir,
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
    repos: w.harness.templates.repos,
    hosts: {
      runningHost: (id) => w.supervisor.runningHost(id),
      withHost: (t, fn) => ops.withHost(t, fn),
      slotFree: () => true,
    },
    clock,
    logger,
    machine: 'hive-box',
    probers: packProberSelector(prober, () => lookup, selectGenericProber),
  });
  late.health = health;
  const stops = late.stops;
  if (stops === null) throw new Error('site guards not built');
  return {
    w,
    lookup,
    intercepts: late.intercepts,
    stops,
    health,
    hits,
    stop: () => w.stop(),
  };
}
