/// <reference types="bun-types" />
/** @module contracts/test/http/vault-harnesses.test — the `harnesses` field of vault bindings and group policies (D-48): additive, bounded, field-level errors, `null` clears, and it round-trips through the v3 export document. */
import { describe, expect, it } from 'bun:test';
import {
  PutGroupPolicyRequest,
  PutVaultBindingRequest,
  VaultBinding,
  VaultExportDocument,
  VaultGroupPolicy,
  VaultHarnessesResponse,
} from '../../src/http/index.ts';
import * as fx from './fixtures.ts';

describe('harnesses on vault rules (D-48)', () => {
  it('is optional on responses: an existing binding or policy still parses unchanged', () => {
    expect(VaultBinding.parse(fx.vaultBinding())).not.toHaveProperty('harnesses');
    expect(VaultGroupPolicy.parse(fx.vaultGroupPolicy())).not.toHaveProperty('harnesses');
    const restricted = { ...fx.vaultBinding(), harnesses: ['opencode', 'Nightly Scraper'] };
    expect(VaultBinding.parse(restricted).harnesses).toEqual(['opencode', 'Nightly Scraper']);
    expect(VaultBinding.parse({ ...fx.vaultBinding(), harnesses: [] }).harnesses).toEqual([]);
  });

  it('PUT bodies keep (absent), clear (null), set and empty the list', () => {
    expect(PutVaultBindingRequest.parse({})).not.toHaveProperty('harnesses');
    expect(PutVaultBindingRequest.parse({ harnesses: null }).harnesses).toBeNull();
    expect(PutVaultBindingRequest.parse({ harnesses: [] }).harnesses).toEqual([]);
    expect(
      PutGroupPolicyRequest.parse({ access_mode: 'manual', harnesses: [' Claude-Code '] })
        .harnesses,
    ).toEqual(['Claude-Code']);
  });

  const bad: readonly (readonly [string, unknown, string])[] = [
    ['an empty name', [''], 'a harness name cannot be empty'],
    ['a blank name', ['   '], 'a harness name cannot be empty'],
    ['a name over 64 characters', ['x'.repeat(65)], 'a harness name has at most 64 characters'],
    ['a control character', ['bad\tname'], 'a harness name cannot contain control characters'],
    ['more than 32 entries', Array.from({ length: 33 }, (_, i) => `h${i}`), 'at most 32 harnesses'],
    ['a non-string entry', [42], ''],
    ['a string instead of a list', 'opencode', ''],
  ];
  for (const [name, harnesses, message] of bad) {
    it(`rejects ${name} with a field-level issue`, () => {
      for (const schema of [PutVaultBindingRequest, PutGroupPolicyRequest]) {
        const parsed = schema.safeParse({ access_mode: 'manual', harnesses });
        expect(parsed.success).toBe(false);
        const issue = parsed.error?.issues[0];
        expect(issue?.path[0]).toBe('harnesses');
        if (message !== '') expect(issue?.message).toBe(message);
      }
    });
  }

  it('round-trips through the v3 export document; an older document still imports', () => {
    const { created_at: _c, updated_at: _u, version: _v, ...binding } = fx.vaultBinding();
    const { created_at: _pc, updated_at: _pu, version: _pv, ...policy } = fx.vaultGroupPolicy();
    const doc = {
      version: 3,
      bindings: [{ ...binding, harnesses: ['claude-code', 'OpenCode'] }],
      policies: [{ ...policy, harnesses: [] }],
    };
    const parsed = VaultExportDocument.parse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.bindings[0]?.harnesses).toEqual(['claude-code', 'OpenCode']);
    expect(parsed.policies[0]?.harnesses).toEqual([]);
    const older = VaultExportDocument.parse({
      version: 3,
      bindings: [binding],
      policies: [policy],
    });
    expect(older.bindings[0]).not.toHaveProperty('harnesses');
  });

  it('describes the harness picker response', () => {
    expect(
      VaultHarnessesResponse.parse({
        data: [
          {
            harness: 'opencode',
            label: 'OpenCode',
            declared: 'OpenCode',
            sessions: 3,
            last_seen_at: 1,
          },
          { harness: 'unknown', label: 'Unknown', declared: null, sessions: 0, last_seen_at: 2 },
        ],
        principals: 1,
        window: { since: 0, until: 2 },
        now: 2,
      }).data,
    ).toHaveLength(2);
  });
});
