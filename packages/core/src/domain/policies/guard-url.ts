/** @module domain/policies/guard-url — the URL half of the request guard (spec 13 §9.3): a rule's glob compiled into linear-time matchers (the glob, its `/*` and query variants), and a request's comparison forms, raw and normalised the way servers read paths (review PR #83 H1, M2). */

import {
  type CompiledGlob,
  compileGlobTokens,
  globTokens,
  hasGlobWildcard,
  matchesCompiledGlob,
} from '../../kernel/glob.ts';
import { blocklistComparisonForms } from './blocklist.ts';

/** One compiled form of a rule's URL glob: plain equality when it has no wildcard. */
export type UrlMatcher =
  | { readonly kind: 'equals'; readonly value: string }
  | { readonly kind: 'glob'; readonly glob: CompiledGlob };

const UNRESERVED_ESCAPE = /%([0-9a-f]{2})/gi;
const UNRESERVED = /^[a-z0-9\-._~]$/i;

/** Decodes `%XX` escapes of unreserved characters (RFC 3986 §2.3), lowercased. */
export function decodeUnreserved(value: string): string {
  if (!value.includes('%')) return value;
  return value.replace(UNRESERVED_ESCAPE, (encoded, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char.toLowerCase() : encoded;
  });
}

/**
 * The glob, then (when it does not end in `*`) its `/*` variant and the variant followed by a
 * literal `?` and anything (the same path with any query string). Every matcher runs in linear
 * time per star (`kernel/glob`), so no pack glob can stall the route handler.
 */
export function matchersFor(pattern: string): readonly UrlMatcher[] {
  const compile = (glob: string): UrlMatcher =>
    hasGlobWildcard(glob)
      ? { kind: 'glob', glob: compileGlobTokens(globTokens(glob)) }
      : { kind: 'equals', value: glob };
  if (pattern.endsWith('*')) return [compile(pattern)];
  const query = compileGlobTokens([
    ...globTokens(pattern),
    { kind: 'char', char: '?' },
    { kind: 'star' },
  ]);
  return [compile(pattern), compile(`${pattern}/*`), { kind: 'glob', glob: query }];
}

/** True when `matcher` matches the comparison form `form`. */
export function matchesForm(matcher: UrlMatcher, form: string): boolean {
  return matcher.kind === 'equals'
    ? matcher.value === form
    : matchesCompiledGlob(matcher.glob, form);
}

/**
 * The path as a server is likely to read it: `%2F`/`%2E` decoded, `;params` dropped from every
 * segment, empty segments (`//`) collapsed, and `.`/`..` resolved again after the decoding.
 */
export function normalizeGuardPath(pathname: string): string {
  const decoded = pathname.replace(/%2f/gi, '/').replace(/%2e/gi, '.');
  const out: string[] = [];
  for (const raw of decoded.split('/')) {
    const segment = raw.split(';')[0] ?? '';
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

/**
 * Every form a rule is matched against, raw and normalised, deduplicated: `scheme://host[/path?q]`
 * and `host[/path?q]`, lowercased, unreserved escapes decoded; then the same with the host's
 * trailing dot dropped and the path normalised ({@link normalizeGuardPath}). Matching any of them
 * decides, so normalisation can only widen what a guard covers. `null` for a URL without a network
 * scheme or that does not parse.
 */
export function guardComparisonForms(rawUrl: string): readonly string[] | null {
  const raw = blocklistComparisonForms(rawUrl);
  if (raw === null) return null;
  const forms = new Set([decodeUnreserved(raw[0]), decodeUnreserved(raw[1])]);
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return [...forms];
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  const host = url.port === '' ? hostname : `${hostname}:${url.port}`;
  const path = normalizeGuardPath(url.pathname);
  const tail = path === '/' && url.search === '' ? '' : `${path}${url.search}`;
  const normal = decodeUnreserved(`${host}${tail}`.toLowerCase());
  forms.add(`${url.protocol.toLowerCase()}//${normal}`);
  forms.add(normal);
  return [...forms];
}
