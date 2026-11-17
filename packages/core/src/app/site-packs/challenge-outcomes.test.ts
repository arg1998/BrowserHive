/** @module app/site-packs/challenge-outcomes.test — the outcome table of spec 13 §9.5 and **Clear stop**: an agent's `attention`/`stop` match goes to `raiseChallenge` (which records health and the stop itself), `notify` only marks the site `challenged`, maintenance sessions get nothing, without intercepts the health (and, over http, the stop) is recorded here; one `site_pack.challenge` per detection; `TemplateSiteStops` stops once, clears with an audit row and publishes `template.health`, 404 for an unknown site. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeIdGenerator } from '../../../test/helpers/fake-id-generator.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { RecordingEventBus } from '../../../test/helpers/recording-event-bus.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { DomainEvents } from '../../app/events/catalog.ts';
import { DEFAULT_CHALLENGES } from '../../domain/site-packs/challenges.ts';
import type { ProbeVerdict } from '../../domain/templates/probe.ts';
import { createCollectingLogger } from '../../infra/logging/collecting-logger.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { ChallengeInput, SecurityIntercepts } from '../../ports/security-intercepts.ts';
import { ChallengeOutcomes, type DetectedChallenge } from './challenge-outcomes.ts';
import { TemplateSiteStops } from './site-stops.ts';

const SITE = 'site-a.test';
const template = templateRecord();
const TID = template.templateId;

let repos: InMemoryRepositories & { operatorActions: InMemoryOperatorActionRepository };
let bus: RecordingEventBus<DomainEvents>;
let stops: TemplateSiteStops;
let raised: ChallengeInput[];
let recorded: { siteId: string; verdict: ProbeVerdict }[];
let withIntercepts: boolean;
let mode: 'live' | 'maintenance' | undefined;
let transport: 'http' | 'stdio';

beforeEach(async () => {
  repos = Object.assign(new InMemoryRepositories(), {
    operatorActions: new InMemoryOperatorActionRepository(),
  });
  await repos.templates.insert(template);
  await repos.templateSites.upsert(templateSiteRecord({ templateId: TID, siteId: SITE }));
  bus = new RecordingEventBus<DomainEvents>();
  const clock = new FakeClock();
  stops = new TemplateSiteStops({
    repos,
    ids: new FakeIdGenerator(),
    clock,
    logger: createCollectingLogger(),
    bus,
  });
  raised = [];
  recorded = [];
  withIntercepts = true;
  mode = 'live';
  transport = 'http';
});

function outcomes(): ChallengeOutcomes {
  const intercepts: SecurityIntercepts = {
    confirmer: null,
    holdOf: () => null,
    requestWriteApproval: async () => ({ kind: 'blocked', reason: 'no_operator' }),
    raiseChallenge: async (input) => {
      raised.push(input);
      return 'a-req1';
    },
  };
  return new ChallengeOutcomes({
    modeOf: () => mode,
    repos,
    health: () => ({
      record: async (_t, siteId, verdict) => {
        recorded.push({ siteId, verdict });
      },
    }),
    stops,
    intercepts: () => (withIntercepts ? intercepts : null),
    lookup: () => null,
    transport,
    bus,
    logger: createCollectingLogger(),
  });
}

const rule = (action: 'attention' | 'stop' | 'notify') => ({
  packId: SITE,
  id: `r-${action}`,
  kind: 'checkpoint' as const,
  action,
  match: { url: `${SITE}/x` },
});
const detected = (r: DetectedChallenge['rule']): DetectedChallenge => ({
  templateId: TID,
  sessionId: 's-1',
  pageUrl: `https://www.${SITE}/checkpoint?token=secret`,
  rule: r,
});
const site = async () => (await repos.templateSites.list(TID))[0];

describe('ChallengeOutcomes', () => {
  it('an agent session: attention and stop go to raiseChallenge only', async () => {
    await outcomes().handle(detected(rule('attention')));
    await outcomes().handle(detected(rule('stop')));
    expect(raised).toEqual([
      {
        sessionId: 's-1',
        templateId: TID,
        site: SITE,
        siteTitle: SITE,
        packId: SITE,
        challenge: { id: 'r-attention', kind: 'checkpoint', action: 'attention' },
        pageUrl: `https://www.${SITE}/checkpoint`,
      },
      expect.objectContaining({ challenge: { id: 'r-stop', kind: 'checkpoint', action: 'stop' } }),
    ]);
    expect(recorded).toEqual([]);
    expect((await site())?.stoppedAt).toBeNull();
    const events = bus.published.filter((e) => e.name === 'site_pack.challenge');
    expect(events.map((e) => e.payload)).toMatchObject([
      { kind: 'checkpoint', action: 'attention', site: SITE, session_id: 's-1' },
      { kind: 'checkpoint', action: 'stop' },
    ]);
  });

  it('notify (a provider surface) marks health only; DEFAULT_CHALLENGES carry no pack id', async () => {
    const notify = DEFAULT_CHALLENGES.find((c) => c.action === 'notify');
    if (notify === undefined) throw new Error('no notify rule');
    await outcomes().handle(detected(notify));
    expect(raised).toEqual([]);
    expect(recorded).toEqual([
      {
        siteId: SITE,
        verdict: {
          outcome: 'challenged',
          reason: 'challenge:captcha',
          finalUrl: `https://www.${SITE}/checkpoint`,
        },
      },
    ]);
    await outcomes().handle(detected(DEFAULT_CHALLENGES[0] ?? notify));
    expect(raised[0]?.packId).toBeNull();
  });

  it('maintenance sessions and gone sessions get nothing', async () => {
    mode = 'maintenance';
    await outcomes().handle(detected(rule('stop')));
    mode = undefined;
    await outcomes().handle(detected(rule('attention')));
    expect([raised, recorded, bus.published]).toEqual([[], [], []]);
  });

  it('without intercepts: health here, the stop over http only', async () => {
    withIntercepts = false;
    transport = 'stdio';
    await outcomes().handle(detected(rule('stop')));
    expect((await site())?.stoppedAt).toBeNull();
    transport = 'http';
    await outcomes().handle(detected(rule('stop')));
    expect((await site())?.stoppedAt).not.toBeNull();
    expect(recorded).toHaveLength(2);
  });
});

describe('TemplateSiteStops', () => {
  it('stops once, clears with an audit row and publishes template.health', async () => {
    expect(await stops.stop(TID, SITE)).toBe(true);
    const first = (await site())?.stoppedAt;
    await stops.stop(TID, SITE);
    expect((await site())?.stoppedAt).toBe(first ?? -1);
    const view = await stops.clear(TID, `www.${SITE}`, 'admin');
    expect(view.stopped_at).toBeNull();
    expect((await site())?.stoppedAt).toBeNull();
    expect(repos.operatorActions.rows.map((r) => [r.action, r.principalId, r.details])).toEqual([
      ['template.site.clear_stop', 'admin', { site_id: SITE, stopped_at: first ?? -1 }],
    ]);
    expect(bus.published.filter((e) => e.name === 'template.health')).toHaveLength(2);
    // Clearing a site that is not stopped changes nothing.
    await stops.clear(TID, SITE, 'admin');
    expect(repos.operatorActions.rows).toHaveLength(1);
    expect(await stops.stop(TID, 'other.test')).toBe(false);
  });

  it('answers TEMPLATE_NOT_FOUND for an unknown template or site', async () => {
    for (const [t, s] of [
      ['tp-unknown00', SITE],
      [TID, 'other.test'],
    ] as const) {
      const err = await stops.clear(t, s, 'admin').catch((e: unknown) => e);
      expect(isAppError(err) && err.code).toBe('TEMPLATE_NOT_FOUND');
    }
  });
});
