/** @module domain/templates/envelope — the encrypted file format of template checkpoints and versions (spec 13 §2.4): AES-256-GCM with a random 96-bit nonce, the header bound into the additional authenticated data together with `<template_id>:<slot>`, so a file cannot be altered, moved between templates or slots, or read with another key. node:crypto only; no homemade primitive. */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** `BHTE`. */
export const ENVELOPE_MAGIC = Buffer.from('BHTE', 'ascii');
/** The only format this binary writes and reads. */
export const ENVELOPE_FORMAT = 1;
/** Bytes of the key id in the header: the first 8 bytes of SHA-256 of the key. */
export const KEY_ID_BYTES = 8;
/** GCM nonce bytes (96 bits, random per file). */
export const NONCE_BYTES = 12;
/** GCM tag bytes. */
export const TAG_BYTES = 16;
/** AES-256 key bytes. */
export const KEY_BYTES = 32;
/** magic (4) + format (1) + key id (8): the part of the header that is authenticated. */
const PREFIX_BYTES = ENVELOPE_MAGIC.length + 1 + KEY_ID_BYTES;
/** The whole header: prefix + nonce. */
export const HEADER_BYTES = PREFIX_BYTES + NONCE_BYTES;

/** A resolved template key (spec 13 §2.4): 32 bytes and its id. */
export interface TemplateKey {
  /** 16 hex characters: the first 8 bytes of SHA-256 of the key. */
  readonly keyId: string;
  readonly key: Uint8Array;
}

/** Which file of a template: a numbered version or the rolling checkpoint. */
export type StateSlot = number | 'latest';

/** Why a file could not be opened. */
export type EnvelopeFailure =
  /** Not an envelope this binary reads (magic, format, length). */
  | 'malformed'
  /** Written with a key none of the given keys matches. */
  | 'key_mismatch'
  /** The tag did not verify: altered header or body, wrong slot or template, truncated. */
  | 'auth_failed';

/** A file that could not be opened, with the key id from its header when it had one. */
export class EnvelopeError extends Error {
  readonly failure: EnvelopeFailure;
  readonly keyId: string | null;

  constructor(failure: EnvelopeFailure, keyId: string | null) {
    super(`template state envelope: ${failure}`);
    this.name = 'EnvelopeError';
    this.failure = failure;
    this.keyId = keyId;
  }
}

/** The key id of `key` (spec 13 §2.4). */
export function templateKeyId(key: Uint8Array): string {
  return createHash('sha256').update(key).digest().subarray(0, KEY_ID_BYTES).toString('hex');
}

/** A {@link TemplateKey} from 32 raw bytes. @throws Error when it is not 32 bytes. */
export function templateKeyOf(key: Uint8Array): TemplateKey {
  if (key.length !== KEY_BYTES) throw new Error(`a template key is ${KEY_BYTES} bytes`);
  return { keyId: templateKeyId(key), key: Uint8Array.from(key) };
}

/** The slot as written into the additional authenticated data. */
function slotText(slot: StateSlot): string {
  return slot === 'latest' ? 'latest' : String(slot);
}

/** AAD: the 13-byte header prefix, then `<template_id>:<slot>` (UTF-8). */
function aadOf(prefix: Uint8Array, templateId: string, slot: StateSlot): Buffer {
  return Buffer.concat([prefix, Buffer.from(`${templateId}:${slotText(slot)}`, 'utf8')]);
}

/** The parsed header of an envelope, or `null` when `bytes` is not one this binary reads. */
export function readEnvelopeHeader(
  bytes: Uint8Array,
): { readonly keyId: string; readonly nonce: Uint8Array; readonly prefix: Uint8Array } | null {
  if (bytes.length < HEADER_BYTES + TAG_BYTES) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) return null;
  if (buf[ENVELOPE_MAGIC.length] !== ENVELOPE_FORMAT) return null;
  return {
    keyId: buf.subarray(ENVELOPE_MAGIC.length + 1, PREFIX_BYTES).toString('hex'),
    nonce: buf.subarray(PREFIX_BYTES, HEADER_BYTES),
    prefix: buf.subarray(0, PREFIX_BYTES),
  };
}

/**
 * Encrypts `plaintext` for one slot of one template: header, ciphertext, tag. The nonce is random
 * per call (`nonce` is a test seam only).
 */
export function sealEnvelope(
  plaintext: Uint8Array,
  key: TemplateKey,
  templateId: string,
  slot: StateSlot,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error(`a nonce is ${NONCE_BYTES} bytes`);
  const prefix = Buffer.concat([
    ENVELOPE_MAGIC,
    Buffer.from([ENVELOPE_FORMAT]),
    Buffer.from(key.keyId, 'hex'),
  ]);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(prefix, templateId, slot));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([prefix, nonce, body, cipher.getAuthTag()]);
}

/** Constant-time comparison of two hex key ids. */
function sameKeyId(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Decrypts an envelope of `templateId`/`slot` with the key whose id its header names, among `keys`
 * (the current key, then `templateKeyPrevious`).
 *
 * @throws EnvelopeError `malformed`, `key_mismatch` or `auth_failed`.
 */
export function openEnvelope(
  bytes: Uint8Array,
  keys: readonly TemplateKey[],
  templateId: string,
  slot: StateSlot,
): { readonly plaintext: Uint8Array; readonly key: TemplateKey } {
  const header = readEnvelopeHeader(bytes);
  if (header === null) throw new EnvelopeError('malformed', null);
  const key = keys.find((k) => sameKeyId(k.keyId, header.keyId));
  if (key === undefined) throw new EnvelopeError('key_mismatch', header.keyId);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(HEADER_BYTES, buf.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, header.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aadOf(header.prefix, templateId, slot));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    return { plaintext, key };
  } catch {
    throw new EnvelopeError('auth_failed', header.keyId);
  }
}
