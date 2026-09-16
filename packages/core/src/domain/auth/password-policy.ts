/** @module domain/auth/password-policy — length and difference rules for operator passwords (spec 03 §3.4). */

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@browserhive/contracts/http';
import { AppError } from '../../kernel/errors/app-error.ts';
import { err, ok, type Result } from '../../kernel/result.ts';

/** Why a new password was rejected. */
export type PasswordPolicyViolation = 'too_short' | 'too_long' | 'same_as_current';

/** Checks `next` against the policy; `current` is the plaintext being replaced. */
export function checkPasswordPolicy(
  next: string,
  current: string,
): Result<void, PasswordPolicyViolation> {
  if (next.length < PASSWORD_MIN_LENGTH) return err('too_short');
  if (next.length > PASSWORD_MAX_LENGTH) return err('too_long');
  if (next === current) return err('same_as_current');
  return ok(undefined);
}

/** Throws `WEAK_PASSWORD {min_length}` for any policy violation (message names the rule). */
export function assertPasswordPolicy(next: string, current: string): void {
  const result = checkPasswordPolicy(next, current);
  if (result.ok) return;
  const publicMessage =
    result.error === 'too_short'
      ? `The new password must be at least ${PASSWORD_MIN_LENGTH} characters long.`
      : result.error === 'too_long'
        ? `The new password must be at most ${PASSWORD_MAX_LENGTH} characters long.`
        : 'The new password must differ from the current password.';
  throw new AppError('WEAK_PASSWORD', { min_length: PASSWORD_MIN_LENGTH }, { publicMessage });
}
