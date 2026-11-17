/** @module interface/mcp/template-pause.test — a template session's tool calls wait while the operator signs in (D-60): held tools wait on the pause and answer its `TEMPLATE_UNAVAILABLE` `paused`; tools that end or inspect a session do not wait; exclusive sessions never do. */

import { afterEach, describe, expect, it } from 'bun:test';
import { FakeSessionView } from '../../../test/helpers/fake-session-view.ts';
import {
  createToolHarness,
  type ToolHarness,
  textOf,
} from '../../../test/helpers/fake-transport.ts';
import { templateUnavailable } from '../../app/templates/template-admission.ts';
import { PAUSE_WAIT_MS } from '../../app/templates/template-pause.ts';
import { PAUSE_EXEMPT_TOOLS } from './dispatcher.ts';

let h: ToolHarness;
afterEach(async () => h.close());

/** A pause that records its waits and refuses while `paused` is set. */
function pauseStub() {
  const waits: string[] = [];
  const state = { paused: true };
  return {
    waits,
    state,
    pause: {
      async wait(templateId: string, name: string): Promise<void> {
        waits.push(templateId);
        if (state.paused) throw templateUnavailable(name, 'paused', 15_000);
      },
    },
  };
}

async function templateSession(): Promise<string> {
  const view = new FakeSessionView('jobs-00000001');
  const session = await h.services.sessions.createVirtual(
    { slug: 'jobs', headless: true },
    { subject: 'local' },
    {
      template: {
        templateId: 'tp-fixture001',
        name: 'job-hunt',
        version: null,
        mode: 'live',
        sealed: true,
        sealing: {
          hideCookieValues: true,
          forceDisableEvaluate: true,
          refuseCookieWrites: true,
          refuseStateExport: true,
        },
        sites: [],
      },
      proxyLabel: null,
      reserve: () => () => undefined,
      acquire: async () => undefined,
      open: async () => view,
    },
  );
  return session.id;
}

describe('tool calls while agents are paused (D-60)', () => {
  it('holds a page tool and answers TEMPLATE_UNAVAILABLE paused when the wait runs out', async () => {
    const stub = pauseStub();
    h = await createToolHarness({ templatePause: stub.pause });
    const id = await templateSession();
    const result = await h.call('snapshot', { session_id: id });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toStartWith('[TEMPLATE_UNAVAILABLE]');
    expect(stub.waits).toEqual(['tp-fixture001']);
    expect(h.observations().at(-1)?.errorCode).toBe('TEMPLATE_UNAVAILABLE');
  });

  it('lets the call through once the operator lets agents continue', async () => {
    const stub = pauseStub();
    h = await createToolHarness({ templatePause: stub.pause });
    const id = await templateSession();
    stub.state.paused = false;
    const result = await h.call('snapshot', { session_id: id });
    expect(textOf(result)).not.toContain('TEMPLATE_UNAVAILABLE');
    expect(stub.waits).toEqual(['tp-fixture001']);
  });

  it('never holds the tools that end or inspect a session, nor exclusive sessions', async () => {
    const stub = pauseStub();
    h = await createToolHarness({ templatePause: stub.pause });
    const id = await templateSession();
    for (const tool of ['list_tabs', 'session_info']) {
      expect((await h.call(tool, { session_id: id })).isError).not.toBe(true);
    }
    const exclusive = await h.launch();
    expect((await h.call('snapshot', { session_id: exclusive })).isError).not.toBe(true);
    expect((await h.call('close_session', { session_id: id })).isError).not.toBe(true);
    expect(stub.waits).toEqual([]);
  });
});

describe('the pause bounds (review #81 M-3, M-4)', () => {
  it('holds every tool but these ten, which end or only inspect a session', () => {
    expect([...PAUSE_EXEMPT_TOOLS].sort()).toEqual([
      'close_session',
      'get_attention_result',
      'list_saved_auths',
      'list_sessions',
      'list_tabs',
      'list_templates',
      'request_attention',
      'server_status',
      'session_info',
      'vault_list_available',
    ]);
  });

  it("a held call plus a tool's default 30 s timeout stays below 55 s", () => {
    expect(PAUSE_WAIT_MS + 30_000).toBeLessThan(55_000);
  });
});
