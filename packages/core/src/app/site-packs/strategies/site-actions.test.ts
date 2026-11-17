/** @module app/site-packs/strategies/site-actions.test — the before-action runner with a fake clock (spec 13 §9.4): `serialize-site` across sessions with the `TEMPLATE_BUSY` `pace` refusal after 30 s and release on throw; `human-dwell` before the second action only; reads, exclusive and maintenance sessions and `sitePacks=false` are untouched; `single-focus` follows the page acted on. */

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
import { isAppError } from '../../../kernel/errors/app-error.ts';

const never = new AbortController().signal;
const click = (session: Session) => ({
  tool: 'click',
  args: { selector: '#go' },
  session,
  signal: never,
});

/** A handler that settles when the test says so. */
function deferred() {
  let settle: (fail?: Error) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    settle = (fail) => (fail === undefined ? resolve('ran') : reject(fail));
  });
  return { run: () => done, settle };
}

describe('serialize-site', () => {
  it('makes a second session wait for the first, then lets it in', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: {} }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage(`https://${SITE}/b`));
    const first = deferred();
    const running = w.runner.around(click(a), first.run);
    await flush();
    const second: { v: string | null } = { v: null };
    void w.runner
      .around(click(b), async () => 'b ran')
      .then((r) => {
        second.v = r;
      });
    await flush();
    expect(second.v).toBeNull();
    await w.clock.advance(10_000);
    first.settle();
    expect(await running).toBe('ran');
    await flush();
    expect(second.v).toBe('b ran');
  });

  it('answers TEMPLATE_BUSY pace after 30 s, naming the template site', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: { max_parallel: 1 } }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage(`https://www.${SITE}/b`));
    void w.runner.around(click(a), deferred().run);
    await flush();
    let refused: unknown = null;
    void w.runner
      .around(click(b), async () => 'b ran')
      .catch((err: unknown) => {
        refused = err;
      });
    await flush();
    await w.clock.advance(29_999);
    await flush();
    expect(refused).toBeNull();
    await w.clock.advance(1);
    await flush();
    if (!isAppError(refused)) throw new Error('expected TEMPLATE_BUSY');
    expect(refused.code).toBe('TEMPLATE_BUSY');
    expect(refused.details).toEqual({
      template: 'job-hunt',
      limit_kind: 'pace',
      limit_text: `Actions on ${SITE} are being paced.`,
      retry_after_ms: 5_000,
      retry_after_s: 5,
    });
    expect(refused.message).toBe(`Actions on ${SITE} are being paced. Retry in 5 s.`);
    expect(w.logger.has('site action paced')).toBe(true);
  });

  it('releases the turn when the handler throws', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: {} }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage(`https://${SITE}/b`));
    const first = deferred();
    const failing = w.runner.around(click(a), first.run);
    await flush();
    const second = w.runner.around(click(b), async () => 'b ran');
    first.settle(new Error('ELEMENT_NOT_ACTIONABLE'));
    await expect(failing).rejects.toThrow('ELEMENT_NOT_ACTIONABLE');
    expect(await second).toBe('b ran');
  });

  it('counts navigation targets on the site and lets reads and other sites through', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: {} }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage('https://site-b.test/'));
    void w.runner.around(click(a), deferred().run);
    await flush();
    // A read on the site, and an action on another site, do not wait.
    const read = { tool: 'snapshot', args: {}, session: b, signal: never };
    expect(await w.runner.around(read, async () => 'read')).toBe('read');
    expect(await w.runner.around(click(b), async () => 'other site')).toBe('other site');
    // A navigation of the other site's page to the site waits.
    const nav: { v: string | null } = { v: null };
    const toSite = {
      tool: 'navigate',
      args: { url: `https://${SITE}/x` },
      session: b,
      signal: never,
    };
    void w.runner
      .around(toSite, async () => 'navigated')
      .then((r) => {
        nav.v = r;
      });
    await flush();
    expect(nav.v).toBeNull();
  });

  it('leaves exclusive and maintenance sessions alone, and is inert without site packs', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: {} }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    void w.runner.around(click(a), deferred().run);
    await flush();
    const exclusive = w.add(scriptedSession('x-1', null), new StrategyPage(`https://${SITE}/a`));
    const maintenance = w.add(
      scriptedSession('m-1', 'maintenance'),
      new StrategyPage(`https://${SITE}/a`),
    );
    expect(await w.runner.around(click(exclusive), async () => 'x')).toBe('x');
    expect(await w.runner.around(click(maintenance), async () => 'm')).toBe('m');
    w.lookupOn = false;
    const c = w.add(scriptedSession('s-c'), new StrategyPage(`https://${SITE}/c`));
    expect(await w.runner.around(click(c), async () => 'c')).toBe('c');
  });

  it('an aborted wait rejects with the reason and never runs the handler', async () => {
    const w = strategiesWorld([{ id: 'serialize-site', params: {} }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage(`https://${SITE}/b`));
    void w.runner.around(click(a), deferred().run);
    await flush();
    const controller = new AbortController();
    let ran = false;
    const waiting = w.runner.around({ ...click(b), signal: controller.signal }, async () => {
      ran = true;
    });
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    expect(ran).toBe(false);
  });
});

describe('human-dwell', () => {
  it('waits a random dwell since the previous action on the site, not before the first', async () => {
    const w = strategiesWorld([{ id: 'human-dwell', params: { min_ms: 1000, max_ms: 3000 } }], {
      random: () => 0.5,
    });
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    expect(await w.runner.around(click(a), async () => 'first')).toBe('first');
    expect(w.clock.pendingSleeps).toBe(0);
    const second: { v: string | null } = { v: null };
    void w.runner
      .around(click(a), async () => 'second')
      .then((r) => {
        second.v = r;
      });
    await flush();
    expect(w.clock.pendingSleeps).toBe(1);
    await w.clock.advance(1999);
    await flush();
    expect(second.v).toBeNull();
    await w.clock.advance(1);
    await flush();
    expect(second.v).toBe('second');
  });

  it('does not delay another session or another site', async () => {
    const w = strategiesWorld([{ id: 'human-dwell', params: { min_ms: 1000, max_ms: 1000 } }]);
    const a = w.add(scriptedSession('s-a'), new StrategyPage(`https://${SITE}/a`));
    const b = w.add(scriptedSession('s-b'), new StrategyPage(`https://${SITE}/b`));
    await w.runner.around(click(a), async () => undefined);
    await w.runner.around(click(b), async () => undefined);
    expect(w.clock.pendingSleeps).toBe(0);
    w.runner.sessionClosed('s-a');
    await w.runner.around(click(a), async () => undefined);
    expect(w.clock.pendingSleeps).toBe(0);
  });
});

describe('single-focus', () => {
  it('unfocuses the site pages the template did not act on last', async () => {
    const w = strategiesWorld([{ id: 'single-focus', params: {} }]);
    const pa = new StrategyPage(`https://${SITE}/a`);
    const pb = new StrategyPage(`https://${SITE}/b`);
    const a = w.add(scriptedSession('s-a'), pa);
    const b = w.add(scriptedSession('s-b'), pb);
    await w.runner.around(click(a), async () => undefined);
    expect([w.focus.isUnfocused(asPage(pa)), w.focus.isUnfocused(asPage(pb))]).toEqual([
      false,
      true,
    ]);
    expect(new Set(w.focus.headless)).toEqual(new Set([true]));
    // `switch_tab` moves the focus without counting as an action.
    await w.runner.around(
      { tool: 'switch_tab', args: { tab_id: '0' }, session: b, signal: never },
      async () => undefined,
    );
    expect([w.focus.isUnfocused(asPage(pa)), w.focus.isUnfocused(asPage(pb))]).toEqual([
      true,
      false,
    ]);
    // The pack stops selecting it (here: site packs off): every page is focused again.
    w.lookupOn = false;
    await w.runner.reconcile();
    expect(w.focus.off.size).toBe(0);
  });

  it("tells the focus control a headed host's pages are headed", async () => {
    const w = strategiesWorld([{ id: 'single-focus', params: {} }]);
    const a = w.add(
      scriptedSession('s-a', 'live', { headless: false }),
      new StrategyPage(`https://${SITE}/a`),
    );
    w.add(
      scriptedSession('s-b', 'live', { headless: false }),
      new StrategyPage(`https://${SITE}/b`),
    );
    await w.runner.around(click(a), async () => undefined);
    expect(new Set(w.focus.headless)).toEqual(new Set([false]));
  });
});
