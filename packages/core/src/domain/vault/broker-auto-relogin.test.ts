/** @module domain/vault/broker-auto-relogin.test — a template's auto-relogin through the broker with a linked binding (spec 13 §8.4): every gate as for an agent, the template named explicitly, one audit row with `trigger: 'auto_relogin'`. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createVaultHarness, FakePage, type VaultHarness } from './test-support.ts';

const TEMPLATE = 'tp-0000000001';
const PRINCIPAL = `template:${TEMPLATE}`;
const FILL = { entryName: 'linkedin', usernameSelector: '#u', passwordSelector: '#p' };

let h: VaultHarness;
beforeEach(() => {
  h = createVaultHarness();
});

async function bind(extra: Record<string, unknown> = {}): Promise<void> {
  await h.bind('linkedin', {
    itemName: 'linkedin',
    itemId: 'i1',
    allowedOrigins: ['linkedin.com'],
    authorizedSessionSlugs: ['relogin'],
    authorizedPrincipals: [PRINCIPAL],
    ...extra,
  });
}

function fill(
  page = new FakePage('https://linkedin.com/login'),
  maintenanceOf: string | null = TEMPLATE,
) {
  const ctx = h.ctx(page, { principal: PRINCIPAL, slug: 'relogin', sessionId: 'relogin-a1b2c3d4' });
  return h.broker().fill(FILL, {
    ...ctx,
    session: { ...ctx.session, maintenanceOf },
    autoRelogin: { templateId: TEMPLATE, linkedBy: 'admin' },
  });
}

describe('VaultBroker.fill — template auto-relogin (spec 13 §8.4)', () => {
  it('fills once through every gate and writes one audit row with trigger auto_relogin', async () => {
    await bind();
    const result = await fill();
    expect(result.status).toBe('success');
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'success',
      sessionId: 'relogin-a1b2c3d4',
      principalId: PRINCIPAL,
      details: { trigger: 'auto_relogin', template_id: TEMPLATE, linked_by: 'admin' },
    });
  });

  it('is refused for a binding that does not list template:<id>', async () => {
    await bind({ authorizedPrincipals: ['agent-a'] });
    const result = await fill();
    expect(result).toEqual({ status: 'blocked', redacted: true, reason: 'not_authorized' });
    expect(h.repos.audit.rows).toHaveLength(1);
    expect(h.repos.audit.rows[0]).toMatchObject({
      result: 'blocked',
      details: { trigger: 'auto_relogin', reason: 'not_authorized' },
    });
    expect(h.backend.calls).toEqual([]);
  });

  it('is refused for a binding open to every principal: the template must be named', async () => {
    await bind({ authorizedPrincipals: [] });
    expect((await fill()).reason).toBe('not_authorized');
    // An agent of any principal could still use that binding: only the template is strict.
    const agent = await h
      .broker()
      .fill(FILL, h.ctx(new FakePage('https://linkedin.com/login'), { slug: 'relogin' }));
    expect(agent.status).toBe('success');
  });

  it("satisfies the binding's slug rule only in the template's own maintenance session (review #81 M-1)", async () => {
    await bind({ authorizedSessionSlugs: ['agent-*'] });
    expect((await fill()).status).toBe('success');
    // Not a maintenance session of this template: the slug rule applies and refuses `relogin`.
    expect((await fill(new FakePage('https://linkedin.com/login'), null)).reason).toBe(
      'not_authorized',
    );
    expect((await fill(new FakePage('https://linkedin.com/login'), 'tp-other00001')).reason).toBe(
      'not_authorized',
    );
  });

  it('is refused by a harness list (a template fill has no harness)', async () => {
    await bind({ harnesses: ['claude-code'] });
    const result = await fill();
    expect(result.reason).toBe('not_authorized');
    expect(h.repos.audit.rows[0]?.details).toMatchObject({ reason: 'harness_not_allowed' });
  });

  it('keeps the origin gate', async () => {
    await bind();
    expect((await fill(new FakePage('https://evil.example/login'))).status).toBe('origin_mismatch');
  });
});
