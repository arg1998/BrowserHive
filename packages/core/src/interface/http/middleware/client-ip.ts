/** @module interface/http/middleware/client-ip — client IP resolution with trusted-proxy CIDRs and loopback detection (spec 03 §2). */

import { isLoopbackHost } from '../../../kernel/url.ts';

/** A parsed CIDR block. */
interface Cidr {
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

/** Parses an IPv4 or IPv6 literal into 4 or 16 bytes; `null` when it is not an IP. */
export function ipToBytes(literal: string): Uint8Array | null {
  const text = literal.trim().replace(/^\[|\]$/g, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 !== null) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return Uint8Array.from(parts);
  }
  if (!text.includes(':')) return null;
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(text);
  if (mapped?.[1] !== undefined) return ipToBytes(mapped[1]);
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail =
    halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i];
    if (group === undefined || !/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out[i * 2] = value >> 8;
    out[i * 2 + 1] = value & 0xff;
  }
  return out;
}

/** Parses `10.0.0.0/8`, `::1/128` or a bare address (host route); `null` when malformed. */
export function parseCidr(text: string): Cidr | null {
  const [address, prefixText] = text.split('/');
  if (address === undefined) return null;
  const bytes = ipToBytes(address);
  if (bytes === null) return null;
  const max = bytes.length * 8;
  const prefix = prefixText === undefined ? max : Number.parseInt(prefixText, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

/** True when `ip` falls inside `cidr` (family must match). */
export function ipInCidr(ip: string, cidr: Cidr): boolean {
  const bytes = ipToBytes(ip);
  if (bytes === null || bytes.length !== cidr.bytes.length) return false;
  let remaining = cidr.prefix;
  for (let i = 0; i < bytes.length && remaining > 0; i += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    const a = bytes[i] ?? 0;
    const b = cidr.bytes[i] ?? 0;
    if ((a & mask) !== (b & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/** True when `ip` is a loopback address. */
export function isLoopbackIp(ip: string): boolean {
  return isLoopbackHost(ip.replace(/^\[|\]$/g, ''));
}

/** Resolves the effective client IP and TLS facts for one request. */
export interface ClientFacts {
  readonly ip: string;
  readonly loopback: boolean;
  readonly secure: boolean;
}

/** Builds a resolver bound to the configured trusted-proxy CIDRs. */
export function createClientResolver(trustedProxies: readonly string[]): {
  resolve(
    socketAddress: string | undefined,
    forwardedFor: string | undefined,
    forwardedProto: string | undefined,
  ): ClientFacts;
} {
  const cidrs = trustedProxies.flatMap((text) => {
    const parsed = parseCidr(text);
    return parsed === null ? [] : [parsed];
  });
  const trusted = (ip: string): boolean => cidrs.some((cidr) => ipInCidr(ip, cidr));
  return {
    resolve(socketAddress, forwardedFor, forwardedProto) {
      const peer = socketAddress ?? 'unknown';
      if (socketAddress === undefined || !trusted(socketAddress)) {
        return { ip: peer, loopback: isLoopbackIp(peer), secure: false };
      }
      // Right-most untrusted hop of X-Forwarded-For; the peer is a trusted proxy.
      const hops = (forwardedFor ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0);
      let ip = peer;
      for (let i = hops.length - 1; i >= 0; i -= 1) {
        const hop = hops[i];
        if (hop === undefined) continue;
        ip = hop;
        if (!trusted(hop)) break;
      }
      const secure = (forwardedProto ?? '').split(',')[0]?.trim().toLowerCase() === 'https';
      return { ip, loopback: isLoopbackIp(ip), secure };
    },
  };
}
