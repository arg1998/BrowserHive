/** @module app/site-packs/strategies/site-actions-recheck.test — the site gate runs again after a before-action strategy wait (review PR #84 H2, spec 13 §9.4): after the `human-dwell` sleep and the `serialize-site` queue, before the focus arbitration and the handler; a refusal releases the turn and runs nothing; a call that waited for nothing is not re-checked; after an `entry-warmup` the gate runs before the agent's own navigation. */

import { describe, expect, it } from 'bun:test';
import {
  asPage,
  flush,
  SITE,
  StrategyPage,
  scriptedSession,
  strategiesWorld,
} from '../../../../test/helpers/site-actions-kit.ts';
import type { Session } from '../../../domain/session/session.ts';

const never = new AbortController().signal;
const click = (session: Session) => ({
  tool: 'click',
  args: { selector: '#go' },
  session,
  signal: never,
});

/** A handler that settles when the test says so. */
function deferred() {
  let settle: () => void = () => undefined;
  const done = new Promise<string>((resolve) => {
    settle = () => resolve('ran');
  });
  return { run: () => done, settle };
}

describe('re-check after the strategy waits', () => {
  it('a queued call re-checks once it has its turn, before the focus arbitration and the handler', async () => {
    const w = strategiesWorld([
      { id: 'serialize-site', params: { max_parallel: 1 } },
      { id: 'single-focus', params: {} },
    ]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const pb = new StrategyPage(`https://${SITE}/b`);
    const b = w.add(scriptedSession('s-b'), pb);
    const order: string[] = [];
    const first = deferred();
    const running = w.runner.around(click(a), first.run, async () => void order.push('a:recheck'));
    await flush();
    const queued = w.runner.around(
      click(b),
      async () => {
        order.push('b:run');
        return 'b ran';
      },
      async () => {
        order.push(`b:recheck focus-b-off=${w.focus.off.has(asPage(pb))}`);
      },
    );
    await flush();
    expect(order).toEqual([]);
    first.settle();
    await running;
    expect(await queued).toBe('b ran');
    // A had its turn at once: no re-check. B's re-check ran while B's page was still unfocused
    // (the arbitration comes after it), then the handler.
    expect(order).toEqual(['b:recheck focus-b-off=true', 'b:run']);
  });

  it('a refused re-check runs nothing and releases the turn for the next session', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: { max_parallel: 1 } }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage(`https://${SITE}/b`));
    const c = w.add(scriptedSession('s-c'), new StrategyPage(`https://${SITE}/c`));
    const first = deferred();
    const running = w.runner.around(click(a), first.run);
    await flush();
    let ranB = false;
    const held = w.runner.around(
      click(b),
      async () => {
        ranB = true;
        return 'b ran';
      },
      async () => {
        throw new Error('SITE_OPERATOR_PENDING');
      },
    );
    await flush();
    const next = w.runner.around(click(c), async () => 'c ran');
    await flush();
    first.settle();
    await running;
    await expect(held).rejects.toThrow('SITE_OPERATOR_PENDING');
    expect(ranB).toBe(false);
    expect(await next).toBe('c ran');
  });

  it('re-checks after a dwell sleep, and not when the call waited for nothing', async () => {
    const w = strategiesWorld([{ id: 'human-dwell', params: { min_ms: 2000, max_ms: 2000 } }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const rechecks: string[] = [];
    await w.runner.around(
      click(a),
      async () => undefined,
      async () => void rechecks.push('1'),
    );
    expect(rechecks).toEqual([]);
    const second = w.runner.around(
      click(a),
      async () => void rechecks.push('run'),
      async () => void rechecks.push('2'),
    );
    await flush();
    await w.clock.advance(2_000);
    await second;
    expect(rechecks).toEqual(['2', 'run']);
  });
});

describe('re-check after an entry warm-up', () => {
  it("runs the gate after the warm-up; a refusal stops the agent's own navigation", async () => {
    const w = strategiesWorld([{ id: 'entry-warmup', params: { path: '/start', dwell_ms: 1500 } }]);
    const page = new StrategyPage();
    const s = w.add(scriptedSession('s-a'), page);
    const seen: string[] = [];
    const used = w.runner.beforeGoto({
      tool: 'navigate',
      session: s,
      page: asPage(page),
      url: `https://www.${SITE}/jobs/42`,
      timeoutMs: 30_000,
      signal: never,
      recheck: async () => {
        seen.push(page.href);
        throw new Error('SITE_OPERATOR_PENDING');
      },
    });
    await flush();
    await w.clock.advance(1_500);
    await expect(used).rejects.toThrow('SITE_OPERATOR_PENDING');
    // The gate saw the page on the entry path, after the warm-up's load and dwell.
    expect(seen).toEqual([`https://www.${SITE}/start`]);
    expect(page.gotos.map((g) => g.url)).toEqual([`https://www.${SITE}/start`]);
  });
});
