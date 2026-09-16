/** @module domain/auth/token-format — grammar and minting of bearer, grant, session and seed secrets (spec 03 §3.2–3.4). */

/**
 * Bearer/API tokens: `bh_<kind>_<secret>` where `kind` is `agent`, `operator` (who the token acts
 * as) or `grant` (single-use trace-link token) and `secret` is 32 random bytes in base64url
 * (43 chars). The **public prefix** is the first 8 chars of `secret`: it is stored in clear
 * (`credentials.public_prefix`) for listing/revocation and for the lookup that precedes the
 * constant-time hash compare. Cookie session tokens are the bare 43-char base64url secret.
 */

import { BEARER_TOKEN_RE } from '@browserhive/contracts/http';
import type { Random } from '../../ports/random.ts';

/** Bytes of entropy behind every minted token. */
export const TOKEN_BYTES = 32;
/** Characters of the secret part revealed as the public prefix. */
export const PUBLIC_PREFIX_LENGTH = 8;
/** Token kinds (the `<kind>` segment). */
export type TokenKind = 'agent' | 'operator' | 'grant';
/** Seed password length (spec 03 §3.4). */
export const SEED_PASSWORD_LENGTH = 24;
/** Seed alphabet without look-alikes (`0O`, `1lI`); 57 symbols, so rejection sampling is required. */
export const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** Grammar of a bearer/API token (re-exported from contracts for one import site). */
export const TOKEN_RE = BEARER_TOKEN_RE;

const PARSE_RE = /^bh_(agent|operator|grant)_([A-Za-z0-9_-]{43})$/;

/** A parsed token: its kind, the public prefix and the whole literal (never log it). */
export interface ParsedToken {
  readonly kind: TokenKind;
  readonly publicPrefix: string;
  readonly secret: string;
}

/** Encodes bytes as unpadded base64url. */
export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Mints a bare 43-char base64url secret (cookie session tokens). */
export function mintSecret(random: Random): string {
  return base64Url(random.bytes(TOKEN_BYTES));
}

/** Mints a `bh_<kind>_<secret>` token and returns it with its public prefix. */
export function mintToken(
  random: Random,
  kind: TokenKind,
): { token: string; publicPrefix: string } {
  const secret = mintSecret(random);
  return { token: `bh_${kind}_${secret}`, publicPrefix: secret.slice(0, PUBLIC_PREFIX_LENGTH) };
}

/** Parses a token literal; `null` when it does not follow the grammar. */
export function parseToken(literal: string): ParsedToken | null {
  if (!TOKEN_RE.test(literal)) return null;
  const match = PARSE_RE.exec(literal);
  const kind = match?.[1];
  const secret = match?.[2];
  if (secret === undefined) return null;
  if (kind !== 'agent' && kind !== 'operator' && kind !== 'grant') return null;
  return { kind, publicPrefix: secret.slice(0, PUBLIC_PREFIX_LENGTH), secret };
}

/** Draws the 24-character seed password with an unbiased CSPRNG (spec 03 §3.4). */
export function generateSeedPassword(random: Random, length = SEED_PASSWORD_LENGTH): string {
  return random.token(SEED_ALPHABET, length);
}

/** First characters of an id shown in lists (`id_prefix` of an auth session). */
export function idPrefix(id: string): string {
  return id.slice(0, PUBLIC_PREFIX_LENGTH);
}
