/** @module kernel/slug.test — slug validation, sanitization and session-id parsing. */

import { describe, expect, it } from 'bun:test';
import { isAppError } from './errors/app-error.ts';
import {
  assertValidSlug,
  FALLBACK_SLUG,
  isValidSlug,
  parseSessionId,
  parseSlug,
  SLUG_RE,
  sanitizeSlug,
} from './slug.ts';

describe('slug validation', () => {
  it('accepts the slug grammar', () => {
    for (const s of ['ab', 'shop', 'agent-1', 'a-b-c', `a${'b'.repeat(31)}`]) {
      expect(isValidSlug(s)).toBe(true);
      expect(parseSlug(s).ok).toBe(true);
    }
  });

  it('rejects violations with registry details', () => {
    for (const s of ['a', '1ab', '-ab', 'Ab', 'a_b', 'ab ', `a${'b'.repeat(32)}`, '']) {
      expect(isValidSlug(s)).toBe(false);
      const r = parseSlug(s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ slug: s, pattern: '^[a-z][a-z0-9-]{1,31}$' });
    }
  });

  it('assertValidSlug throws INVALID_SLUG with its public message', () => {
    expect(() => assertValidSlug('ok-slug')).not.toThrow();
    try {
      assertValidSlug('Bad Slug');
      throw new Error('unreachable');
    } catch (error) {
      expect(isAppError(error, 'INVALID_SLUG')).toBe(true);
      if (isAppError(error, 'INVALID_SLUG')) {
        expect(error.details).toEqual({ slug: 'Bad Slug', pattern: '^[a-z][a-z0-9-]{1,31}$' });
        expect(error.publicMessage).toBe(
          "Invalid slug 'Bad Slug'. Slugs must match /^[a-z][a-z0-9-]{1,31}$/ (start with a lowercase letter, 2–32 chars, lowercase alphanumerics and dashes).",
        );
      }
    }
  });
});

describe('sanitizeSlug', () => {
  it('produces a valid slug from free text', () => {
    const cases: Array<[string, string]> = [
      ['My Shop', 'my-shop'],
      ['  --Hello__World!!  ', 'hello-world'],
      ['123abc', 'abc'],
      ['Ünïcödé', 'unicode'],
      ['a', 'a0'],
      ['', FALLBACK_SLUG],
      ['!!!', FALLBACK_SLUG],
      [`x${'y'.repeat(50)}`, `x${'y'.repeat(31)}`],
      ['end-with-dash-', 'end-with-dash'],
    ];
    for (const [input, expected] of cases) {
      const out = sanitizeSlug(input);
      expect(out).toBe(expected);
      expect(SLUG_RE.test(out)).toBe(true);
    }
  });
});

describe('parseSessionId', () => {
  it('splits canonical ids', () => {
    expect(parseSessionId('shop-a1b2c3d4')).toEqual({ slug: 'shop', suffix: 'a1b2c3d4' });
    expect(parseSessionId('agent-1-zz99zz99')).toEqual({ slug: 'agent-1', suffix: 'zz99zz99' });
  });

  it('returns null for non-canonical ids', () => {
    for (const id of ['shop', 'shop-A1B2C3D4', 'shop-a1b2c3d', '1shop-a1b2c3d4', '']) {
      expect(parseSessionId(id)).toBeNull();
    }
  });
});
