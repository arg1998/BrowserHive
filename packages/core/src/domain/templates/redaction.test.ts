/** @module domain/templates/redaction.test — sealed cookie-value redaction (spec 13 §5.4). */
import { describe, expect, it } from 'bun:test';
import { MIN_SEALED_VALUE_LENGTH, redactSealed, SEALED_MARK, sealedValues } from './redaction.ts';

describe('sealedValues', () => {
  it('keeps values of at least 12 characters, once, longest first', () => {
    expect(sealedValues(['short', 'abcdefghijkl', 'abcdefghijklmnop', 'abcdefghijkl', ''])).toEqual(
      ['abcdefghijklmnop', 'abcdefghijkl'],
    );
    expect(MIN_SEALED_VALUE_LENGTH).toBe(12);
  });
});

describe('redactSealed', () => {
  it('replaces every occurrence, the longer value first', () => {
    const values = sealedValues(['tok-123456789', 'tok-123456789-extended']);
    expect(redactSealed('a tok-123456789-extended b tok-123456789 c tok-123456789', values)).toBe(
      `a ${SEALED_MARK} b ${SEALED_MARK} c ${SEALED_MARK}`,
    );
  });

  it('leaves text without a value untouched, and an 11-character value is never a value', () => {
    expect(redactSealed('nothing here', sealedValues(['sentinel-value-1']))).toBe('nothing here');
    expect(redactSealed('abcdefghijk', sealedValues(['abcdefghijk']))).toBe('abcdefghijk');
  });
});
