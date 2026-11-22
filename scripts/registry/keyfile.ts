/** @module scripts/registry/keyfile — a registry root key at rest (spec 13 §10.2): the Ed25519 private key (PKCS#8) encrypted with AES-256-GCM under a key derived from the owner's passphrase with scrypt (N = 2^17, r = 8, p = 1), the slot, key id and public key bound in as associated data. Written once with mode 0600 and never overwritten. */

import {
  createCipheriv,
  createDecipheriv,
  type KeyObject,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { z } from 'zod';
import { canonicalJson, keyIdOf, privateKeyFromPkcs8, rawPublicKey } from '../registry-common.mjs';

const KIND = 'browserhive-registry-root-key';
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const MAXMEM = 256 * 1024 * 1024;

const KeyFile = z.strictObject({
  schema: z.literal(1),
  kind: z.literal(KIND),
  slot: z.number().int().min(1).max(2),
  key_id: z.string().regex(/^[0-9a-f]{16}$/),
  public_key: z.string(),
  test: z.boolean(),
  kdf: z.strictObject({
    name: z.literal('scrypt'),
    N: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    salt: z.string(),
  }),
  cipher: z.strictObject({ name: z.literal('aes-256-gcm'), iv: z.string(), tag: z.string() }),
  ciphertext: z.string(),
});

/** A decrypted root key. */
export interface RootKey {
  readonly slot: number;
  readonly keyId: string;
  readonly publicKey: string;
  readonly privateKey: KeyObject;
  readonly test: boolean;
}

function aad(slot: number, keyId: string, publicKey: string): Buffer {
  return Buffer.from(`${KIND}:${slot}:${keyId}:${publicKey}`, 'utf8');
}

function derive(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: MAXMEM });
}

/** Writes `data` to a new file with mode 0600; refuses an existing one. */
export function writeSecretFile(path: string, data: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Encrypts `key` for `slot` and writes it to `path` (a new file, 0600). */
export function writeRootKeyFile(
  path: string,
  slot: number,
  privateKey: KeyObject,
  passphrase: string,
  test: boolean,
): void {
  const publicKey = rawPublicKey(privateKey);
  const keyId = keyIdOf(publicKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    derive(passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p),
    iv,
  );
  cipher.setAAD(aad(slot, keyId, publicKey));
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  writeSecretFile(
    path,
    canonicalJson({
      schema: 1,
      kind: KIND,
      slot,
      key_id: keyId,
      public_key: publicKey,
      test,
      kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
      cipher: {
        name: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
      ciphertext: ciphertext.toString('base64'),
    }),
  );
}

/**
 * Reads and decrypts a root key file.
 *
 * @throws When the file is not a root key, or the passphrase is wrong.
 */
export function readRootKeyFile(path: string, passphrase: string): RootKey {
  const file = KeyFile.parse(JSON.parse(readFileSync(path, 'utf8')));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf.N, file.kdf.r, file.kdf.p),
    Buffer.from(file.cipher.iv, 'base64'),
  );
  decipher.setAAD(aad(file.slot, file.key_id, file.public_key));
  decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
  let pkcs8: Buffer;
  try {
    pkcs8 = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new Error(`${path}: wrong passphrase, or the file was changed`);
  }
  const privateKey = privateKeyFromPkcs8(pkcs8);
  const publicKey = rawPublicKey(privateKey);
  if (publicKey !== file.public_key || keyIdOf(publicKey) !== file.key_id) {
    throw new Error(`${path}: the key does not match its public key`);
  }
  return { slot: file.slot, keyId: file.key_id, publicKey, privateKey, test: file.test };
}
