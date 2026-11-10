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

describe('escaped and encoded forms (review H-2, L-1)', () => {
  const secret = 'v1"quoted\\back\u0001slash-token';
  const values = sealedValues([secret]);

  it('redacts the JSON text block of a result, where quotes and backslashes are escaped', () => {
    const text = JSON.stringify({
      html: `<p>${secret}</p>`,
      nested: { yaml: JSON.stringify(secret) },
    });
    const redacted = redactSealed(text, values);
    expect(redacted).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(JSON.parse(redacted)).toEqual({
      html: `<p>${SEALED_MARK}</p>`,
      nested: { yaml: `"${SEALED_MARK}"` },
    });
  });

  it('redacts the URL-encoded and HTML-escaped forms', () => {
    const plain = 'from-site-a.test&x<y>"z"';
    const forms = sealedValues([plain]);
    expect(redactSealed(`https://x.test/?sid=${encodeURIComponent(plain)}`, forms)).toBe(
      `https://x.test/?sid=${SEALED_MARK}`,
    );
    expect(redactSealed('<p>from-site-a.test&amp;x&lt;y&gt;&quot;z&quot;</p>', forms)).toBe(
      `<p>${SEALED_MARK}</p>`,
    );
  });
});
