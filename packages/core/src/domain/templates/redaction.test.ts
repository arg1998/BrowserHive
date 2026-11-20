/** @module domain/templates/redaction.test — sealed cookie-value redaction (spec 13 §5.4). */
import { describe, expect, it } from 'bun:test';
import {
  couldBeSecret,
  isPublicValue,
  MIN_SEALED_VALUE_LENGTH,
  redactSealed,
  SEALED_MARK,
  sealedForms,
  sealedValues,
} from './redaction.ts';

describe('sealedValues', () => {
  it('keeps values of at least 12 characters that could be secrets, once, longest first', () => {
    expect(sealedValues(['short', 'abc123def456', 'abc123def456ghi7', 'abc123def456', ''])).toEqual(
      ['abc123def456ghi7', 'abc123def456'],
    );
    // Deny by default: a letters-only value of 12 characters is redacted too (review #88 H1).
    expect(sealedValues(['abcdefghijkl'])).toContain('abcdefghijkl');
    expect(MIN_SEALED_VALUE_LENGTH).toBe(12);
  });
});

/** A 32-character token, the shape of a session id or an API key (built at run time: no secret-shaped literal for gitleaks). */
const TOKEN = ['Q7f2Kx9L', 'mZ0pR4tV', '8wY1bN6c', 'H3jD5sGa'].join('');

/** Pieces joined at run time, so the source holds no secret-shaped literal (gitleaks). */
const j = (...parts: string[]): string => parts.join('');

describe('what could be a secret: deny by default (workload test B1, review #88 H1)', () => {
  it('public forms stay: numbers, ms timestamps, ISO dates, IANA zones, language lists, public URLs', () => {
    for (const value of [
      '0',
      'true',
      'en-US',
      '1794951001039',
      '1700000000',
      '-12.5',
      '2026-11-17',
      '2026-11-17T21:30:30.848Z',
      'America/Toronto',
      'America/Argentina/Buenos_Aires',
      'Etc/GMT+5',
      'en-US,en;q=0.9',
      'en-US,en;q=0.9,fr-CA;q=0.8',
      'zh-Hant-TW,zh;q=0.8',
      'https://mail.google.com/mail/u/0/#inbox',
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/in/some-person-name/',
    ]) {
      expect({ value, secret: couldBeSecret(value) }).toEqual({ value, secret: false });
    }
  });

  it("the session's own identity values stay, exactly", () => {
    const identity = ['Pacific/Kiritimati', 'en-CA', 'en-CA,en'];
    expect(isPublicValue('Pacific/Kiritimati', identity)).toBe(true);
    expect(couldBeSecret('not-a-zone/at-all-x', ['not-a-zone/at-all-x'])).toBe(false);
    expect(couldBeSecret('not-a-zone/at-all-x')).toBe(true);
  });

  it("the reviewer's leak list is redacted", () => {
    for (const value of [
      TOKEN,
      '100012345678901',
      '482910375619',
      '482910375619284',
      j('1700000000.', '83746519283746519283746'),
      '4829-1037-5619-2846',
      '4829 1037 5619 2846',
      '1234 5678 9012 3456 7890',
      'AB12-CD34-EF56-GH78',
      'x7k2-m9p4-q3r8-z5w1',
      j('kqzvhxwp', 'jtmrbnfd'),
      j('kqzvhxwpjt-', 'mrbnfdqazx-', 'plmoknijub'),
      'correct-horse-battery-staple',
      'Tiger.Banana.Purple.Rocket',
      j('https://app.example.com/cb?code=', 'kqzvhxwpjtmrbnfd'),
      'https://app.example.com/reset/4829/1037/5619',
      j('2026-11-17 ', 'kqzvhxwpjtmrbnfd'),
      j('en-US,en;q=0.9 ', 'kqzvhxwpjtmrbnfd'),
      j('aBcdEfgH', 'ijKlmNop'),
      j('JBSWY-MPKXQ-', 'ZRTLN-ABCDE'),
      j('jbsw ympk ', 'xqzr tlna bcde fghi'),
      j('JBSWY MPKXQ ', 'ZRTLN ABCDE'),
      j('deadbeef', 'cafebabe'),
      'GA1.1.123456789.1700000000',
      'tok-123456789',
      'sentinel-cookie-7f3a9c2e5b1d',
      '550e8400-e29b-41d4-a716-446655440000',
      'ajax:1234567890123456789',
      '"quoted-sentinel-9f2c4e7a1b"',
      '{"theme":"dark"}',
      'accepted_all',
      'v=2&lang=en-us',
      'abc-defghijk',
      'kqzvh-Abcd-QZ,ab',
      'amir.someone@example.com',
      'https://user:pw@example.com/',
      ' America/Toronto',
    ]) {
      expect({ value, secret: couldBeSecret(value) }).toEqual({ value, secret: true });
    }
  });

  it('known gap, pinned: a letters-only token as a URL path segment counts as a public URL', () => {
    // Documented in spec 13 §5.4 and the templates guide; a URL with a query, digits in a segment
    // or more than 8 digits outside the host redacts.
    expect(couldBeSecret(j('https://app.example.com/reset/', 'kqzvhxwpjtmrbnfd'))).toBe(false);
    expect(couldBeSecret(j('https://app.example.com/reset/', 'kqzv4hxwpjtmrbnfd'))).toBe(true);
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
