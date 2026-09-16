/** @module features/auth/password-strength.test — requirement checks (length, match, advice) and the strength score */
import { describe, expect, it } from 'bun:test';
import { passwordChecks, passwordScore } from './password-strength.ts';
import { changePasswordForm } from './schemas.ts';

describe('password strength', () => {
  it('reports required and advisory checks', () => {
    const met = (current: string, next: string, confirm: string) =>
      Object.fromEntries(passwordChecks({ current, next, confirm }).map((c) => [c.id, c.met]));
    expect(met('old', 'short', '')).toEqual({
      length: false,
      variety: false,
      different: true,
      match: false,
    });
    expect(met('old', 'Correct-horse-9', 'Correct-horse-9')).toEqual({
      length: true,
      variety: true,
      different: true,
      match: true,
    });
    expect(met('same-password-1', 'same-password-1', 'x')['different']).toBe(false);
  });

  it('scores from too short to strong', () => {
    expect(passwordScore('')).toBe(0);
    expect(passwordScore('abc')).toBe(1);
    expect(passwordScore('abcdefghijkl')).toBe(2);
    expect(passwordScore('Abcdefghijk1')).toBe(3);
    expect(passwordScore('a long passphrase for the hive')).toBe(4);
  });

  it('rejects a confirmation that does not match', () => {
    const result = changePasswordForm.safeParse({
      current_password: 'x',
      new_password: 'long-enough-password',
      confirm_password: 'long-enough-passwordX',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confirm_password']);
  });
});
