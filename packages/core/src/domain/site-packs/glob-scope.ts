/** @module domain/site-packs/glob-scope — a pack URL glob's host must stay inside the pack's own domains (spec 13 §9.2 `UrlGlob`, §9.10): the registrable domain of its host part is literal and one of `domains`. */

import { registrableDomain } from '../../kernel/url.ts';

/** Where a glob points, when it is scoped. */
export interface ScopedGlob {
  /** The host part, lowercased (may hold wildcards left of the registrable domain). */
  readonly host: string;
  /** The literal registrable domain the host lies in. */
  readonly domain: string;
  /** The path part (`''` when the glob is a host only). */
  readonly path: string;
  /** The path is empty or only wildcards: the glob covers a whole host. */
  readonly wholeHost: boolean;
}

const HOST_CHARS = /^[a-z0-9.*?-]+$/;

/**
 * Splits a pack glob into host and path and checks its scope: no scheme, ASCII only, a host part
 * whose labels right of the last wildcard form a literal name whose registrable domain is in
 * `domains`. `*.linkedin.com/logout` is scoped to `linkedin.com`; `*linkedin.com`, `*.com`,
 * a host of only wildcards and `linked?n.com` are not. Returns the reason when refused.
 */
export function scopeOfGlob(
  glob: string,
  domains: readonly string[],
):
  | { readonly ok: true; readonly value: ScopedGlob }
  | { readonly ok: false; readonly reason: string } {
  const text = glob.trim().toLowerCase();
  if (text.includes('://') || /^[a-z][a-z0-9+.-]*:/.test(text)) {
    return { ok: false, reason: 'a glob has no scheme' };
  }
  if (!/^[\x21-\x7e]+$/.test(text)) {
    return { ok: false, reason: 'a glob is printable ASCII (punycode hosts)' };
  }
  const slash = text.indexOf('/');
  const host = slash < 0 ? text : text.slice(0, slash);
  const path = slash < 0 ? '' : text.slice(slash);
  if (host.length === 0 || !HOST_CHARS.test(host)) {
    return { ok: false, reason: 'the host part must be a host name' };
  }
  const labels = host.split('.');
  let lastWild = -1;
  for (const [i, label] of labels.entries()) {
    if (label.length === 0) return { ok: false, reason: 'empty host label' };
    if (label.includes('*') || label.includes('?')) lastWild = i;
  }
  const tail = labels.slice(lastWild + 1).join('.');
  const domain = tail.length === 0 ? '' : registrableDomain(tail);
  if (domain.length === 0 || !tail.endsWith(domain)) {
    return { ok: false, reason: "the host's registrable domain must be written out" };
  }
  if (!domains.includes(domain)) {
    return { ok: false, reason: `the host '${host}' is outside the pack's domains` };
  }
  return {
    ok: true,
    value: { host, domain, path, wholeHost: path.replaceAll('*', '').replaceAll('/', '') === '' },
  };
}

/** `https://<host><path>` of a scoped URL. */
export function scopedUrl(url: { readonly host: string; readonly path: string }): string {
  return `https://${url.host}${url.path}`;
}
