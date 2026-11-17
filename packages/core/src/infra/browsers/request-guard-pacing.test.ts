/** @module infra/browsers/request-guard-pacing.test — `pace-writes` in the request guard (spec 13 §9.4): asked before the action of `allow`, `warn` and `confirm` rules (never for `block`); a refused write is aborted with a `paced` hit; a held one waits for its token, records `held` and then meets its rule's action; a held write whose request goes away is aborted and its token released. */

import { describe, expect, it } from 'bun:test';
import type { Request } from 'patchright';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import {
  compileRequestGuardRules,
  type RequestGuardRuleInput,
  RequestGuardRuleSet,
} from '../../domain/policies/request-guard.ts';
import type { WritePaceVerdict } from '../../ports/write-pacing.ts';
import { InMemoryRequestGuardHits } from '../audit/in-memory-guard-hits.ts';
import { createCollectingLogger } from '../logging/collecting-logger.ts';
import type { InterceptionContext } from './interception-chain.ts';
import { requestGuardHandler } from './request-guard-route.ts';

const T0 = 9_000;

function setup(rule: RequestGuardRuleInput, verdict: () => WritePaceVerdict) {
  const compiled = compileRequestGuardRules([rule]);
  if (!compiled.ok) throw new Error('bad fixture');
  const clock = new FakeClock(T0);
  const hits = new InMemoryRequestGuardHits();
  const asked: string[] = [];
  const guard = requestGuardHandler({
    rules: new RequestGuardRuleSet(compiled.value),
    hits,
    confirmer: {
      confirm: async () => ({ outcome: 'approved', decidedBy: 'op', requestId: 'r1' }),
    },
    pace: async (ruleId) => {
      asked.push(ruleId);
      return verdict();
    },
    clock,
    logger: createCollectingLogger(),
  });
  const controller = new AbortController();
  const context: InterceptionContext = {
    owner: async () => ({ kind: 'session', sessionId: 'sess-1' }),
    signal: () => controller.signal,
  };
  const request = {
    url: () => 'https://site.test/api/invite',
    method: () => 'POST',
    resourceType: () => 'fetch',
  } as unknown as Request;
  const handle = () => guard.handle(request, context);
  const flush = () => Bun.sleep(0);
  return { clock, hits, asked, controller, handle, flush };
}

const WRITE = (action: RequestGuardRuleInput['action']): RequestGuardRuleInput => ({
  id: 'site.test#invite',
  url: 'site.test/api/invite*',
  methods: ['POST'],
  action,
});

describe('request guard pacing', () => {
  it('a refused write is aborted with a paced hit; the rule action never runs', async () => {
    const s = setup(WRITE('confirm'), () => ({ kind: 'refuse', retryAfterMs: 120_000 }));
    expect(await s.handle()).toEqual({ kind: 'abort', reason: 'blockedbyclient' });
    await s.flush();
    expect(s.hits.list().map((h) => [h.action, h.ruleAction, h.sessionId])).toEqual([
      ['paced', 'confirm', 'sess-1'],
    ]);
  });

  it('a held write waits for its token, records held, then meets its action', async () => {
    const s = setup(WRITE('warn'), () => ({
      kind: 'hold',
      holdMs: 30_000,
      release: () => undefined,
    }));
    const verdict = s.handle();
    await s.flush();
    expect(s.hits.list()).toEqual([]);
    await s.clock.advance(30_000);
    expect(await verdict).toEqual({ kind: 'pass' });
    await s.flush();
    expect(s.hits.list().map((h) => [h.action, h.ts])).toEqual([
      ['held', T0 + 30_000],
      ['warn', T0 + 30_000],
    ]);
  });

  it('a held write whose request goes away is aborted and its token released', async () => {
    let released = 0;
    const s = setup(WRITE('allow'), () => ({
      kind: 'hold',
      holdMs: 30_000,
      release: () => {
        released += 1;
      },
    }));
    const verdict = s.handle();
    await s.flush();
    s.controller.abort();
    expect(await verdict).toEqual({ kind: 'abort', reason: 'blockedbyclient' });
    expect(released).toBe(1);
    await s.flush();
    expect(s.hits.list()).toEqual([]);
  });

  it('pass goes straight to the action; block rules are never paced', async () => {
    const s = setup(WRITE('allow'), () => ({ kind: 'pass' }));
    expect(await s.handle()).toEqual({ kind: 'pass' });
    const b = setup(WRITE('block'), () => ({ kind: 'refuse', retryAfterMs: 1 }));
    expect(await b.handle()).toEqual({ kind: 'abort', reason: 'blockedbyclient' });
    await b.flush();
    expect(b.asked).toEqual([]);
    expect(b.hits.list().map((h) => h.action)).toEqual(['block']);
  });
});
