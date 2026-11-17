/** @module app/site-packs/tool-gate.test — the tool path of site packs (spec 13 §9.3, §9.5) over a scripted page: a stopped site refuses navigations to it and tools on its pages; `GET` document guards act as block / warn / confirm (pass, pending, blocked) / allow with the right hit rows (none for confirmations); element guards query the target, a descendant inside the guard, a newline's submit controls, the focused element and both drag ends; the write policy comes from the template's override; queries fail open; the agent's own navigation is recorded. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { SitePackV1 } from '@browserhive/contracts/site-packs';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakePackPage } from '../../../test/helpers/fake-pack-page.ts';
import { createCollectingLogger } from '../../../test/helpers/test-logger.ts';
import { templateSiteRecord } from '../../../test/persistence/helpers.ts';
import type { Session } from '../../domain/session/session.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import type { TemplateSiteRecord } from '../../ports/persistence/index.ts';
import type {
  SecurityIntercepts,
  WriteApprovalInput,
  WriteApprovalResult,
} from '../../ports/security-intercepts.ts';
import type { SiteGuardHitInput } from '../../ports/site-guards.ts';
import type { EffectivePack, SitePackLookup } from '../../ports/site-packs.ts';
import type { DocumentGuardHit } from '../../ports/site-tool-guards.ts';
import { AgentNavigations } from './agent-navigations.ts';
import { SiteToolGate } from './tool-gate.ts';
import { ToolGuardHits } from './tool-guard-hits.ts';

const SITE = 'site-a.test';
const pack = SitePackV1.parse({
  schema: 1,
  id: SITE,
  version: 1,
  min_client: '0.3.0',
  title: 'Site A',
  domains: [SITE],
  sign_in: { url: { host: SITE, path: '/login' }, human_only: false },
  signed_in: { probe: { host: SITE, path: '/feed' }, kind: 'landmark', landmark: '#feed' },
  element_guards: [
    {
      id: 'signout',
      kind: 'logout',
      page: `${SITE}/*`,
      target: { selector: '#signout' },
      action: 'block',
    },
    {
      id: 'delete',
      kind: 'destructive',
      page: `${SITE}/*`,
      target: { role: 'button', name: 'Delete' },
      action: 'block',
    },
    {
      id: 'post',
      kind: 'write',
      page: `${SITE}/compose*`,
      target: { selector: '#post' },
      action: 'write_policy',
    },
    { id: 'like', kind: 'write', page: `${SITE}/*`, target: { selector: '#like' }, action: 'warn' },
  ],
  write_policy: { default: 'confirm', stance: 'prohibited' },
});
const effective: EffectivePack = {
  packId: SITE,
  pack,
  version: 1,
  sha256: 'b'.repeat(64),
  source: 'local',
  localOverride: false,
};
const lookup: SitePackLookup = {
  effectiveFor: (host) => (host.endsWith(SITE) ? effective : null),
  effectiveById: (id) => (id === SITE ? effective : null),
  generation: 1,
};

interface World {
  readonly gate: SiteToolGate;
  readonly page: FakePackPage;
  readonly hits: SiteGuardHitInput[];
  readonly approvals: WriteApprovalInput[];
  readonly navigations: AgentNavigations;
  sites: TemplateSiteRecord[];
  approval: WriteApprovalResult;
  docGuard: DocumentGuardHit | null;
  override: 'allow' | 'warn' | 'confirm' | null;
  withIntercepts: boolean;
}

let w: World;
const session = (mode: 'live' | 'maintenance' = 'live') =>
  ({ id: 's-1', template: { templateId: 'tp-1', mode } }) as unknown as Session;

beforeEach(() => {
  const clock = new FakeClock();
  const page = new FakePackPage();
  page.currentUrl = `https://${SITE}/feed`;
  const hits: SiteGuardHitInput[] = [];
  const approvals: WriteApprovalInput[] = [];
  const navigations = new AgentNavigations(clock);
  const state = {
    sites: [templateSiteRecord({ templateId: 'tp-1', siteId: SITE, packId: SITE })],
    approval: { kind: 'pending', requestId: 'a-req1' } as WriteApprovalResult,
    docGuard: null as DocumentGuardHit | null,
    override: null as World['override'],
    withIntercepts: true,
  };
  const intercepts: SecurityIntercepts = {
    confirmer: null,
    holdOf: () => null,
    requestWriteApproval: async (input) => {
      approvals.push(input);
      return state.approval;
    },
    raiseChallenge: async () => null,
  };
  const gate = new SiteToolGate({
    sites: async () => state.sites,
    lookup: () => lookup,
    intercepts: () => (state.withIntercepts ? intercepts : null),
    documentGuard: () => () => state.docGuard,
    overrides: () => ({ overrideFor: () => state.override }),
    hits: new ToolGuardHits({ sink: () => ({ write: (h) => hits.push(h) }), clock }),
    navigations,
    pageOf: () => page.asPage(),
    clock,
    logger: createCollectingLogger(),
  });
  w = Object.assign(state, { gate, page, hits, approvals, navigations });
});

async function refusal(work: Promise<void>): Promise<{ code: string; details: unknown }> {
  try {
    await work;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, details: err.details };
    throw err;
  }
  throw new Error('not refused');
}

const call = (
  tool: string,
  args: Record<string, unknown> = {},
  mode: 'live' | 'maintenance' = 'live',
) => w.gate.beforeTool({ tool, args, session: session(mode) });

/** `count()` answers 1 when every fragment is in the expression. */
const when =
  (...fragments: string[]) =>
  (expr: string) =>
    fragments.every((f) => expr.includes(f)) ? 1 : 0;

describe('scope', () => {
  it('maintenance sessions and exempt tools are never checked', async () => {
    w.sites = [{ ...w.sites[0], stoppedAt: 1 } as TemplateSiteRecord];
    await call('click', { selector: '#signout' }, 'maintenance');
    await call('screenshot');
    await call('session_info');
    expect(w.page.queries).toEqual([]);
  });
});

describe('stop', () => {
  beforeEach(() => {
    w.sites = [{ ...(w.sites[0] as TemplateSiteRecord), stoppedAt: 1_000 }];
  });

  it('refuses navigations to the site and tools on its pages; other sites stay open', async () => {
    expect(await refusal(call('get_content'))).toEqual({
      code: 'SITE_OPERATOR_PENDING',
      details: {
        session_id: 's-1',
        site: SITE,
        request_id: null,
        reason: 'stopped',
        wait_text: 'Do not retry until the operator clears the site.',
      },
    });
    expect((await refusal(call('new_tab', { url: `https://www.${SITE}/x` }))).code).toBe(
      'SITE_OPERATOR_PENDING',
    );
    await call('new_tab', { url: 'https://site-b.test/' });
    expect(
      w.hits.map((h) => [h.guardKind, h.guardId, h.action, h.source, h.method, h.tool]),
    ).toEqual([
      ['stop', 'stop', 'block', 'tool', null, 'get_content'],
      ['stop', 'stop', 'block', 'tool', 'GET', 'new_tab'],
    ]);
  });
});

describe('GET document guards', () => {
  const url = `https://${SITE}/logout?next=/`;
  const guard = (action: DocumentGuardHit['action']): DocumentGuardHit => ({
    ruleId: `${SITE}#logout`,
    packId: SITE,
    guardId: 'logout',
    kind: 'logout',
    action,
  });

  it('block answers URL_BLOCKED with the pack#guard pattern and one hit', async () => {
    w.docGuard = guard('block');
    expect(await refusal(call('navigate', { url }))).toEqual({
      code: 'URL_BLOCKED',
      details: { url, pattern: `${SITE}#logout` },
    });
    expect(w.hits).toMatchObject([
      {
        action: 'block',
        source: 'tool',
        method: 'GET',
        url: `https://${SITE}/logout`,
        tool: 'navigate',
      },
    ]);
  });

  it('warn and allow proceed (warn writes its hit) and the agent URL is recorded', async () => {
    w.docGuard = guard('warn');
    await call('navigate', { url });
    w.docGuard = guard('allow');
    await call('navigate', { url });
    expect(w.hits.map((h) => h.action)).toEqual(['warn']);
    expect(w.navigations.consume(w.page, 's-1', url)).toBe(true);
  });

  it('confirm: pending → SITE_OPERATOR_PENDING write_confirm, pass → proceed, blocked → URL_BLOCKED; rows only for the block', async () => {
    w.docGuard = guard('confirm');
    expect(await refusal(call('navigate', { url }))).toMatchObject({
      code: 'SITE_OPERATOR_PENDING',
      details: { request_id: 'a-req1', reason: 'write_confirm' },
    });
    w.approval = { kind: 'pass' };
    await call('navigate', { url });
    w.approval = { kind: 'blocked', reason: 'bounds' };
    expect((await refusal(call('navigate', { url }))).code).toBe('URL_BLOCKED');
    w.withIntercepts = false;
    expect((await refusal(call('navigate', { url }))).code).toBe('URL_BLOCKED');
    expect(w.approvals[0]).toMatchObject({
      sessionId: 's-1',
      templateId: 'tp-1',
      site: SITE,
      packId: SITE,
      guardId: 'logout',
      method: 'GET',
      url: `https://${SITE}/logout`,
      tool: 'navigate',
      source: 'request',
    });
    expect(w.hits.map((h) => h.action)).toEqual(['block', 'block']);
  });
});

describe('element guards', () => {
  it('a descendant of a guarded control is refused (target ∩ (guard ∪ guard >> *))', async () => {
    w.page.count = when('#signout-label', 'css=#signout >> css=*');
    expect(await refusal(call('click', { selector: '#signout-label' }))).toEqual({
      code: 'SITE_ACTION_BLOCKED',
      details: { session_id: 's-1', site: SITE, guard: `${SITE}#signout` },
    });
    expect(w.page.queries[0]).toBe('(#signout-label & (css=#signout | css=#signout >> css=*))');
    expect(w.hits).toMatchObject([
      { action: 'block', source: 'element', method: null, guardId: 'signout', tool: 'click' },
    ]);
  });

  it('role guards, both drag ends, a newline into a form and the focused element', async () => {
    w.page.count = when('#b', 'role=button[Delete]');
    expect(
      (await refusal(call('drag_and_drop', { source_selector: '#a', target_selector: '#b' }))).code,
    ).toBe('SITE_ACTION_BLOCKED');
    w.page.count = when(
      '#field >> xpath=ancestor::form[1] >> css=button:not([type])',
      'role=button[Delete]',
    );
    await call('type_text', { selector: '#field', text: 'abc' });
    // Review #83 C-L2: a newline anywhere submits the form.
    expect((await refusal(call('type_text', { selector: '#field', text: 'a\nb' }))).code).toBe(
      'SITE_ACTION_BLOCKED',
    );
    expect((await refusal(call('type_text', { selector: '#field', text: 'abc\n' }))).code).toBe(
      'SITE_ACTION_BLOCKED',
    );
    w.page.count = when('css=*:focus >> xpath=ancestor::form[1]', 'role=button[Delete]');
    await call('press_key', { key: 'a' });
    expect((await refusal(call('press_key', { key: 'Enter' }))).code).toBe('SITE_ACTION_BLOCKED');
    // Interaction tools without a target and non-interaction tools query nothing.
    w.page.queries.length = 0;
    await call('scroll', { mode: 'by', dy: 10 });
    await call('get_content');
    expect(w.page.queries).toEqual([]);
  });

  it('warn proceeds with a hit; write_policy follows the template override; other pages are unguarded', async () => {
    w.page.count = when('#like', 'css=#like');
    await call('click', { selector: '#like' });
    expect(w.hits.map((h) => [h.guardId, h.action])).toEqual([['like', 'warn']]);
    w.page.currentUrl = `https://${SITE}/compose/new`;
    w.page.count = when('#post', 'css=#post');
    expect((await refusal(call('click', { selector: '#post' }))).code).toBe(
      'SITE_OPERATOR_PENDING',
    );
    expect(w.approvals.at(-1)).toMatchObject({ guardId: 'post', source: 'element', method: null });
    w.override = 'allow';
    await call('click', { selector: '#post' });
    w.page.currentUrl = 'https://site-b.test/compose';
    w.page.queries.length = 0;
    await call('click', { selector: '#post' });
    expect(w.page.queries).toEqual([]);
  });

  it('fails open when a query throws', async () => {
    w.page.count = () => {
      throw new Error('execution context destroyed');
    };
    await call('click', { selector: '#signout' });
    expect(w.hits).toEqual([]);
  });
});
