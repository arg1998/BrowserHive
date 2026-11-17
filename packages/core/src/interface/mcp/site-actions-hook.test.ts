/** @module interface/mcp/site-actions-hook.test — the dispatcher's hooks for the before-action strategies (spec 13 §9.4, §9.6): `around` wraps the handler of tools on a session with the parsed arguments, after the policies; a refusal it throws is the call's result and the handler does not run; `navigate` asks for the warm-up and shrinks its timeout by the time used; a site forcing humanized input takes the humanized path for a session without `humanize`; the site gate is handed over as the re-check after a strategy wait (`around`, and `beforeGoto` for the warm-up), each run getting the decisions of the earlier ones (review PR #84 H2). */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../test/helpers/fake-transport.ts';
import { spyPageActions } from '../../../test/helpers/tool-fakes.ts';
import { executeTool } from '../../../test/helpers/tool-run.ts';
import { templatePaced } from '../../app/site-packs/strategies/pace-busy.ts';
import type { SiteActionsLike } from './services.ts';

let h: ToolHarness;
afterEach(async () => h.close());

interface Recorded {
  around: { tool: string; args: Record<string, unknown>; session: string }[];
  gotos: { tool: string; url: string; timeoutMs: number }[];
}

function recordingActions(options: { refuse?: string; forced?: boolean; warmupMs?: number } = {}): {
  recorded: Recorded;
  actions: SiteActionsLike;
} {
  const recorded: Recorded = { around: [], gotos: [] };
  return {
    recorded,
    actions: {
      async around(call, run) {
        recorded.around.push({ tool: call.tool, args: { ...call.args }, session: call.session.id });
        if (call.tool === options.refuse) throw templatePaced('job-hunt', 'site-a.test');
        return await run();
      },
      async beforeGoto(call) {
        recorded.gotos.push({ tool: call.tool, url: call.url, timeoutMs: call.timeoutMs });
        return options.warmupMs ?? 0;
      },
      forcesHumanize: () => options.forced === true,
    },
  };
}

describe('dispatcher hooks of the before-action strategies', () => {
  it('wraps tools on a session with their parsed arguments; not the session-less ones', async () => {
    const { recorded, actions } = recordingActions();
    h = await createToolHarness({ siteActions: () => actions });
    const id = await h.launch();
    await executeTool(h, 'click', { session_id: id, selector: '#go' });
    await executeTool(h, 'server_status', {});
    expect(recorded.around).toEqual([
      {
        tool: 'click',
        args: expect.objectContaining({ session_id: id, selector: '#go', timeout: 30_000 }),
        session: id,
      },
    ]);
  });

  it('a refusal is the result and the handler does not run', async () => {
    const { actions } = recordingActions({ refuse: 'click' });
    h = await createToolHarness({ siteActions: () => actions });
    const id = await h.launch();
    const result = await h.call('click', { session_id: id, selector: '#go' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      '[TEMPLATE_BUSY] Actions on site-a.test are being paced. Retry in 5 s.',
    );
    const page = h.fakeDriver?.handles[0]?.firstPage;
    expect(page?.methods()).not.toContain('click');
  });

  it('navigate asks for the warm-up and shrinks its timeout by the time used', async () => {
    const { recorded, actions } = recordingActions({ warmupMs: 4_000 });
    h = await createToolHarness({ siteActions: () => actions });
    const id = await h.launch();
    await executeTool(h, 'navigate', { session_id: id, url: 'https://site-a.test/deep' });
    expect(recorded.gotos).toEqual([
      { tool: 'navigate', url: 'https://site-a.test/deep', timeoutMs: 30_000 },
    ]);
    const page = h.fakeDriver?.handles[0]?.firstPage;
    const gotoCall = page?.calls.filter((c) => c.method === 'goto').at(-1);
    expect(gotoCall?.args[1]).toMatchObject({ timeout: 26_000 });
  });

  it('a site forcing humanized input takes the humanized path without session humanize', async () => {
    const spy = spyPageActions();
    const { actions } = recordingActions({ forced: true });
    h = await createToolHarness({ pageActions: spy.actions, siteActions: () => actions });
    const id = await h.launch({ stealth: true, humanize: false });
    await executeTool(h, 'click', { session_id: id, selector: '#go' });
    await executeTool(h, 'hover', { session_id: id, selector: '#go' });
    await executeTool(h, 'fill', { session_id: id, selector: '#name', value: 'x' });
    expect(spy.calls).toEqual(['humanClick', 'humanHover']);
  });

  it('hands the site gate over as the re-check; each run gets the earlier decisions', async () => {
    const runs: string[] = [];
    const rechecks: ((() => Promise<void>) | null | undefined)[] = [];
    const guards = {
      async beforeTool(call: { tool: string }, settled?: ReadonlySet<string>) {
        runs.push(`${call.tool}:${[...(settled ?? [])].join(',')}`);
        return new Set([...(settled ?? []), `d${runs.length}`]);
      },
    };
    const actions: SiteActionsLike = {
      async around(_call, run, recheck) {
        await recheck?.();
        return await run();
      },
      async beforeGoto(call) {
        rechecks.push(call.recheck);
        await call.recheck?.();
        return 0;
      },
      forcesHumanize: () => false,
    };
    h = await createToolHarness({ siteActions: () => actions, siteGuards: () => guards });
    const id = await h.launch();
    await executeTool(h, 'click', { session_id: id, selector: '#go' });
    await executeTool(h, 'navigate', { session_id: id, url: 'https://site-a.test/deep' });
    expect(runs).toEqual(['click:', 'click:d1', 'navigate:', 'navigate:d3', 'navigate:d3,d4']);
    expect(rechecks).toHaveLength(1);
  });
});
