/** @module app/templates/template-relogin.test — re-login (spec 13 §8.4; review #81 H-1, M-2, M-4, M-5): one window per template whoever presses, windows always closed, the pause owned by its windows, auto-finish only on an observed sign-in, the live-view sign-in, the auto-relogin switch. */

import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { deferred, until } from '../../../test/helpers/fake-probe-hosts.ts';
import { InMemoryRepositories } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { templateRecord, templateSiteRecord } from '../../../test/persistence/helpers.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { Cookie } from '../../ports/browser-driver.ts';
import type { TemplateRecord } from '../../ports/persistence/index.ts';
import { LIVE_SIGN_IN_IDLE_MS, RELOGIN_POLL_MS } from './relogin-window.ts';
import { TemplatePause } from './template-pause.ts';
import { TemplateReloginService } from './template-relogin.ts';

const SITE = 'site-a.test';

function cookie(name: string, expires = 2_000_000_000): Cookie {
  return {
    name,
    value: 'v',
    domain: `.${SITE}`,
    path: '/',
    expires,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  };
}

interface Options {
  readonly display?: boolean;
  readonly headless?: boolean;
  readonly hostState?: 'stopped' | 'running';
  readonly vault?: boolean;
  readonly status?: TemplateRecord['status'];
}

async function harness(options: Options = {}) {
  const clock = new FakeClock();
  const alive = new Set<string>();
  const pause = new TemplatePause({ clock, alive: (id) => alive.has(id) });
  const repos = new InMemoryRepositories();
  const actions = new InMemoryOperatorActionRepository();
  const template = templateRecord({
    status: options.status ?? 'ready',
    headless: options.headless ?? false,
  });
  await repos.templates.insert(template);
  await repos.templateSites.upsert(
    templateSiteRecord({
      siteId: SITE,
      learnedCookieNames: ['sid'],
      vaultHandle: 'site-a',
      autoRelogin: false,
      form: { username: '#u', password: '#p' },
    }),
  );
  const jar: { cookies: Cookie[] } = { cookies: [] };
  const opened: { id: string; headless: boolean; pauseAgents: boolean }[] = [];
  const gate: { wait: Promise<void> | null; entered: number } = { wait: null, entered: 0 };
  const recorded: string[] = [];
  const fills: string[] = [];
  let n = 0;
  const svc = new TemplateReloginService({
    repos: { ...repos, operatorActions: actions },
    supervisor: {
      pause,
      launchMaintenance: async () => {
        fills.push('launch');
        throw new Error('no browser in this test');
      },
      host: () => ({ state: options.hostState ?? 'running' }) as never,
    },
    ops: {
      openSignInWindow: async (request) => {
        gate.entered += 1;
        await gate.wait;
        const id = `relogin-${String(++n).padStart(8, '0')}`;
        alive.add(id);
        opened.push({
          id,
          headless: request.template.headless,
          pauseAgents: request.pauseAgents !== false,
        });
        if (request.pauseAgents !== false) {
          pause.open(request.template.templateId, id, request.letAgentsContinue);
        }
        return { id, view: null, state: { kind: 'live' } } as never;
      },
      raiseWindow: async () => undefined,
      recordingOf: () => null,
      jar: async () => jar.cookies,
      held: () => false,
    },
    sessions: {
      close: async (id: string) => {
        alive.delete(id);
        return true as never;
      },
      peek: (id: string) =>
        alive.has(id) ? ({ id, state: { kind: 'live' } } as never) : undefined,
    },
    health: {
      record: async (_t, siteId) => {
        recorded.push(siteId);
      },
      probe: async () => [],
    },
    ...(options.vault === true && {
      vault: {
        configured: true,
        fill: async () => ({ status: 'success' as const, redacted: true as const }),
      },
    }),
    ids: { eventId: () => `e-${++n}` },
    clock,
    logger: new CollectingLogger(),
    machine: 'hive-box',
    displayAvailable: () => options.display ?? true,
  });
  const id = template.templateId;
  const open = () => [...alive];
  return {
    svc,
    pause,
    clock,
    jar,
    opened,
    gate,
    recorded,
    fills,
    actions,
    id,
    open,
    template,
    repos,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return isAppError(err) ? err.code : 'thrown';
  }
}

describe('one sign-in window per template (review #81 H-1)', () => {
  it('two Show window presses on a queued re-login open one window; cancel closes it and agents resume', async () => {
    const h = await harness();
    await h.svc.queue(h.id, SITE, 'telegram:42');
    const a = h.svc.show(h.id, { subject: 'op1' });
    const b = h.svc.show(h.id, { subject: 'op2' });
    const [first, second] = await Promise.all([a, b]);
    expect(h.opened).toHaveLength(1);
    expect(first.sessionId).toBe(second.sessionId);
    expect(h.pause.paused(h.id)).toBe(true);
    await h.svc.cancel(h.id, 'op1');
    expect(h.open()).toEqual([]);
    expect(h.pause.paused(h.id)).toBe(false);
  });

  it('a Re-login of the queued site while Show window opens it gets a typed CONFLICT, one window', async () => {
    const h = await harness();
    const gate = deferred();
    h.gate.wait = gate.promise;
    await h.svc.queue(h.id, SITE, 'telegram:42');
    const shown = h.svc.show(h.id, { subject: 'op1' });
    await until(() => h.svc.view(h.id) !== null);
    const second = h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op2' });
    expect(await codeOf(second)).toBe('CONFLICT');
    gate.resolve();
    await shown;
    expect(h.opened).toHaveLength(1);
    await h.svc.cancel(h.id, 'op1');
    expect(h.pause.paused(h.id)).toBe(false);
  });

  it('a Re-login while a window is open is CONFLICT; the queued one of the same site is opened', async () => {
    const h = await harness();
    await h.svc.queue(h.id, SITE, 'telegram:42');
    const res = await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op1' });
    expect(res.relogin.state).toBe('open');
    expect(res.relogin.requested_by).toBe('telegram:42');
    expect(
      await codeOf(h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op2' })),
    ).toBe('CONFLICT');
    expect(h.opened).toHaveLength(1);
  });

  it('a window opened for a run that ended meanwhile is closed at once', async () => {
    const h = await harness();
    const gate = deferred();
    h.gate.wait = gate.promise;
    await h.svc.queue(h.id, SITE, 'telegram:42');
    const shown = h.svc.show(h.id, { subject: 'op1' });
    await until(() => h.svc.view(h.id) !== null);
    await until(() => h.gate.entered === 1);
    await h.svc.cancel(h.id, 'op2');
    gate.resolve();
    await shown.catch(() => undefined);
    expect(h.opened).toHaveLength(1);
    expect(h.open()).toEqual([]);
    expect(h.pause.paused(h.id)).toBe(false);
  });

  it('Let agents continue lasts for that window only; the next window pauses agents again', async () => {
    const h = await harness();
    await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(h.pause.paused(h.id)).toBe(true);
    h.svc.continueAgents(h.id);
    h.svc.continueAgents(h.id); // twice is harmless
    expect(h.pause.paused(h.id)).toBe(false);
    await h.svc.cancel(h.id, 'op');
    await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(h.pause.paused(h.id)).toBe(true);
  });
});

describe('auto-finish only on an observed sign-in (review #81 M-5)', () => {
  it('a site whose cookies were already there waits for Done', async () => {
    const h = await harness();
    h.jar.cookies = [cookie('sid')];
    const res = await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(res.relogin.confirm_required).toBe(true);
    for (let i = 0; i < 5; i++) await h.clock.advance(RELOGIN_POLL_MS);
    expect(h.svc.view(h.id)?.state).toBe('open');
    const done = await h.svc.confirm(h.id, SITE, 'op');
    expect(done.relogin.state).toBe('signed_in');
    expect(h.recorded).toEqual([SITE]);
  });

  it('a sign-in cookie that appears in the window finishes it', async () => {
    const h = await harness();
    const res = await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(res.relogin.confirm_required).toBe(false);
    h.jar.cookies = [cookie('sid')];
    await h.clock.advance(RELOGIN_POLL_MS);
    await until(() => h.svc.view(h.id)?.state === 'signed_in');
    expect(h.open()).toEqual([]);
  });
});

describe('headless templates (review #81 M-2)', () => {
  it('a stopped headless template starts headed for its re-login when a display is there', async () => {
    const h = await harness({ headless: true, hostState: 'stopped' });
    const res = await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(res.relogin.sign_in_via).toBe('window');
    expect(h.opened[0]).toMatchObject({ headless: false, pauseAgents: true });
  });

  it('a running headless template (or no display) signs in through the live view; agents wait only while the operator types', async () => {
    const h = await harness({ headless: true, hostState: 'running' });
    const res = await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(res.relogin.sign_in_via).toBe('live_view');
    expect(h.opened[0]).toMatchObject({ headless: true, pauseAgents: false });
    expect(h.pause.paused(h.id)).toBe(false);
    const session = res.relogin.session_id ?? '';
    expect(h.svc.liveInput('not-this-one')).toBe(false);
    expect(h.svc.liveInput(session)).toBe(true);
    expect(h.pause.paused(h.id)).toBe(true);
    // No input for a while: agents continue until the next input.
    for (let t = 0; t <= LIVE_SIGN_IN_IDLE_MS + RELOGIN_POLL_MS; t += RELOGIN_POLL_MS) {
      await h.clock.advance(RELOGIN_POLL_MS);
    }
    await until(() => !h.pause.paused(h.id));
    expect(h.svc.liveInput(session)).toBe(true);
    expect(h.pause.paused(h.id)).toBe(true);
    await h.svc.cancel(h.id, 'op');
    expect(h.pause.paused(h.id)).toBe(false);
    expect(h.svc.liveInput(session)).toBe(false);
  });

  it('without a display even a headed template uses the live view', async () => {
    const h = await harness({ display: false });
    const res = await h.svc.start(h.id, { siteId: SITE, method: 'window' }, { subject: 'op' });
    expect(res.relogin.sign_in_via).toBe('live_view');
  });
});

describe('automatic re-login (review #81 M-4, L-3)', () => {
  it('never runs with the switch off, nor on a disabled template', async () => {
    const h = await harness({ vault: true });
    const site = (await h.repos.templateSites.list(h.id))[0];
    if (site === undefined) throw new Error('no site');
    h.svc.signedOut(h.template, site);
    expect(h.svc.view(h.id)).toBeNull();
    h.svc.signedOut({ ...h.template, status: 'disabled' }, { ...site, autoRelogin: true });
    expect(h.svc.view(h.id)).toBeNull();
    expect(h.fills).toEqual([]);
  });

  it('a try that could not start a browser does not spend the 24 h rule', async () => {
    const h = await harness({ vault: true });
    const site = (await h.repos.templateSites.list(h.id))[0];
    if (site === undefined) throw new Error('no site');
    h.svc.signedOut(h.template, { ...site, autoRelogin: true });
    await until(() => h.svc.view(h.id)?.state === 'failed');
    expect(h.svc.view(h.id)?.error).toBe('browser_unavailable');
    expect((await h.repos.templateSites.list(h.id))[0]?.autoReloginAt).toBeNull();
  });
});
