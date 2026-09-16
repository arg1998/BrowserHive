/** @module features/auth/password-strength — live requirement checks and a coarse strength score for the change-password form (the server only enforces the minimum length) */
import { MIN_PASSWORD } from './schemas.ts';

/** One requirement row. */
export interface PasswordCheck {
  readonly id: 'length' | 'variety' | 'different' | 'match';
  readonly label: string;
  readonly met: boolean;
  /** `true` when the server requires it; the others are advice. */
  readonly required: boolean;
}

function classes(value: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
}

/** Requirement checks for the current values. */
export function passwordChecks(input: {
  readonly current: string;
  readonly next: string;
  readonly confirm: string;
}): readonly PasswordCheck[] {
  return [
    {
      id: 'length',
      label: `At least ${MIN_PASSWORD} characters`,
      met: input.next.length >= MIN_PASSWORD,
      required: true,
    },
    {
      id: 'variety',
      label: 'Mixes letters, numbers or symbols (or is a long passphrase)',
      met: classes(input.next) >= 3 || input.next.length >= 20,
      required: false,
    },
    {
      id: 'different',
      label: 'Different from the current password',
      met: input.next.length > 0 && input.next !== input.current,
      required: false,
    },
    {
      id: 'match',
      label: 'Both new passwords match',
      met: input.confirm.length > 0 && input.next === input.confirm,
      required: true,
    },
  ];
}

/** 0 (empty) … 4 (strong). */
export function passwordScore(value: string): 0 | 1 | 2 | 3 | 4 {
  if (value.length === 0) return 0;
  if (value.length < MIN_PASSWORD) return 1;
  const variety = classes(value);
  if (value.length >= 20 || (value.length >= 16 && variety >= 3)) return 4;
  if (variety >= 3) return 3;
  return 2;
}

/** Label for a score. */
export const SCORE_LABEL = ['', 'Too short', 'Fair', 'Good', 'Strong'] as const;
