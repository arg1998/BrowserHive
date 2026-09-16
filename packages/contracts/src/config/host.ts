/** @module contracts/config/host — host grammar (IPv4, IPv6, RFC 1123 hostname) and the shared loopback test (spec 08 §2.1) */
import { z } from 'zod';
import { grammarFail as fail, GRAMMAR_META_KEY } from './grammar.ts';

// ---------------------------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------------------------

const HOST_GRAMMAR = 'an IPv4 address, an IPv6 address, or a hostname';
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const HEX16 = /^[0-9a-f]{1,4}$/i;

/**
 * IPv4 literal check (dotted quad, no leading zeros beyond a single `0`).
 *
 * @returns `true` for a valid IPv4 literal.
 */
export function isIPv4(value: string): boolean {
  return IPV4_RE.test(value);
}

/**
 * IPv6 literal check (without brackets): up to eight hextets, one `::` compression, optional
 * embedded IPv4 tail. Zone ids are not accepted.
 *
 * @returns `true` for a valid IPv6 literal.
 */
export function isIPv6(value: string): boolean {
  if (value.includes(':::') || value.split('::').length > 2) return false;
  const [head = '', tail] = value.split('::');
  const parts = (segment: string): string[] => (segment === '' ? [] : segment.split(':'));
  const groups = [...parts(head), ...(tail === undefined ? [] : parts(tail))];
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (index === groups.length - 1 && group.includes('.')) {
      if (!isIPv4(group)) return false;
      count += 2;
    } else if (HEX16.test(group)) {
      count += 1;
    } else {
      return false;
    }
  }
  return tail === undefined ? count === 8 : count < 8;
}

/**
 * Host grammar: IPv4, IPv6 (with or without brackets) or an RFC 1123 hostname. Output: the host
 * without brackets. `127.evil.example` is a hostname, not loopback.
 */
export const zHost = z
  .string()
  .transform((value, ctx): string => {
    const raw = value.trim();
    const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
    if (bare === '') return fail(ctx, HOST_GRAMMAR, value);
    if (isIPv4(bare) || isIPv6(bare)) return bare;
    // All-numeric dotted names are malformed IPv4 literals, never hostnames.
    if (bare === raw && HOSTNAME_RE.test(bare) && !/^[\d.]+$/.test(bare)) return bare;
    return fail(ctx, HOST_GRAMMAR, value);
  })
  .meta({ [GRAMMAR_META_KEY]: HOST_GRAMMAR });

/**
 * The one shared loopback test (spec 08 §2.1): `localhost`, `127.0.0.0/8`, `::1`, `[::1]`.
 * `0.0.0.0` and `::` are **not** loopback.
 *
 * @returns `true` when binding `host` never leaves the machine.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare.toLowerCase() === 'localhost') return true;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  return isIPv4(bare) && bare.startsWith('127.');
}
