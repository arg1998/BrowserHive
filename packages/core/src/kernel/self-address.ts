/** @module kernel/self-address — what an address means for "is this BrowserHive itself?" (spec 13 §3.8): loopback by meaning (every `*.localhost`, all of 127/8, `::1`, IPv4-mapped and -compatible loopback, the unspecified addresses) and the canonical loopback names a browser can be given a cookie for. */

import { normalizeHost } from './url.ts';

/** Lowercased, brackets and a trailing dot removed (`LOCALHOST.` → `localhost`). */
export function canonicalHost(host: string): string {
  return normalizeHost(host).replace(/\.+$/, '');
}

/** The eight 16-bit groups of an IPv6 literal (embedded dotted IPv4 allowed), or `null`. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null;
  let text = host;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((o) => o > 255)) return null;
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * True when `host` reaches this machine's loopback or "any" address whatever its spelling:
 * `localhost` and every `*.localhost`, 127/8, `::1`, `0.0.0.0`, `::`, and IPv4-mapped or
 * -compatible forms of 127/8 (`::ffff:127.0.0.1`, `::ffff:7f00:1`, `::127.0.0.1`).
 */
export function isLoopbackByMeaning(host: string): boolean {
  const h = canonicalHost(host);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '0.0.0.0') return true;
  const groups = ipv6Groups(h);
  if (groups === null) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, last = 0] = groups;
  if (a || b || c || d || e) return false;
  if (f === 0 && g === 0) return last <= 1; // `::` and `::1`
  // IPv4-mapped (`::ffff:a.b.c.d`) or -compatible (`::a.b.c.d`): loopback when the v4 part is 127/8.
  return (f === 0xffff || f === 0) && g >> 8 === 127;
}

/**
 * The loopback spellings a browser cookie can be scoped to (`localhost`, `127.0.0.1`, `::1`). Every
 * other loopback alias (`foo.localhost`, `127.0.0.2`, `::ffff:127.0.0.1`) is refused by the
 * daemon's Host guard, so the template-host marker cookie covers every name the daemon answers.
 */
export function isCanonicalLoopback(host: string): boolean {
  const h = canonicalHost(host);
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * The cookie a template host carries for each of BrowserHive's own origins (spec 13 §3.8). The
 * daemon refuses every request that carries it: a template browser never gets the dashboard, the
 * API or a login page, also through a redirect hop the host's route cannot see.
 */
export const TEMPLATE_HOST_COOKIE = 'browserhive_template_host';
