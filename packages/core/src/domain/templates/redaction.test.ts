/** @module domain/templates/redaction.test — sealed cookie-value redaction (spec 13 §5.4). */
import { describe, expect, it } from 'bun:test';
import {
  couldBeSecret,
  isPlainValue,
  MIN_SEALED_VALUE_LENGTH,
  redactSealed,
  SEALED_MARK,
  sealedForms,
  sealedValues,
} from './redaction.ts';

describe('sealedValues', () => {
  it('keeps values of at least 12 characters that could be secrets, once, longest first', () => {
    expect(
      sealedValues([
        'short',
        'abc123def456',
        'abc123def456ghi7',
        'abc123def456',
        'abcdefghijkl',
        '',
      ]),
    ).toEqual(['abc123def456ghi7', 'abc123def456']);
    expect(MIN_SEALED_VALUE_LENGTH).toBe(12);
  });
});

/** A 32-character token, the shape of a session id or an API key. */
const TOKEN = 'Q7f2Kx9LmZ0pR4tV8wY1bN6cH3jD5sGa';

describe('what could be a secret (workload test B1)', () => {
  it('never short or plain values: numbers, booleans, locales, time zones, words, plain URLs, dates', () => {
    for (const value of [
      '0',
      '1',
      'true',
      'false',
      'en-US',
      'en-US,en;q=0.9',
      'fr-CA,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'America/Toronto',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+5',
      'https://mail.google.com/mail/u/0/#inbox',
      'https://www.linkedin.com/feed/',
      '/mail/u/0/#inbox',
      'accepted_all',
      'Remember me on this device',
      'selectedTabIndex',
      '1794951001039',
      '-12.5',
      '2026-11-17',
      '2026-11-17T21:30:30.848Z',
      'dark-mode,compact',
      'utf8; charset v2 100vh',
      'Montréal, Québec',
    ]) {
      expect({ value, secret: couldBeSecret(value) }).toEqual({ value, secret: false });
    }
  });

  it('tokens: mixed letters and digits, long digit runs, quotes, braces and long numbers', () => {
    for (const value of [
      TOKEN,
      'tok-123456789',
      'sentinel-cookie-7f3a9c2e5b1d',
      'AQEDAR0aBcDeFgHiJkLmNoPqRsTuVwXyZ',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      '550e8400-e29b-41d4-a716-446655440000',
      'ajax:1234567890123456789',
      '"quoted-sentinel-9f2c4e7a1b"',
      'v1"quoted\\back\u0001slash-token',
      '{"theme":"dark"}',
      '12345678901234567890',
      'https://x.test/cb?code=4f9a8b7c6d5e',
      'ab3d-9fk2-x7q1-m4p8',
    ]) {
      expect({ value, secret: couldBeSecret(value) }).toEqual({ value, secret: true });
    }
    expect(isPlainValue('America/Toronto')).toBe(true);
  });

  it('a Gmail URL stays whole next to cookies valued 0, true, a locale and a time zone', () => {
    const url = 'https://mail.google.com/mail/u/0/#inbox';
    const values = sealedValues(['0', '1', 'true', 'en-US', 'America/Toronto', url, TOKEN]);
    const text = JSON.stringify({ url, tabs: [{ url: `${url}/FMfcgzQ` }], tz: 'America/Toronto' });
    expect(redactSealed(text, values)).toBe(text);
  });

  it('a 32-character token is redacted in every form, and only the matching text', () => {
    const values = sealedValues([TOKEN]);
    for (const form of sealedForms(TOKEN)) {
      expect(redactSealed(`url https://mail.google.com/mail/u/0/?t=${form}#inbox`, values)).toBe(
        `url https://mail.google.com/mail/u/0/?t=${SEALED_MARK}#inbox`,
      );
    }
    expect(redactSealed(`a${encodeURIComponent(TOKEN)}b`, values)).toBe(`a${SEALED_MARK}b`);
    expect(redactSealed(JSON.stringify(JSON.stringify({ t: TOKEN })), values)).not.toContain(TOKEN);
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
