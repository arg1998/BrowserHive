/** @module app/templates/template-edit.test — operator edits reaching live sessions (spec 13 §3.2, D16): re-sealing pushed at once, revoked access and disabling closing sessions, frozen identity, confirmations, If-Match, sites and the access tester. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { FakeTemplateHostOps } from '../../../test/helpers/fake-host-ops.ts';
import { InMemoryRepositories, InMemoryUnitOfWork } from '../../../test/helpers/in-memory-repos.ts';
import { InMemoryOperatorActionRepository } from '../../../test/helpers/in-memory-vault-repos.ts';
import { FakeTemplateRuntime } from '../../../test/helpers/template-kit.ts';
import {
  TEMPLATE_ID,
  templateRecord,
  templateSiteRecord,
} from '../../../test/persistence/helpers.ts';
import type { Session } from '../../domain/session/session.ts';
import type { SessionTemplate } from '../../domain/session/session-template.ts';
import { sealingFor } from '../../domain/templates/model.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import { TemplateEditService } from './template-edit.ts';

/** A live session as the edit service sees it. */
function liveSession(id: string, owner: string): Session & { current: SessionTemplate } {
  const sealing = sealingFor(templateRecord().unseal, owner);
  const fake = {
    id,
    owner,
    request: { client: null },
    current: {
      templateId: TEMPLATE_ID,
      name: 'job-hunt',
      version: null,
      mode: 'live',
      sealed: true,
      sealing,
      sites: [{ site: 'site-a.test', status: 'unknown' }],
    } as SessionTemplate,
    get template() {
      return this.current;
    },
    retemplate(next: Partial<SessionTemplate>) {
      this.current = { ...this.current, ...next };
    },
  };
  return fake as unknown as Session & { current: SessionTemplate };
}

let repos: InMemoryRepositories & { operatorActions: InMemoryOperatorActionRepository };
let runtime: FakeTemplateRuntime;
let ops: FakeTemplateHostOps;
let sessions: Map<string, ReturnType<typeof liveSession>>;
let closed: string[];
let changed: string[];
let edit: TemplateEditService;

beforeEach(async () => {
  repos = Object.assign(new InMemoryRepositories(), {
    operatorActions: new InMemoryOperatorActionRepository(),
  });
  await repos.templates.insert(templateRecord({ authorizedPrincipals: ['alice', 'bob'] }));
  await repos.templateSites.upsert(templateSiteRecord());
  runtime = new FakeTemplateRuntime();
  ops = new FakeTemplateHostOps();
  sessions = new Map([
    ['alice-aaaaaaaa', liveSession('alice-aaaaaaaa', 'alice')],
    ['bob-bbbbbbbb', liveSession('bob-bbbbbbbb', 'bob')],
  ]);
  runtime.sessions.set(TEMPLATE_ID, [...sessions.keys()]);
  closed = [];
  changed = [];
  let n = 0;
  edit = new TemplateEditService({
    repos,
    uow: new InMemoryUnitOfWork(repos),
    runtime,
    ops,
    sessions: {
      peek: (id) => sessions.get(id),
      close: async (id) => {
        closed.push(id);
        return true as never;
      },
    },
    ids: { eventId: () => `e-${++n}` },
    clock: new FakeClock(),
    logger: new CollectingLogger(),
    changed: (id) => void changed.push(id),
  });
});

async function code(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return isAppError(err) ? err.code : String(err);
}

describe('PATCH (spec 13 §3.2, D16)', () => {
  it('pushes new unseal flags to live sessions at once, for the listed principals only', async () => {
    const out = await edit.update(
      TEMPLATE_ID,
      {
        policy: {
          unseal: {
            cookie_values: true,
            evaluate: true,
            cookie_writes: false,
            state_export: false,
            principals: ['alice'],
          },
        },
      },
      { by: 'admin' },
    );
    expect(out.closed_sessions).toEqual([]);
    expect(sessions.get('alice-aaaaaaaa')?.current.sealing.hideCookieValues).toBe(false);
    expect(sessions.get('alice-aaaaaaaa')?.current.sealing.forceDisableEvaluate).toBe(false);
    expect(sessions.get('bob-bbbbbbbb')?.current.sealing.hideCookieValues).toBe(true);
    // Re-sealing reaches the session too.
    await edit.update(
      TEMPLATE_ID,
      {
        policy: {
          unseal: {
            cookie_values: false,
            evaluate: false,
            cookie_writes: false,
            state_export: false,
          },
        },
      },
      { by: 'admin' },
    );
    expect(sessions.get('alice-aaaaaaaa')?.current.sealing.hideCookieValues).toBe(true);
    expect(sessions.get('alice-aaaaaaaa')?.current.sealed).toBe(true);
    expect(repos.operatorActions.rows.map((r) => r.details)).toEqual([
      { changed: ['unseal'] },
      { changed: ['unseal'] },
    ]);
    expect(changed).toEqual([TEMPLATE_ID, TEMPLATE_ID]);
  });

  it('closes the sessions whose principal lost access', async () => {
    const out = await edit.update(
      TEMPLATE_ID,
      { policy: { authorized_principals: ['alice'] } },
      { by: 'admin' },
    );
    expect(out.closed_sessions).toEqual(['bob-bbbbbbbb']);
    expect(closed).toEqual(['bob-bbbbbbbb']);
  });

  it('needs confirm_identity_change for proxy and channel; a stale If-Match is a CONFLICT', async () => {
    expect(await code(edit.update(TEMPLATE_ID, { channel: 'chrome' }, { by: 'a' }))).toBe(
      'VALIDATION_FAILED',
    );
    const ok = await edit.update(
      TEMPLATE_ID,
      { channel: 'chrome', confirm_identity_change: true },
      { by: 'a', ifMatch: 1 },
    );
    expect(ok.template.channel).toBe('chrome');
    expect(
      await code(edit.update(TEMPLATE_ID, { description: 'x' }, { by: 'a', ifMatch: 1 })),
    ).toBe('CONFLICT');
    expect(
      await code(
        edit.update(
          TEMPLATE_ID,
          { proxy: { server: 'http://u:p@proxy.test:8080' }, confirm_identity_change: true },
          { by: 'a' },
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('restarts a running browser after a channel change', async () => {
    runtime.hosts.set(TEMPLATE_ID, { state: 'running' });
    await edit.update(TEMPLATE_ID, { headless: true }, { by: 'a' });
    expect(ops.calls).toEqual([`restart:${TEMPLATE_ID}`]);
  });

  it('writes nothing for an unchanged value', async () => {
    const out = await edit.update(TEMPLATE_ID, { name: 'job-hunt' }, { by: 'a' });
    expect(out.template.version).toBe(1);
    expect(repos.operatorActions.rows).toEqual([]);
  });
});

describe('disable and enable', () => {
  it('disabling closes every live session; enabling returns to ready', async () => {
    const off = await edit.setEnabled(TEMPLATE_ID, false, 'admin');
    expect(off.template.status).toBe('disabled');
    expect(off.closed_sessions.sort()).toEqual(['alice-aaaaaaaa', 'bob-bbbbbbbb']);
    // No version and no site ever checked: back to setting up.
    expect((await edit.setEnabled(TEMPLATE_ID, true, 'admin')).template.status).toBe('recording');
    await edit.setEnabled(TEMPLATE_ID, false, 'admin');
    await repos.templates.setStateFacts(TEMPLATE_ID, { currentVersion: 1 });
    const on = await edit.setEnabled(TEMPLATE_ID, true, 'admin');
    expect(on.template.status).toBe('ready');
    expect(repos.operatorActions.rows.map((r) => r.action)).toEqual([
      'template.disable',
      'template.enable',
      'template.disable',
      'template.enable',
    ]);
  });
});

describe('sites', () => {
  it('adds a site, disables it (sessions see it gone) and refuses to remove the last one', async () => {
    const site = await edit.putSite(
      TEMPLATE_ID,
      'www.site-b.test',
      { write_policy: 'confirm' },
      'a',
    );
    expect(site).toMatchObject({ site_id: 'site-b.test', write_policy: 'confirm', enabled: true });
    expect(sessions.get('bob-bbbbbbbb')?.current.sites.map((s) => s.site)).toEqual([
      'site-a.test',
      'site-b.test',
    ]);
    await edit.putSite(TEMPLATE_ID, 'site-a.test', { enabled: false }, 'a');
    expect(sessions.get('bob-bbbbbbbb')?.current.sites.map((s) => s.site)).toEqual(['site-b.test']);
    await edit.removeSite(TEMPLATE_ID, 'site-b.test', 'a');
    expect(await code(edit.removeSite(TEMPLATE_ID, 'site-a.test', 'a'))).toBe('CONFLICT');
    expect(await code(edit.removeSite(TEMPLATE_ID, 'nope.test', 'a'))).toBe('TEMPLATE_NOT_FOUND');
  });
});

describe('access tester (D-48)', () => {
  it('answers with the reason and the rule; operators only', async () => {
    expect(await edit.resolveAccess(TEMPLATE_ID, { principal: 'alice' })).toMatchObject({
      allowed: true,
      harness_list_unchecked: true,
    });
    expect(await edit.resolveAccess(TEMPLATE_ID, { principal: 'mallory' })).toMatchObject({
      allowed: false,
      reason: 'principal_not_allowed',
      rule: { authorized_principals: ['alice', 'bob'] },
    });
    await edit.update(TEMPLATE_ID, { policy: { harnesses: ['claude-code'] } }, { by: 'a' });
    expect(
      await edit.resolveAccess(TEMPLATE_ID, { principal: 'alice', harness: 'codex' }),
    ).toMatchObject({
      allowed: false,
      reason: 'harness_not_allowed',
      harness_list_unchecked: false,
    });
  });
});
