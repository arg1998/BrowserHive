/** @module domain/vault/broker.test — the gate suite: every gate and reason, one audit row per fill, containment, confirm, tracing, allow-all, listing */

import { beforeEach, describe, expect, it } from 'bun:test';
import { FakeVaultBackend } from '../../../test/helpers/fake-vault-backend.ts';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';
import { REDACTED } from '../../kernel/redact.ts';
import {
  createVaultHarness,
  FakePage,
  FakeTracing,
  SECRET,
  USER,
  type VaultHarness,
} from './test-support.ts';

/** Asserts that `promise` rejects with an `AppError` of `code`. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(isAppError(caught, code as never)).toBe(true);
}

/** Yields macrotasks until one vault-confirm request is open (the fill has reached step 5). */
async function waitForOpenConfirm(h: VaultHarness): Promise<void> {
  for (let i = 0; i < 100 && h.confirm.listOpen('vault_confirm').length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const FILL = { entryName: 'linkedin', usernameSelector: '#u', passwordSelector: '#p' };

let h: VaultHarness;
beforeEach(() => {
  h = createVaultHarness();
});

async function bindLinkedin(extra: Record<string, unknown> = {}): Promise<void> {
  await h.bind('linkedin', {
    itemName: 'linkedin',
    itemId: 'i1',
    allowedOrigins: ['linkedin.com'],
    authorizedSessionSlugs: ['linkedin-agent'],
    ...extra,
  });
}

/** Every string that could carry a secret: results, audit rows, events, log records. */
function everything(extra: unknown[] = []): string {
  return JSON.stringify([h.repos.audit.rows, h.events.published, h.logger.records, ...extra]);
}

describe('VaultBroker.fill — gating outcomes (gate order and reason strings)', () => {
  it('blocks when the session has vault disabled', async () => {
    await bindLinkedin();
    const r = await h
      .broker()
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/login'), { vaultEnabled: false }));
    expect(r).toEqual({ status: 'blocked', redacted: true, reason: 'vault_disabled' });
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'blocked',
      reason: 'vault_disabled',
      originCheck: 'skipped',
    });
    expect(h.backend.calls).toEqual([]);
  });

  it('blocks an unauthorized slug identically to a missing binding', async () => {
    await bindLinkedin();
    const other = await h
      .broker()
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/'), { slug: 'other-agent' }));
    const missing = await h
      .broker()
      .fill({ ...FILL, entryName: 'nope' }, h.ctx(new FakePage('https://linkedin.com/')));
    expect(other).toEqual({ status: 'blocked', redacted: true, reason: 'not_authorized' });
    expect(missing).toEqual(other);
    // The audit rows do not reveal whether the handle existed either.
    expect(h.repos.audit.rows.map((r) => [r.result, r.reason, r.handle])).toEqual([
      ['blocked', 'not_authorized', null],
      ['blocked', 'not_authorized', null],
    ]);
  });

  it('D-14: the caller principal AND the slug must both be authorized', async () => {
    await bindLinkedin({ authorizedPrincipals: ['p-agent'] });
    const page = () => new FakePage('https://linkedin.com/');
    expect((await h.broker().fill(FILL, h.ctx(page(), { principal: 'p-other' }))).reason).toBe(
      'not_authorized',
    );
    expect(
      (await h.broker().fill(FILL, h.ctx(page(), { principal: 'p-agent', slug: 'zzz' }))).reason,
    ).toBe('not_authorized');
    expect((await h.broker().fill(FILL, h.ctx(page(), { principal: 'p-agent' }))).status).toBe(
      'success',
    );
    expect(h.repos.audit.rows.at(-1)?.principalId).toBe('p-agent');
  });

  it('blocks require_no_evaluate when evaluate is permitted, allows it when disabled', async () => {
    await bindLinkedin({ requireNoEvaluate: true });
    const blocked = await h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    expect(blocked.reason).toBe('evaluate_required_off');
    expect(h.repos.audit.rows[0]?.evaluateEnabled).toBe(true);
    const viaSession = await h
      .broker()
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/'), { disableEvaluate: true }));
    expect(viaSession.status).toBe('success');
    const viaServer = await h
      .broker({ allowEvaluate: false })
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    expect(viaServer.status).toBe('success');
    expect(h.repos.audit.rows.at(-1)?.evaluateEnabled).toBe(false);
  });

  it('returns origin_mismatch off the allow-list with the registrable domain in the audit', async () => {
    await bindLinkedin();
    const r = await h.broker().fill(FILL, h.ctx(new FakePage('https://evil.com/login')));
    expect(r).toEqual({ status: 'origin_mismatch', redacted: true, reason: 'origin_mismatch' });
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'origin_mismatch',
      originCheck: 'fail',
      details: { reason: 'origin_mismatch', registrable_domain: 'evil.com', detail: 'not_allowed' },
    });
    expect(h.backend.calls).toEqual([]);
  });

  it('auth_failed / entry_not_found when the backend has no such entry', async () => {
    await bindLinkedin();
    h.backend.throwOnGet = new AppError('VAULT_ENTRY_NOT_FOUND', { entry_name: 'linkedin' });
    const r = await h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    expect(r).toEqual({ status: 'auth_failed', redacted: true, reason: 'entry_not_found' });
  });

  it('auth_failed / backend_error never echoes the backend error text', async () => {
    await bindLinkedin();
    h.backend.throwOnGet = new Error('bw exploded with token abc');
    const r = await h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    expect(r).toEqual({ status: 'auth_failed', redacted: true, reason: 'backend_error' });
    expect(everything([r])).not.toContain('exploded');
  });

  it('a locked backend at fetch time audits and rethrows VAULT_LOCKED', async () => {
    await bindLinkedin();
    h.backend.unlocked = false;
    await expectCode(
      h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/'))),
      'VAULT_LOCKED',
    );
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]).toMatchObject({ result: 'blocked', reason: 'vault_locked' });
  });

  it('throws VAULT_NOT_CONFIGURED for the off backend', async () => {
    const off = h.broker({ backend: new FakeVaultBackend({ kind: 'off' }) });
    await expectCode(
      off.fill(FILL, h.ctx(new FakePage('https://linkedin.com/'))),
      'VAULT_NOT_CONFIGURED',
    );
  });
});

describe('VaultBroker.fill — dashboard confirm (D-15)', () => {
  it('blocks with dashboard_denied when the operator denies; the deny reason stays in the audit', async () => {
    await bindLinkedin({ dashboardConfirm: true });
    const p = h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    await waitForOpenConfirm(h);
    const open = h.confirm.listOpen('vault_confirm');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      entryName: 'linkedin',
      tool: 'vault_fill',
      toolEventId: 'e-00000000000000000000000001',
      pageUrl: 'https://linkedin.com/',
      owner: 'local',
    });
    await h.confirm.resolve(
      open[0]?.requestId ?? '',
      { status: 'rejected', reason: 'looks phishy' },
      'admin',
    );
    const r = await p;
    expect(r).toEqual({ status: 'blocked', redacted: true, reason: 'dashboard_denied' });
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'denied',
      details: { confirm: 'denied: looks phishy' },
    });
    expect(JSON.stringify(r)).not.toContain('phishy');
    expect(h.backend.calls).toEqual([]);
  });

  it('proceeds when the operator approves', async () => {
    await bindLinkedin({ dashboardConfirm: true });
    const p = h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    await waitForOpenConfirm(h);
    const [open] = h.confirm.listOpen('vault_confirm');
    await h.confirm.resolve(open?.requestId ?? '', { status: 'resolved' }, 'admin');
    expect(await p).toEqual({ status: 'success', redacted: true });
    expect(h.repos.audit.rows[0]?.result).toBe('success');
  });

  it('blocks with confirm_timeout when nobody answers before the deadline', async () => {
    await bindLinkedin({ dashboardConfirm: true });
    const p = h
      .broker({ confirmTimeoutMs: 30_000 })
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    await waitForOpenConfirm(h);
    await h.clock.advance(30_000);
    const r = await p;
    expect(r).toEqual({ status: 'blocked', redacted: true, reason: 'confirm_timeout' });
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'denied',
      reason: 'confirm_timeout',
      details: { confirm: 'timeout' },
    });
  });

  it('auto-denies when there is no confirm gate (stdio)', async () => {
    await bindLinkedin({ dashboardConfirm: true });
    const r = await h
      .broker({ withConfirm: false })
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/')));
    expect(r.reason).toBe('dashboard_denied');
    expect(h.repos.audit.rows[0]?.details).toMatchObject({ confirm: 'no_dashboard' });
  });
});

describe('VaultBroker.fill — form-action mutation defence', () => {
  it('blocks a cross-origin form action before typing', async () => {
    await bindLinkedin();
    const page = new FakePage('https://linkedin.com/login');
    page.formAction = 'https://attacker.com/steal';
    const r = await h.broker().fill(FILL, h.ctx(page));
    expect(r.reason).toBe('form_action_mismatch');
    expect(page.fills.some(([, v]) => v === SECRET)).toBe(false);
    expect(h.repos.audit.rows[0]?.details).toMatchObject({ phase: 'pre_fill' });
  });

  it('re-checks the action before submit', async () => {
    await bindLinkedin();
    const page = new FakePage('https://linkedin.com/login');
    const original = page.fill.bind(page);
    page.fill = async (selector: string, value: string): Promise<void> => {
      await original(selector, value);
      if (selector === '#p') page.formAction = 'https://attacker.com/steal';
    };
    const r = await h.broker().fill({ ...FILL, submitSelector: '#go' }, h.ctx(page));
    expect(r.reason).toBe('form_action_mismatch');
    expect(page.clicks).toEqual([]);
    expect(h.repos.audit.rows[0]?.details).toMatchObject({ phase: 'pre_submit' });
  });

  it('allows relative / javascript: / same-domain actions', async () => {
    await bindLinkedin({ allowedOrigins: ['*.linkedin.com'] });
    for (const action of [
      '/login',
      'javascript:void(0)',
      'https://www.linkedin.com/checkpoint',
      '',
    ]) {
      const page = new FakePage('https://www.linkedin.com/login');
      page.formAction = action;
      expect((await h.broker().fill(FILL, h.ctx(page))).status).toBe('success');
    }
  });
});

describe('VaultBroker.fill — success + credential containment', () => {
  it('fills, submits, LEAVES inputs filled by default, arms redaction, never leaks the secret', async () => {
    await bindLinkedin({ allowedOrigins: ['*.linkedin.com'], redactUsername: true });
    const page = new FakePage('https://www.linkedin.com/login');
    page.formAction = 'https://www.linkedin.com/login-submit';
    const result = await h.broker().fill(
      {
        entryName: 'linkedin',
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '#go',
      },
      h.ctx(page),
    );
    expect(result).toEqual({ status: 'success', redacted: true });
    expect(page.fills).toContainEqual(['#user', USER]);
    expect(page.fills).toContainEqual(['#pass', SECRET]);
    expect(page.clicks).toEqual(['#go']);
    expect(page.fills.some(([, v]) => v === '')).toBe(false);

    const rows = h.repos.audit.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: 'success',
      originCheck: 'pass',
      entryName: 'linkedin',
      handle: 'linkedin',
      toolEventId: 'e-00000000000000000000000001',
      principalId: 'local',
      details: { submitted: true, username_selector: '#user' },
    });
    const all = everything([result]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(USER);
    expect(h.events.names()).toEqual(['vault.access']);
    expect(h.redaction.scrub('demo-00000001', `you typed ${SECRET} as ${USER}`)).toBe(
      `you typed ${REDACTED} as ${REDACTED}`,
    );
  });

  it('wipes the inputs only when clearAfterFill is set', async () => {
    await bindLinkedin({ allowedOrigins: ['*.linkedin.com'] });
    const page = new FakePage('https://www.linkedin.com/login');
    const result = await h.broker().fill(
      {
        entryName: 'linkedin',
        usernameSelector: '#user',
        passwordSelector: '#pass',
        clearAfterFill: true,
        afterSubmitWaitMs: 10,
      },
      h.ctx(page),
    );
    expect(result).toEqual({ status: 'success', redacted: true });
    expect(page.fills).toContainEqual(['#pass', SECRET]);
    expect([...page.fills].reverse().find(([s]) => s === '#pass')?.[1]).toBe('');
    expect([...page.fills].reverse().find(([s]) => s === '#user')?.[1]).toBe('');
  });

  it('writes exactly one audit row per fill for every branch', async () => {
    await bindLinkedin({ dashboardConfirm: false });
    const b = h.broker();
    const cases: (() => Promise<unknown>)[] = [
      () => b.fill(FILL, h.ctx(new FakePage('https://linkedin.com/'), { vaultEnabled: false })),
      () => b.fill({ ...FILL, entryName: 'nope' }, h.ctx(new FakePage('https://linkedin.com/'))),
      () => b.fill(FILL, h.ctx(new FakePage('https://evil.com/'))),
      () => b.fill(FILL, h.ctx(new FakePage('https://linkedin.com/'))),
      () => {
        const page = new FakePage('https://linkedin.com/');
        page.failFill = { selector: '#p', error: new Error('detached') };
        return b.fill(FILL, h.ctx(page));
      },
      () => {
        const page = new FakePage('https://linkedin.com/');
        page.failClick = new Error('no button');
        return b.fill({ ...FILL, submitSelector: '#go' }, h.ctx(page));
      },
    ];
    for (const [i, run] of cases.entries()) {
      await run();
      expect(h.repos.audit.rows).toHaveLength(i + 1);
    }
    expect(h.repos.audit.rows.map((r) => r.reason)).toEqual([
      'vault_disabled',
      'not_authorized',
      'origin_mismatch',
      'success',
      'fill_failed',
      'submit_failed',
    ]);
  });

  it('fill_failed / submit_failed carry a scrubbed detail and keep the window armed', async () => {
    await bindLinkedin();
    const page = new FakePage('https://linkedin.com/');
    page.failFill = { selector: '#p', error: new Error(`element gone while typing ${SECRET}`) };
    const r = await h.broker().fill(FILL, h.ctx(page));
    expect(r).toEqual({ status: 'auth_failed', redacted: true, reason: 'fill_failed' });
    expect(h.repos.audit.rows[0]?.details).toMatchObject({
      detail: `Error: element gone while typing ${REDACTED}`,
    });
    expect(everything([r])).not.toContain(SECRET);
    expect(h.redaction.isActive('demo-00000001')).toBe(true);
  });

  it('humanize sessions clear then type through the injected typer; others fill directly', async () => {
    await bindLinkedin();
    const typed: [string, string][] = [];
    const typer = async (_page: unknown, selector: string, value: string): Promise<void> => {
      typed.push([selector, value]);
    };
    const page = new FakePage('https://linkedin.com/');
    expect((await h.broker({ typer }).fill(FILL, h.ctx(page, { humanize: true }))).status).toBe(
      'success',
    );
    expect(typed).toEqual([
      ['#u', USER],
      ['#p', SECRET],
    ]);
    expect(page.fills).toEqual([
      ['#u', ''],
      ['#p', ''],
    ]);
    const plain = new FakePage('https://linkedin.com/');
    await h.broker({ typer }).fill(FILL, h.ctx(plain));
    expect(plain.fills).toEqual([
      ['#u', USER],
      ['#p', SECRET],
    ]);
  });

  it('skips the username field when the item has no username', async () => {
    await bindLinkedin();
    h.backend.setCredential('i1', { username: '', password: SECRET });
    const page = new FakePage('https://linkedin.com/');
    expect((await h.broker().fill(FILL, h.ctx(page))).status).toBe('success');
    expect(page.fills).toEqual([['#p', SECRET]]);
  });
});

describe('VaultBroker.fill — trace chunk exclusion (D-13)', () => {
  it('pauses the chunk before the first keystroke and resumes after submit', async () => {
    await bindLinkedin();
    const tracing = new FakeTracing();
    const page = new FakePage('https://linkedin.com/');
    const original = page.fill.bind(page);
    page.fill = async (s: string, v: string): Promise<void> => {
      expect(tracing.calls).toEqual(['pause']);
      await original(s, v);
    };
    await h.broker().fill({ ...FILL, submitSelector: '#go' }, h.ctx(page, { tracing }));
    expect(tracing.calls).toEqual(['pause', 'resume']);
    expect(page.clicks).toEqual(['#go']);
  });

  it('resumes the chunk on a typing failure and on a submit failure', async () => {
    await bindLinkedin();
    const failing = new FakePage('https://linkedin.com/');
    failing.failFill = { selector: '#p', error: new Error('gone') };
    const t1 = new FakeTracing();
    expect((await h.broker().fill(FILL, h.ctx(failing, { tracing: t1 }))).reason).toBe(
      'fill_failed',
    );
    expect(t1.calls).toEqual(['pause', 'resume']);

    const noButton = new FakePage('https://linkedin.com/');
    noButton.failClick = new Error('no button');
    const t2 = new FakeTracing();
    expect(
      (await h.broker().fill({ ...FILL, submitSelector: '#go' }, h.ctx(noButton, { tracing: t2 })))
        .reason,
    ).toBe('submit_failed');
    expect(t2.calls).toEqual(['pause', 'resume']);
  });

  it('never pauses when the fill is refused before typing; a pause failure is logged, not fatal', async () => {
    await bindLinkedin();
    const t = new FakeTracing();
    await h.broker().fill(FILL, h.ctx(new FakePage('https://evil.com/'), { tracing: t }));
    expect(t.calls).toEqual([]);
    const t2 = new FakeTracing();
    t2.failPause = true;
    expect(
      (await h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/'), { tracing: t2 })))
        .status,
    ).toBe('success');
    expect(t2.calls).toEqual(['pause', 'resume']);
    expect(h.logger.find('trace pause failed')).toHaveLength(1);
  });
});

describe('VaultBroker.fill — group policies + allow-all resolution', () => {
  it('reject_all group blocks even a matching binding', async () => {
    await bindLinkedin();
    await h.policy(null, { accessMode: 'reject_all' });
    expect((await h.broker().fill(FILL, h.ctx(new FakePage('https://linkedin.com/')))).reason).toBe(
      'not_authorized',
    );
  });

  function workGithub(): void {
    h.backend.groups = [
      { id: 'f1', name: 'Work' },
      { id: null, name: 'No Folder' },
    ];
    h.backend.entries = [
      { id: 'i9', name: 'GitHub', groupId: 'f1', uris: ['https://github.com/login'] },
    ];
    h.backend.setCredential('i9', { username: USER, password: SECRET });
  }
  const GH = { ...FILL, entryName: 'work.github' };

  it('allow_all group authorizes a glob-matched slug and derives origins from item uris', async () => {
    workGithub();
    await h.policy('f1', { accessMode: 'allow_all', sessionSlugGlobs: ['agent-*'] });
    const page = new FakePage('https://github.com/login');
    expect(await h.broker().fill(GH, h.ctx(page, { slug: 'agent-7' }))).toEqual({
      status: 'success',
      redacted: true,
    });
    expect(page.fills).toContainEqual(['#p', SECRET]);
    expect(h.repos.audit.rows[0]).toMatchObject({ entryName: 'GitHub', handle: 'work.github' });
    const off = await h
      .broker()
      .fill(GH, h.ctx(new FakePage('https://evil.com/'), { slug: 'agent-7' }));
    expect(off.status).toBe('origin_mismatch');
  });

  it('allow_all group with dashboard_confirm holds every fill for the operator', async () => {
    workGithub();
    await h.policy('f1', {
      accessMode: 'allow_all',
      allowAllSessions: true,
      dashboardConfirm: true,
    });
    const p = h
      .broker()
      .fill(GH, h.ctx(new FakePage('https://github.com/login'), { slug: 'agent-7' }));
    await waitForOpenConfirm(h);
    const [open] = h.confirm.listOpen('vault_confirm');
    expect(open?.entryName).toBe('work.github');
    await h.confirm.resolve(open?.requestId ?? '', { status: 'rejected' }, 'admin');
    expect((await p).reason).toBe('dashboard_denied');
  });

  it('allow_all group-wide require_no_evaluate / redact_username / principals apply', async () => {
    workGithub();
    await h.policy('f1', {
      accessMode: 'allow_all',
      allowAllSessions: true,
      requireNoEvaluate: true,
      redactUsername: true,
      authorizedPrincipals: ['p-1'],
    });
    expect(
      (
        await h
          .broker()
          .fill(GH, h.ctx(new FakePage('https://github.com/login'), { principal: 'p-1' }))
      ).reason,
    ).toBe('evaluate_required_off');
    expect(
      (
        await h.broker().fill(
          GH,
          h.ctx(new FakePage('https://github.com/login'), {
            principal: 'p-2',
            disableEvaluate: true,
          }),
        )
      ).reason,
    ).toBe('not_authorized');
    const ok = await h.broker().fill(
      GH,
      h.ctx(new FakePage('https://github.com/login'), {
        principal: 'p-1',
        disableEvaluate: true,
      }),
    );
    expect(ok.status).toBe('success');
    expect(h.redaction.scrub('demo-00000001', `typed ${SECRET} as ${USER}`)).toBe(
      `typed ${REDACTED} as ${REDACTED}`,
    );
  });

  it('allow_all item with no uri is not fillable; ambiguous duplicate handles are not targetable', async () => {
    h.backend.groups = [{ id: 'f1', name: 'Work' }];
    h.backend.entries = [{ id: 'i9', name: 'NoUrl', groupId: 'f1', uris: [] }];
    await h.policy('f1', { accessMode: 'allow_all', allowAllSessions: true });
    expect(
      (
        await h
          .broker()
          .fill({ ...FILL, entryName: 'work.nourl' }, h.ctx(new FakePage('https://anything.com/')))
      ).reason,
    ).toBe('not_authorized');
    h.backend.entries = [
      { id: 'i1', name: 'Dup', groupId: 'f1', uris: ['https://a.example'] },
      { id: 'i2', name: 'Dup', groupId: 'f1', uris: ['https://b.example'] },
    ];
    expect(
      (
        await h
          .broker()
          .fill({ ...FILL, entryName: 'work.dup' }, h.ctx(new FakePage('https://a.example/')))
      ).reason,
    ).toBe('not_authorized');
  });

  it('a locked backend on the allow-all path audits and rethrows VAULT_LOCKED', async () => {
    workGithub();
    await h.policy('f1', { accessMode: 'allow_all', allowAllSessions: true });
    h.backend.unlocked = false;
    await expectCode(
      h.broker().fill(GH, h.ctx(new FakePage('https://github.com/login'))),
      'VAULT_LOCKED',
    );
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]?.reason).toBe('vault_locked');
  });
});

describe('VaultBroker.listAvailable — composition + dedupe', () => {
  it('composes manual + allow-all group items and dedupes with manual winning', async () => {
    h.backend.groups = [{ id: 'f1', name: 'Work' }];
    h.backend.entries = [
      { id: 'i9', name: 'GitHub', groupId: 'f1', uris: ['https://github.com'] },
      { id: 'i10', name: 'Extra', groupId: 'f1', uris: ['https://extra.example'] },
    ];
    await h.bind('work.github', {
      itemName: 'GitHub',
      groupId: 'f1',
      itemId: 'i9',
      allowedOrigins: ['manual.example'],
      authorizedSessionSlugs: ['agent-7'],
    });
    await h.policy('f1', { accessMode: 'allow_all', sessionSlugGlobs: ['agent-*'] });
    const result = await h.broker().listAvailable({ principal: 'local', slug: 'agent-7' });
    expect(result.scope).toBe('unscoped');
    expect(result.entries.map((e) => [e.entryName, e.allowedOrigins])).toEqual([
      ['work.extra', ['extra.example']],
      ['work.github', ['manual.example']],
    ]);
    // Public view only: no dashboard_confirm, no authorized subjects.
    expect(Object.keys(result.entries[0] ?? {}).sort()).toEqual([
      'allowedOrigins',
      'entryName',
      'redactUsername',
      'requireNoEvaluate',
    ]);
  });

  it('excludes reject_all groups and callers the policy does not authorize; degrades when locked', async () => {
    h.backend.groups = [{ id: 'f1', name: 'Work' }];
    h.backend.entries = [{ id: 'i9', name: 'GitHub', groupId: 'f1', uris: ['https://github.com'] }];
    await h.policy('f1', { accessMode: 'allow_all', sessionSlugGlobs: ['agent-*'] });
    expect(
      (await h.broker().listAvailable({ principal: 'local', slug: 'other-1' })).entries,
    ).toEqual([]);
    await bindLinkedin();
    h.backend.unlocked = false;
    const degraded = await h.broker().listAvailable({ principal: 'local', slug: 'linkedin-agent' });
    expect(degraded.entries.map((e) => e.entryName)).toEqual(['linkedin']);
    await h.policy(null, { accessMode: 'reject_all' });
    expect(
      (await h.broker().listAvailable({ principal: 'local', slug: 'linkedin-agent' })).entries,
    ).toEqual([]);
  });
});

describe('VaultBroker.listAvailable — page scoping + honesty probe', () => {
  beforeEach(async () => {
    await h.bind('gh', {
      itemName: 'GitHub',
      itemId: 'i1',
      allowedOrigins: ['*.github.com'],
      authorizedSessionSlugs: ['agent-7'],
    });
    await h.bind('li', {
      itemName: 'LinkedIn',
      itemId: 'i2',
      allowedOrigins: ['linkedin.com'],
      authorizedSessionSlugs: ['agent-7'],
    });
  });
  const caller = { principal: 'local', slug: 'agent-7' };

  it('scopes the list to the current page origin', async () => {
    const r = await h.broker().listAvailable(caller, {
      currentUrl: 'https://www.github.com/login',
      sessionId: 'demo-00000001',
    });
    expect(r).toEqual({
      entries: [
        {
          entryName: 'gh',
          allowedOrigins: ['*.github.com'],
          redactUsername: false,
          requireNoEvaluate: false,
        },
      ],
      scope: 'page',
      scopedTo: 'github.com',
    });
  });

  it('returns no entries with a note when no http(s) page is loaded', async () => {
    const r = await h
      .broker()
      .listAvailable(caller, { currentUrl: 'about:blank', sessionId: 'demo-00000001' });
    expect(r.scope).toBe('no_page');
    expect(r.entries).toEqual([]);
    expect(r.note).toBe(
      'No http(s) login page is loaded — navigate to the login page first. Listings are scoped to the site the session is currently on.',
    );
  });

  it('accepts a declared domain that matches the page by registrable domain', async () => {
    const r = await h.broker().listAvailable(caller, {
      currentUrl: 'https://www.github.com/login?token=abc',
      declaredUrl: 'github.com',
      sessionId: 'demo-00000001',
    });
    expect(r.scope).toBe('page');
    expect(r.entries.map((e) => e.entryName)).toEqual(['gh']);
    expect(h.repos.audit.rows).toHaveLength(0);
  });

  it('rejects + audits (VAULT_LIST_DENIED) a declared domain that does not match the page', async () => {
    const r = await h.broker().listAvailable(caller, {
      currentUrl: 'https://www.github.com/login',
      declaredUrl: 'linkedin.com',
      sessionId: 'demo-00000001',
      toolEventId: 'e-00000000000000000000000002',
    });
    expect(r.scope).toBe('rejected');
    expect(r.entries).toEqual([]);
    expect(r.mismatch).toEqual({ declared: 'linkedin.com', actual: 'github.com' });
    expect(r.note).toBe(
      "Declared login domain linkedin.com does not match the session's current page (github.com). Listing denied and reported — pass the domain of the page the session has actually navigated to.",
    );
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]).toMatchObject({
      entryName: '(vault_list_available)',
      result: 'blocked',
      originCheck: 'fail',
      reason: 'list_url_mismatch',
      toolEventId: 'e-00000000000000000000000002',
      details: {
        code: 'VAULT_LIST_DENIED',
        declared_domain: 'linkedin.com',
        actual_domain: 'github.com',
      },
    });
    expect(h.logger.find('vault domain mismatch')[0]?.fields).toMatchObject({
      code: 'VAULT_LIST_DENIED',
    });
    expect(h.events.names()).toEqual(['vault.access']);
  });

  it('a declared domain with no page loaded is rejected with the no-page note', async () => {
    const r = await h
      .broker()
      .listAvailable(caller, { currentUrl: 'about:blank', declaredUrl: 'github.com' });
    expect(r.scope).toBe('rejected');
    expect(r.note).toContain('(no page loaded)');
    expect(h.repos.audit.rows).toHaveLength(0);
  });
});
