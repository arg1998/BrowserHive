/** @module domain/templates/envelope.test — the template file envelope (spec 13 §2.4): layout, round trip, no plaintext, random nonces, tampered tag/body/nonce, AAD binding of template and slot, altered header and key id. */

import { describe, expect, it } from 'bun:test';
import {
  EnvelopeError,
  HEADER_BYTES,
  NONCE_BYTES,
  openEnvelope,
  readEnvelopeHeader,
  sealEnvelope,
  TAG_BYTES,
  templateKeyId,
  templateKeyOf,
} from './envelope.ts';

const KEY = templateKeyOf(new Uint8Array(32).fill(7));
const OTHER = templateKeyOf(new Uint8Array(32).fill(9));
const TEMPLATE = 'tp-aaaaaaaaaa';
const PLAIN = new TextEncoder().encode(JSON.stringify({ cookies: [{ name: 'li_at' }] }));

function failure(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof EnvelopeError) return err.failure;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('template envelope (spec 13 §2.4)', () => {
  it('writes magic, format, key id and a 12-byte nonce, then ciphertext and a 16-byte tag', () => {
    const sealed = sealEnvelope(PLAIN, KEY, TEMPLATE, 3);
    expect(Buffer.from(sealed.subarray(0, 4)).toString('ascii')).toBe('BHTE');
    expect(sealed[4]).toBe(1);
    expect(Buffer.from(sealed.subarray(5, 13)).toString('hex')).toBe(KEY.keyId);
    expect(sealed.length).toBe(HEADER_BYTES + PLAIN.length + TAG_BYTES);
    expect(readEnvelopeHeader(sealed)?.keyId).toBe(KEY.keyId);
  });

  it('round-trips with the key, the template and the slot', () => {
    const sealed = sealEnvelope(PLAIN, KEY, TEMPLATE, 'latest');
    const opened = openEnvelope(sealed, [OTHER, KEY], TEMPLATE, 'latest');
    expect(Buffer.from(opened.plaintext).equals(Buffer.from(PLAIN))).toBe(true);
    expect(opened.key.keyId).toBe(KEY.keyId);
  });

  it('holds no plaintext: a cookie name is not in the file', () => {
    const sealed = Buffer.from(sealEnvelope(PLAIN, KEY, TEMPLATE, 1));
    expect(sealed.includes(Buffer.from('li_at'))).toBe(false);
    expect(sealed.includes(Buffer.from(TEMPLATE))).toBe(false);
  });

  it('uses a fresh random nonce for every file', () => {
    const a = sealEnvelope(PLAIN, KEY, TEMPLATE, 1);
    const b = sealEnvelope(PLAIN, KEY, TEMPLATE, 1);
    expect(Buffer.from(a.subarray(13, 13 + NONCE_BYTES))).not.toEqual(
      Buffer.from(b.subarray(13, 13 + NONCE_BYTES)),
    );
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('fails authentication on a tampered tag, body or nonce', () => {
    for (const at of [-1, HEADER_BYTES + 2, 14]) {
      const sealed = Buffer.from(sealEnvelope(PLAIN, KEY, TEMPLATE, 1));
      const index = at < 0 ? sealed.length + at : at;
      sealed[index] = (sealed[index] ?? 0) ^ 0x01;
      expect(failure(() => openEnvelope(sealed, [KEY], TEMPLATE, 1))).toBe('auth_failed');
    }
  });

  it('binds the template and the slot (AAD): a moved file does not open', () => {
    const sealed = sealEnvelope(PLAIN, KEY, TEMPLATE, 1);
    expect(failure(() => openEnvelope(sealed, [KEY], 'tp-bbbbbbbbbb', 1))).toBe('auth_failed');
    expect(failure(() => openEnvelope(sealed, [KEY], TEMPLATE, 2))).toBe('auth_failed');
    expect(failure(() => openEnvelope(sealed, [KEY], TEMPLATE, 'latest'))).toBe('auth_failed');
  });

  it('binds the header: an altered format or key id is refused', () => {
    const format = Buffer.from(sealEnvelope(PLAIN, KEY, TEMPLATE, 1));
    format[4] = 2;
    expect(failure(() => openEnvelope(format, [KEY], TEMPLATE, 1))).toBe('malformed');
    // A key id rewritten to another key's id: that key is tried and the tag fails.
    const keyId = Buffer.from(sealEnvelope(PLAIN, KEY, TEMPLATE, 1));
    Buffer.from(OTHER.keyId, 'hex').copy(keyId, 5);
    expect(failure(() => openEnvelope(keyId, [KEY, OTHER], TEMPLATE, 1))).toBe('auth_failed');
  });

  it('reports a key mismatch with the key id of the file', () => {
    const sealed = sealEnvelope(PLAIN, KEY, TEMPLATE, 1);
    try {
      openEnvelope(sealed, [OTHER], TEMPLATE, 1);
      throw new Error('opened');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).failure).toBe('key_mismatch');
      expect((err as EnvelopeError).keyId).toBe(KEY.keyId);
    }
  });

  it('refuses a truncated or foreign file as malformed', () => {
    const sealed = sealEnvelope(PLAIN, KEY, TEMPLATE, 1);
    expect(failure(() => openEnvelope(sealed.subarray(0, 20), [KEY], TEMPLATE, 1))).toBe(
      'malformed',
    );
    expect(failure(() => openEnvelope(PLAIN, [KEY], TEMPLATE, 1))).toBe('malformed');
  });

  it('derives the key id from SHA-256 of the key (8 bytes, hex)', () => {
    expect(templateKeyId(KEY.key)).toHaveLength(16);
    expect(templateKeyId(KEY.key)).not.toBe(templateKeyId(OTHER.key));
    expect(() => templateKeyOf(new Uint8Array(31))).toThrow();
  });
});
