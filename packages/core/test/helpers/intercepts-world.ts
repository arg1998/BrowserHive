/** @module test/helpers/intercepts-world — the security intercepts (`SecurityInterceptService`) over the real operator-request broker with in-memory repositories, fake sessions, health and hits, and a fake clock; optionally slow storage. */

import type { DomainEvents } from '../../src/app/events/catalog.ts';
import { SecurityInterceptService } from '../../src/app/site-packs/security-intercepts.ts';
import { OperatorRequestBroker } from '../../src/domain/operator-requests/broker.ts';
import type { Session } from '../../src/domain/session/session.ts';
import type { SessionWarning } from '../../src/domain/session/warnings.ts';
import type { ProbeVerdict } from '../../src/domain/templates/probe.ts';
import type { TemplateSiteRecord } from '../../src/ports/persistence/index.ts';
import type { RequestConfirmation, RequestOwner } from '../../src/ports/request-guard.ts';
import type { GuardRuleInfo, SiteGuardHitInput } from '../../src/ports/site-guards.ts';
import { templateRecord, templateSiteRecord } from '../persistence/helpers.ts';
import { FakeClock } from './fake-clock.ts';
import { FakeIdGenerator } from './fake-id-generator.ts';
import { createVaultRepos } from './in-memory-vault-repos.ts';
import { RecordingEventBus } from './recording-event-bus.ts';
import { createCollectingLogger } from './test-logger.ts';

/** The template every fake session belongs to. */
export const TEMPLATE = templateRecord({ templateId: 'tp-aaaaaaaaaa', displayName: 'Job Hunt' });
/** The intercepts' deadline. */
export const TIMEOUT = 60_000;

function fakeSession(id: string, mode: 'live' | 'maintenance', owner: string): Session {
  const session = {
    id,
    slug: id.split('-')[0] ?? id,
    owner,
    template: { templateId: TEMPLATE.templateId, name: 'job-hunt', mode },
  };
  return session as unknown as Session;
}

const INFO: Record<string, GuardRuleInfo> = {
  'site-a.test#invite': {
    ruleId: 'site-a.test#invite',
    packId: 'site-a.test',
    guardId: 'invite',
    guardKind: 'write',
    siteTitle: 'Site A',
  },
};

/** Options of {@link interceptsWorld}. */
export interface InterceptsWorldOptions {
  readonly transport?: 'http' | 'stdio';
  readonly minWait?: number;
  /** Delays every request insert (slow storage, review PR #83 M3). */
  readonly slowInsertMs?: number;
}

/** The security intercepts over the real broker, fake sessions and a fake clock. */
export function interceptsWorld(options: InterceptsWorldOptions = {}) {
  const clock = new FakeClock(1_000_000);
  const ids = new FakeIdGenerator();
  const repos = createVaultRepos();
  const bus = new RecordingEventBus<DomainEvents>();
  const requests = Object.create(repos.requests) as typeof repos.requests;
  const slow = options.slowInsertMs;
  if (slow !== undefined) {
    requests.insert = async (record) => {
      await new Promise((r) => setTimeout(r, slow));
      return repos.requests.insert(record);
    };
  }
  const broker = new OperatorRequestBroker({
    requests,
    actions: repos.actions,
    leases: { pause: () => undefined, resume: () => undefined },
    events: bus,
    clock,
    ids,
    logger: createCollectingLogger(),
    limits: { perSession: 8, global: 256 },
  });
  const sessions = new Map<string, Session>();
  const warnings: SessionWarning[] = [];
  const hits: SiteGuardHitInput[] = [];
  const health: { site: string; verdict: ProbeVerdict }[] = [];
  /** The session each health record named (review #93 M1: whether a takeover was opened). */
  const healthSessions: ({ readonly id: string; readonly takeover: boolean } | undefined)[] = [];
  const probes: string[] = [];
  const sites: TemplateSiteRecord[] = [
    templateSiteRecord({ templateId: TEMPLATE.templateId, siteId: 'site-a.test' }),
  ];
  const intercepts = new SecurityInterceptService({
    broker,
    sessions: {
      peek: (id) => sessions.get(id),
      warn: (_s, w) => {
        warnings.push(w);
      },
    },
    templates: { get: async (id) => (id === TEMPLATE.templateId ? TEMPLATE : null) },
    templateSites: {
      list: async () => sites,
      upsert: async (record) => {
        const i = sites.findIndex((s) => s.siteId === record.siteId);
        sites[i] = record;
      },
    },
    health: {
      record: async (_t, site, verdict, _trigger, session) => {
        health.push({ site, verdict });
        healthSessions.push(session);
      },
      probe: async (_t, o) => {
        probes.push(...(o.siteIds ?? []));
        return [];
      },
    },
    describe: (id) => INFO[id] ?? null,
    requestGuardOf: (_p, g) => (g === 'invite-button' ? 'invite' : null),
    packTitle: () => 'Site A',
    hits: { write: (h) => hits.push(h) },
    bus,
    clock,
    logger: createCollectingLogger(),
    config: {
      transport: options.transport ?? 'http',
      attentionTimeoutMs: TIMEOUT,
      minAttentionWaitMs: options.minWait ?? 0,
    },
  });
  const add = (id: string, mode: 'live' | 'maintenance' = 'live', owner = 'agent-1') => {
    sessions.set(id, fakeSession(id, mode, owner));
    return id;
  };
  const write = (
    sessionId: string | null,
    over: Partial<RequestConfirmation> = {},
  ): RequestConfirmation => ({
    owner: (sessionId === null
      ? { kind: 'host' }
      : { kind: 'session', sessionId }) satisfies RequestOwner,
    ruleId: 'site-a.test#invite',
    method: 'POST',
    resourceType: 'fetch',
    url: 'https://www.site-a.test/api/invite',
    signal: new AbortController().signal,
    ...over,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    clock,
    broker,
    bus,
    intercepts,
    sessions,
    warnings,
    hits,
    health,
    healthSessions,
    probes,
    sites,
    add,
    write,
    flush,
  };
}
