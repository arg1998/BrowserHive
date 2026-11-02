/** @module app/vault/vault-admin.test — the dashboard tester agrees with the broker (D-48): the shared harness gate cases give the same verdict, reason and rule; without a harness, bindings whose lists would apply are named as unchecked */

import { describe, expect, it } from 'bun:test';
import {
  createVaultHarness,
  HARNESS_GATE_CASES,
  HARNESS_GATE_FIXTURE,
  type HarnessGateExpectation,
  seedHarnessCase,
} from '../../domain/vault/test-support.ts';
import { testerHarness, VaultAdmin } from './vault-admin.ts';

function adminOf(h: ReturnType<typeof createVaultHarness>): VaultAdmin {
  return new VaultAdmin({ bindings: h.repos.bindings, policies: h.repos.policies, clock: h.clock });
}

describe('tester: the shared harness gate cases (broker.test.ts runs the same table)', () => {
  for (const c of HARNESS_GATE_CASES) {
    it(c.name, async () => {
      const h = createVaultHarness();
      await seedHarnessCase(h, c);
      const result = await adminOf(h).tester({
        url: HARNESS_GATE_FIXTURE.pageUrl,
        principal: c.principal,
        sessionSlug: c.slug,
        // The broker reads a missing launch harness as `unknown`; the tester is told so explicitly.
        harness: c.harness ?? 'unknown',
        ...(c.declared !== null && { harnessDeclared: c.declared }),
      });
      const refused = result.blocked.find((b) => b.handle === HARNESS_GATE_FIXTURE.handle);
      const actual: HarnessGateExpectation = result.wouldFill.includes(HARNESS_GATE_FIXTURE.handle)
        ? { verdict: 'fill', reason: null }
        : {
            verdict: 'refused',
            reason: refused?.reason as HarnessGateExpectation['reason'],
            ...(refused?.rule !== undefined && { rule: refused.rule }),
          };
      expect(actual).toEqual(c.expected);
      expect(result.harnessListsUnchecked).toEqual([]);
    });
  }
});

describe('tester without a harness', () => {
  it('checks no list and names the bindings whose lists would have applied', async () => {
    const h = createVaultHarness();
    const admin = adminOf(h);
    await admin.putBinding('deploy.aws', {
      itemName: 'AWS',
      groupId: 'f-deploy',
      allowedOrigins: ['console.aws.example'],
      allowAllSessions: true,
    });
    await admin.putBinding('work.gh', {
      itemName: 'GitHub',
      allowedOrigins: ['github.com'],
      allowAllSessions: true,
      harnesses: ['opencode'],
    });
    await admin.putBinding('plain', {
      itemName: 'Plain',
      allowedOrigins: ['console.aws.example'],
      allowAllSessions: true,
    });
    await admin.putPolicy('f-deploy', { accessMode: 'manual', harnesses: [] });
    const result = await admin.tester({ url: 'https://console.aws.example/login' });
    expect(result.wouldFill).toEqual(['deploy.aws', 'plain']);
    expect(result.harnessListsUnchecked).toEqual(['deploy.aws', 'work.gh']);
    // Given a harness, the same lists are checked and nothing is unchecked.
    const asCodex = await admin.tester({
      url: 'https://console.aws.example/login',
      harness: 'codex',
    });
    expect(asCodex.blocked).toContainEqual({
      handle: 'deploy.aws',
      reason: 'harness_not_allowed',
      rule: 'group',
    });
    expect(asCodex.harnessListsUnchecked).toEqual([]);
  });

  it('normalises a declared name alone into its slug, as a launch would', () => {
    expect(testerHarness({ url: 'x' })).toBeNull();
    expect(testerHarness({ url: 'x', harnessDeclared: 'Claude Code' })).toEqual({
      harness: 'claude-code',
      declared: 'Claude Code',
    });
    expect(testerHarness({ url: 'x', harnessDeclared: 'Nightly Scraper' })).toEqual({
      harness: 'nightly-scraper',
      declared: 'Nightly Scraper',
    });
    expect(testerHarness({ url: 'x', harness: 'unknown' })).toEqual({
      harness: 'unknown',
      declared: null,
    });
  });
});
