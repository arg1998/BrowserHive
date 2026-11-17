/** @module app/site-packs/strategies/site-actions-goto.test — `entry-warmup` and humanize resolution in the runner (spec 13 §9.4, lead decision 3): the first deep navigation of a session to the site loads the entry path with the referrer behind the domain guard and dwells, once; the agent's own navigation is re-armed for `navigate`; a failed warm-up is logged and never fails the navigation; `humanize-input` and `stealth-profile.humanize` force humanized input on live sessions of a template with stealth on. */

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
const warmup = (params: Record<string, string | number> = {}) => [
  { id: 'entry-warmup' as const, params: { path: '/start', dwell_ms: 1500, ...params } },
];

function goto(session: Session, page: StrategyPage, url: string, tool = 'navigate') {
  return { tool, session, page: asPage(page), url, timeoutMs: 30_000, signal: never };
}

/** Runs `beforeGoto`, advancing the fake clock through the dwell. */
async function warm(
  w: ReturnType<typeof strategiesWorld>,
  call: ReturnType<typeof goto>,
): Promise<number> {
  const used = w.runner.beforeGoto(call);
  await flush();
  // The fixture's dwell (1500 ms); a warm-up that does not run leaves the clock alone.
  if (w.clock.pendingSleeps > 0) await w.clock.advance(1_500);
  return await used;
}

describe('entry-warmup', () => {
  it("loads the entry path with the referrer before the session's first deep link, once", async () => {
    const w = strategiesWorld(warmup({ referrer: 'same-site' }));
    const page = new StrategyPage();
    const s = w.add(scriptedSession('s-a'), page);
    const target = `https://www.${SITE}/jobs/42`;
    const used = await warm(w, goto(s, page, target));
    expect(page.gotos).toEqual([
      { url: `https://www.${SITE}/start`, referer: `https://www.${SITE}/`, timeout: 13_500 },
    ]);
    expect(page.routes).toBe(0);
    expect(used).toBe(1500);
    // The agent's own navigation is expected again (the warm-up's commit consumed it).
    expect(w.expected).toEqual([{ page: asPage(page), url: target }]);
    expect(await warm(w, goto(s, page, `https://www.${SITE}/jobs/43`))).toBe(0);
    expect(page.gotos).toHaveLength(1);
  });

  it('uses the probe host for other hosts, the search referrer, and no re-arm for new_tab', async () => {
    const w = strategiesWorld(warmup({ referrer: 'search' }));
    const page = new StrategyPage();
    const s = w.add(scriptedSession('s-a'), page);
    await warm(w, goto(s, page, `https://m.${SITE}/deep`, 'new_tab'));
    expect(page.gotos[0]).toMatchObject({
      url: `https://www.${SITE}/start`,
      referer: 'https://www.google.com/',
    });
    expect(w.expected).toEqual([]);
  });

  it('does not warm up a first navigation to the root, or after one', async () => {
    const w = strategiesWorld(warmup());
    const page = new StrategyPage();
    const s = w.add(scriptedSession('s-a'), page);
    expect(await warm(w, goto(s, page, `https://www.${SITE}/`))).toBe(0);
    expect(await warm(w, goto(s, page, `https://www.${SITE}/deep`))).toBe(0);
    expect(page.gotos).toEqual([]);
  });

  it('does not warm up when a page of the session already shows the site', async () => {
    const w = strategiesWorld(warmup());
    const page = new StrategyPage(`https://www.${SITE}/somewhere`);
    const s = w.add(scriptedSession('s-a'), page);
    expect(await warm(w, goto(s, page, `https://www.${SITE}/deep`))).toBe(0);
    expect(page.gotos).toEqual([]);
  });

  it('logs a failed warm-up and lets the navigation go on', async () => {
    const w = strategiesWorld(warmup());
    const page = new StrategyPage();
    page.failNext = new Error('net::ERR_BLOCKED_BY_CLIENT');
    const s = w.add(scriptedSession('s-a'), page);
    const used = await warm(w, goto(s, page, `https://www.${SITE}/deep`));
    expect(used).toBe(0);
    expect(w.logger.has('entry warm-up failed')).toBe(true);
    expect(page.routes).toBe(0);
  });

  it('skips sessions other than live ones, packs without it, short timeouts and sitePacks=false', async () => {
    const w = strategiesWorld(warmup());
    const page = new StrategyPage();
    const maintenance = w.add(scriptedSession('m-1', 'maintenance'), page);
    expect(await warm(w, goto(maintenance, page, `https://www.${SITE}/deep`))).toBe(0);
    const s = w.add(scriptedSession('s-a'), page);
    expect(await warm(w, { ...goto(s, page, `https://www.${SITE}/deep`), timeoutMs: 4_000 })).toBe(
      0,
    );
    expect(w.logger.has('warm-up skipped')).toBe(true);
    const off = strategiesWorld(warmup());
    off.lookupOn = false;
    const t = off.add(scriptedSession('s-b'), page);
    expect(await warm(off, goto(t, page, `https://www.${SITE}/deep`))).toBe(0);
    const none = strategiesWorld([]);
    const u = none.add(scriptedSession('s-c'), page);
    expect(await warm(none, goto(u, page, `https://www.${SITE}/deep`))).toBe(0);
    expect(page.gotos).toEqual([]);
  });
});

describe('humanize resolution', () => {
  const url = `https://www.${SITE}/feed`;

  it('humanize-input forces humanized input on the site only', () => {
    const w = strategiesWorld([{ id: 'humanize-input', params: {} }]);
    const s = scriptedSession('s-a');
    expect(w.runner.forcesHumanize(s, url)).toBe(true);
    expect(w.runner.forcesHumanize(s, 'https://site-b.test/')).toBe(false);
    expect(w.runner.forcesHumanize(scriptedSession('m-1', 'maintenance'), url)).toBe(false);
    expect(w.runner.forcesHumanize(scriptedSession('x-1', null), url)).toBe(false);
  });

  it('stealth-profile forces it only with humanize: true', () => {
    const on = strategiesWorld([{ id: 'stealth-profile', params: { humanize: true } }]);
    expect(on.runner.forcesHumanize(scriptedSession('s-a'), url)).toBe(true);
    const off = strategiesWorld([{ id: 'stealth-profile', params: { min_level: 'max' } }]);
    expect(off.runner.forcesHumanize(scriptedSession('s-a'), url)).toBe(false);
  });

  it('is ignored for a template with stealth off, logged once per template', () => {
    const w = strategiesWorld([{ id: 'humanize-input', params: {} }]);
    const s = scriptedSession('s-a', 'live', { stealth: false });
    expect(w.runner.forcesHumanize(s, url)).toBe(false);
    expect(w.runner.forcesHumanize(s, url)).toBe(false);
    const warned = w.logger.records.filter((r) => r.msg === 'humanize not forced');
    expect(warned).toHaveLength(1);
  });

  it('is inert without site packs', () => {
    const w = strategiesWorld([{ id: 'humanize-input', params: {} }]);
    w.lookupOn = false;
    expect(w.runner.forcesHumanize(scriptedSession('s-a'), url)).toBe(false);
  });
});
