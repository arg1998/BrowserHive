/** @module domain/policies/access-rule.test — the shared principal rule and the template grant: D-48's harness gate cases, run against the template rule (spec 13 §6.1, D-52). */

import { describe, expect, it } from 'bun:test';
import { HARNESS_GATE_CASES } from '../vault/test-support.ts';
import {
  type AccessVerdict,
  checkTemplateAccess,
  isPrincipalAuthorized,
  type TemplateAccessRule,
} from './access-rule.ts';

describe('isPrincipalAuthorized', () => {
  it('an empty list allows any principal; a list allows exactly its members', () => {
    expect(isPrincipalAuthorized({ principals: [] }, 'anyone')).toBe(true);
    expect(isPrincipalAuthorized({ principals: ['p-a'] }, 'p-a')).toBe(true);
    expect(isPrincipalAuthorized({ principals: ['p-a'] }, 'p-b')).toBe(false);
    expect(isPrincipalAuthorized({ principals: ['p-a'] }, 'P-A')).toBe(false);
  });
});

describe('checkTemplateAccess — D-48 harness gate cases on the template rule', () => {
  // A template has one list (no folder list) and no slug rule, so the cases with a folder list or a
  // slug rule do not apply; every other case must give the template the verdict the vault gives.
  const cases = HARNESS_GATE_CASES.filter((c) => c.group === null && c.binding.slugs === undefined);

  it('covers the single-list cases of the shared table', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const c of cases) {
    it(c.name, () => {
      const rule: TemplateAccessRule = {
        principals: c.binding.principals ?? [],
        harnesses: c.binding.harnesses,
      };
      const verdict = checkTemplateAccess(rule, {
        principal: c.principal,
        harness: c.harness,
        declared: c.declared,
      });
      const expected: AccessVerdict =
        c.expected.verdict === 'fill'
          ? { allowed: true }
          : {
              allowed: false,
              reason:
                c.expected.reason === 'harness_not_allowed'
                  ? 'harness_not_allowed'
                  : 'principal_not_allowed',
            };
      expect(verdict).toEqual(expected);
    });
  }
});

describe('checkTemplateAccess — gate order', () => {
  it('names the principal when both the principal and the harness would refuse', () => {
    expect(
      checkTemplateAccess(
        { principals: ['p-a'], harnesses: [] },
        { principal: 'p-b', harness: 'claude-code', declared: null },
      ),
    ).toEqual({ allowed: false, reason: 'principal_not_allowed' });
  });

  it('no list means every harness, an empty list none', () => {
    const subject = { principal: 'local', harness: null, declared: null };
    expect(checkTemplateAccess({ principals: [], harnesses: null }, subject)).toEqual({
      allowed: true,
    });
    expect(checkTemplateAccess({ principals: [], harnesses: [] }, subject)).toEqual({
      allowed: false,
      reason: 'harness_not_allowed',
    });
  });
});
