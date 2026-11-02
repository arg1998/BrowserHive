/** @module features/vault/tester/decide.test — URL normalisation and the per-binding decision + reason chain */
import { describe, expect, it } from 'bun:test';
import type { VaultBinding, VaultGroup } from '@browserhive/contracts/http';
import { bindingRow, groupRow } from '../fixtures.ts';
import { normalizeTesterUrl, testerDecisions } from './decide.ts';

const bindings = [
  bindingRow(),
  bindingRow({ handle: 'blocked.one', group_id: 'g-block', item_name: 'Bank' }),
  bindingRow({ handle: 'slug.one', item_name: 'Mail' }),
  bindingRow({ handle: 'eval.one', item_name: 'Ops' }),
] as unknown as VaultBinding[];
const groups = [
  groupRow(),
  groupRow({
    group_id: 'g-block',
    name: 'Block',
    policy: { ...(groupRow()['policy'] as object), group_id: 'g-block', access_mode: 'reject_all' },
  }),
] as unknown as VaultGroup[];
const result = {
  would_fill: ['work.github'],
  blocked: [
    { handle: 'blocked.one', reason: 'not_authorized' },
    { handle: 'slug.one', reason: 'not_authorized' },
    { handle: 'eval.one', reason: 'evaluate_required_off' },
  ],
  harness_lists_unchecked: [],
};

describe('tester decisions', () => {
  it('normalises hosts and rejects garbage', () => {
    expect(normalizeTesterUrl('github.com/login')).toBe('https://github.com/login');
    expect(normalizeTesterUrl('http://x.test:8080')).toBe('http://x.test:8080/');
    expect(normalizeTesterUrl('  ')).toBeNull();
    expect(normalizeTesterUrl('http://')).toBeNull();
  });

  it('builds a gate-by-gate chain per binding, fills first', () => {
    const decisions = testerDecisions(result, { bindings, groups, slug: 'agent-1' });
    expect(decisions.map((d) => [d.handle, d.decision])).toEqual([
      ['work.github', 'fill'],
      ['blocked.one', 'blocked'],
      ['eval.one', 'blocked'],
      ['slug.one', 'blocked'],
    ]);
    const outcomes = (handle: string) =>
      decisions.find((d) => d.handle === handle)?.chain.map((g) => g.outcome);
    expect(outcomes('work.github')).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(outcomes('blocked.one')).toEqual(['fail', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(outcomes('slug.one')).toEqual(['pass', 'fail', 'skipped', 'skipped', 'skipped']);
    expect(outcomes('eval.one')).toEqual(['pass', 'pass', 'pass', 'pass', 'fail']);
  });

  it('adds a harness gate (D-48): a refusal names its list; unchecked lists read "not checked"', () => {
    const withHarness = testerDecisions(
      {
        would_fill: ['work.github'],
        blocked: [
          { handle: 'slug.one', reason: 'harness_not_allowed', rule: 'group' },
          { handle: 'eval.one', reason: 'harness_not_allowed', rule: 'binding' },
        ],
        harness_lists_unchecked: [],
      },
      { bindings, groups, slug: 'agent-1', harness: 'Codex' },
    );
    const gate = (handle: string) =>
      withHarness.find((d) => d.handle === handle)?.chain.find((g) => g.gate === 'harness');
    expect(gate('work.github')).toEqual({
      gate: 'harness',
      outcome: 'pass',
      detail: 'Codex allowed',
    });
    expect(gate('slug.one')).toMatchObject({
      outcome: 'fail',
      detail: "refused by the folder's harness list",
    });
    expect(gate('eval.one')?.detail).toBe("refused by the binding's harness list");
    expect(withHarness.find((d) => d.handle === 'slug.one')?.chain.map((g) => g.outcome)).toEqual([
      'pass',
      'pass',
      'fail',
      'skipped',
      'skipped',
    ]);

    const unchecked = testerDecisions(
      { ...result, harness_lists_unchecked: ['work.github'] },
      { bindings, groups },
    );
    expect(
      unchecked.find((d) => d.handle === 'work.github')?.chain.find((g) => g.gate === 'harness'),
    ).toEqual({ gate: 'harness', outcome: 'skipped', detail: 'not checked: no harness given' });
  });

  it('narrows by entry over handle and item name', () => {
    expect(
      testerDecisions(result, { bindings, groups, entry: 'bank' }).map((d) => d.handle),
    ).toEqual(['blocked.one']);
    expect(
      testerDecisions(result, { bindings, groups, entry: 'github' }).map((d) => d.handle),
    ).toEqual(['work.github']);
  });
});
