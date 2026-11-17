/** @module test/integration/site-pack-strategies-network-fixture — a template on the fixture site `site-a.test` over the real MCP stack and a real template host, with T3b WP-N's network and host strategies armed as the composition arms them: the request guard with the write pacer (`pace-writes`, `ramp-up`), the host response watch (`device-bound-session`), the host switches and their restart (`webrtc-policy`), the keeper with its record of agent loads (`keep-alive`) and the pack prober (D48). `packs: false` builds the world as `sitePacks=false` leaves it: no guard, no watcher, no switches, no keeper. */

import { readFileSync } from 'node:fs';
import { SitePackV1, type SitePackV1Input } from '@browserhive/contracts/site-packs';
import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { DeviceBindingWatch } from '../../src/app/site-packs/device-binding.ts';
import { SiteKeeper } from '../../src/app/site-packs/keeper.ts';
import { WritePacer } from '../../src/app/site-packs/pacer.ts';
import { PackProber, packProberSelector } from '../../src/app/site-packs/pack-prober.ts';
import { maintenanceProbePages } from '../../src/app/site-packs/probe-pages.ts';
import { AgentSiteVisits } from '../../src/app/site-packs/site-visits.ts';
import { HostFlagsWatch } from '../../src/app/site-packs/webrtc-host-flags.ts';
import { TemplateWritePolicies } from '../../src/app/site-packs/write-policies.ts';
import { TemplateHostOperations } from '../../src/app/templates/host-operations.ts';
import { selectGenericProber } from '../../src/app/templates/site-prober.ts';
import { TemplateHealthService } from '../../src/app/templates/template-health.ts';
import { createSystemClock } from '../../src/infra/clock/system-clock.ts';
import { createCollectingLogger } from '../../src/infra/logging/collecting-logger.ts';
import { SiteGuardHitsWriter } from '../../src/infra/site-packs/guard-hits-writer.ts';
import { GuardRuleCatalog } from '../../src/infra/site-packs/guard-rules.ts';
import { templateRequestGuard } from '../../src/infra/site-packs/template-guard.ts';
import type { Clock } from '../../src/ports/clock.ts';
import type { SitePackLookup } from '../../src/ports/site-packs.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { InMemoryUnitOfWork } from '../helpers/in-memory-repos.ts';
import { FixtureLookup } from './site-pack-fixture.ts';
import type { StealthLeg } from './template-fixture.ts';
import { type TemplateMcp, templateMcp } from './template-mcp-fixture.ts';

/** The fixture site. */
export const SITE = 'site-a.test';

/** How much faster than real time the pacer's clock runs (a 30 s hold takes 0.6 s). */
export const PACE_TIME_SCALE = 50;

/** A pack for the fixture site with a `write` guard on `/api/invite` and `extra` fields. */
export function strategyPack(extra: Partial<SitePackV1Input> = {}): SitePackV1 {
  return SitePackV1.parse({
    schema: 1,
    id: SITE,
    version: 1,
    min_client: '0.3.0',
    title: 'Site A',
    domains: [SITE],
    sign_in: { url: { host: SITE, path: '/login' }, human_only: false },
    signed_in: {
      probe: { host: SITE, path: '/strategies/stays' },
      kind: 'either',
      signed_out_redirects: [`${SITE}/login*`],
    },
    guards: [
      {
        id: 'invite',
        kind: 'write',
        match: { url: `${SITE}/api/invite*`, methods: ['POST'] },
        action: 'write_policy',
      },
    ],
    write_policy: { default: 'confirm', stance: 'prohibited' },
    ...extra,
  });
}

/** A pace rule on the `invite` guard. */
export function inviteRule(per: 'minute' | 'hour', limit: number) {
  return {
    id: 'invites',
    guard: 'invite',
    per,
    limit,
    kind: 'vendor' as const,
    source: { url: 'https://example.org/limits', kind: 'vendor' as const },
  };
}

/** Real time sped up {@link PACE_TIME_SCALE} times (the pacer and the guard's holds). */
export function fastClock(): Clock {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * PACE_TIME_SCALE,
    sleep: (ms, signal) => createSystemClock().sleep(ms / PACE_TIME_SCALE, signal),
  };
}

/** One test's world. */
export interface NetworkWorld {
  readonly w: TemplateMcp;
  readonly lookup: FixtureLookup;
  readonly ops: TemplateHostOperations;
  readonly health: TemplateHealthService;
  readonly flags: HostFlagsWatch;
  readonly keeper: SiteKeeper;
  readonly keeperClock: FakeClock;
  readonly prober: PackProber;
  /** Every `site_pack.guard_hit` row action, in order. */
  hitActions(): string[];
  /** `session.warning` codes published for `sessionId`. */
  warnings(sessionId: string): string[];
  /** How many requests the fixture site received on `path` (prefix). */
  seen(path: string, method?: string): number;
  /** The running host's browser command line (Linux `/proc`); `null` when it cannot be read. */
  commandLine(): Promise<string[] | null>;
  stop(): Promise<void>;
}

/** Options of {@link networkWorld}. */
export interface NetworkWorldOptions {
  readonly pack?: SitePackV1;
  readonly stealth?: StealthLeg;
  /** `false`: the world `sitePacks=false` leaves (nothing of the layer is built). */
  readonly packs?: boolean;
  /** The template's `created_at` the pacer reads (`ramp-up`); default 90 days old. */
  readonly createdAt?: () => number;
}

/** Builds the world; the pacer and the guard's holds run on {@link fastClock}. */
export async function networkWorld(options: NetworkWorldOptions = {}): Promise<NetworkWorld> {
  const on = options.packs !== false;
  const lookup = new FixtureLookup(options.pack ?? strategyPack());
  const lookupOrNull = (): SitePackLookup | null => (on ? lookup : null);
  const logger = createCollectingLogger();
  const clock = createSystemClock();
  const pace = fastClock();
  const keeperClock = new FakeClock(Date.now());
  // Built once the world exists; the host spec asks it only at a host start.
  const late: { flags: HostFlagsWatch | null } = { flags: null };
  const w = await templateMcp(options.stealth ?? 'standard', {
    sites: [{ siteId: SITE, packId: SITE, writePolicy: 'allow' }],
    ...(on && {
      hostFlags: (t) => {
        if (late.flags === null) throw new Error('flags not built');
        return late.flags.hostFlags(t);
      },
    }),
  });
  const { harness } = w;
  const sessions = harness.services.sessions;
  const repos = harness.templates.repos;
  const uow = new InMemoryUnitOfWork({ ...repos, operatorActions: harness.templates.actions });
  const ops = new TemplateHostOperations({
    supervisor: w.supervisor,
    sessions,
    launcher: {},
    dataDir: harness.dataDir,
    logger,
    clock,
    drainTimeoutMs: 5_000,
  });
  const flags = new HostFlagsWatch({
    sites: repos.templateSites,
    lookup: lookupOrNull,
    running: (id) => w.supervisor.runningHost(id) != null,
    restart: () => ops.restartHost(w.template),
    bus: harness.bus,
    logger,
  });
  late.flags = flags;
  const visits = new AgentSiteVisits({
    isAgent: (id) => sessions.peek(id)?.template?.mode === 'live',
    clock: keeperClock,
  });
  const binding = new DeviceBindingWatch({
    lookup: lookupOrNull,
    uow,
    changed: (id) => harness.bus.publish('template.changed', changedEvent(id)),
    logger,
  });
  if (on) {
    w.driver.attachTemplatePageWatcher({
      pageAttributed: (t, page, s) => visits.pageAttributed(t, page, s),
      responseReceived: (t, response) => binding.responseReceived(t, response),
    });
    const catalog = new GuardRuleCatalog();
    const hits = new SiteGuardHitsWriter({
      describe: catalog.describe,
      bus: harness.bus,
      ids: harness.services.ids,
      warn: (id, warning) => {
        const session = sessions.peek(id);
        if (session !== undefined) sessions.warn(session, warning);
      },
      logger,
    });
    w.driver.setTemplateRequestGuard(
      templateRequestGuard({
        lookup,
        overrides: new TemplateWritePolicies({
          sites: repos.templateSites,
          bus: harness.bus,
          logger,
        }),
        catalog,
        hits,
        confirmer: null,
        pacer: new WritePacer({
          describe: catalog.describe,
          lookup,
          templates: {
            get: async () => ({
              ...w.template,
              createdAt: options.createdAt?.() ?? pace.now() - 90 * 86_400_000,
            }),
          },
          sites: repos.templateSites,
          clock: pace,
          random: () => 0,
          logger,
        }),
        clock: pace,
        logger,
      }),
    );
  }
  const prober = new PackProber({
    lookup: lookupOrNull,
    openPage: maintenanceProbePages({
      launchMaintenance: (launch) => w.supervisor.launchMaintenance(launch),
      close: (id) => sessions.close(id, 'operator'),
    }),
    logger,
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
    probers: packProberSelector(prober, lookupOrNull, selectGenericProber),
  });
  const keeper = new SiteKeeper({
    repos,
    lookup: lookupOrNull,
    visits,
    hosts: {
      runningHost: (id) => w.supervisor.runningHost(id),
      withHost: (t, fn) => ops.withHost(t, fn),
      slotFree: () => true,
    },
    visit: (ctx, path) => prober.visit(ctx, path),
    record: (t, site, verdict) => health.record(t, site, verdict, 'schedule'),
    clock: keeperClock,
    random: () => 0.5,
    logger,
  });
  const published = () => harness.bus.published;
  return {
    w,
    lookup,
    ops,
    health,
    flags,
    keeper,
    keeperClock,
    prober,
    hitActions: () =>
      published()
        .filter((p) => p.name === 'site_pack.guard_hit')
        .map((p) => (p.payload as { row: { action: string } }).row.action),
    warnings: (sessionId) =>
      published()
        .filter((p) => p.name === 'session.warning')
        .map((p) => p.payload as { session_id: string; code: string })
        .filter((p) => p.session_id === sessionId)
        .map((p) => p.code),
    seen: (path, method) =>
      w.sites.requests.filter(
        (r) => r.path.startsWith(path) && (method === undefined || r.method === method),
      ).length,
    commandLine: async () => {
      const pid = await w.supervisor.runningHost(w.template.templateId)?.browserPid?.();
      if (pid == null || process.platform !== 'linux') return null;
      // Chromium rewrites its argv into one space-separated string.
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .replaceAll('\u0000', ' ')
        .split(' ')
        .filter(Boolean);
    },
    stop: async () => {
      flags.stop();
      await w.stop();
    },
  };
}

function changedEvent(templateId: string): DomainEvents['template.changed'] {
  return {
    type: 'template.changed',
    template: { template_id: templateId },
  } as unknown as DomainEvents['template.changed'];
}

/** Polls `check` until true. */
export async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
