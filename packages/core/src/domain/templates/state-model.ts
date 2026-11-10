/** @module domain/templates/state-model — pure rules over a template's in-memory state (spec 13 §2.4, §3.9): carry-forward of origins this browser process never visited, the 64 MiB cap, the structure hash, the per-domain summary (names only, D-20), the checkpoint's version reason, retention and "Last good". */

import { createHash } from 'node:crypto';
import { registrableDomain } from '../../kernel/url.ts';
import type {
  TemplateVersionDomainRecord,
  TemplateVersionHealthRecord,
  TemplateVersionReason,
  TemplateVersionRecord,
  TemplateVersionSummaryRecord,
} from '../../ports/persistence/index.ts';
import type { StateOrigin, TemplateState } from '../../ports/template-state.ts';

/** `TEMPLATE_STATE_MAX_BYTES` (spec 13 §3.9). */
export const TEMPLATE_STATE_MAX_BYTES = 64 * 1024 * 1024;

/** The cookie's host without a leading dot. */
function cookieHost(domain: string): string {
  return domain.replace(/^\./, '');
}

/** The registrable domain of a cookie (its host when it has none, e.g. `localhost`). */
export function cookieSite(domain: string): string {
  const host = cookieHost(domain).toLowerCase();
  return registrableDomain(host) || host;
}

/**
 * Carry-forward (spec 13 §3.9): Playwright's snapshot holds storage only for origins a frame of
 * this browser process visited. Every origin of `previous` that the snapshot lacks and the process
 * never visited (or cleared) is kept from `previous`: its storage cannot have changed meanwhile.
 */
export function carryForward(
  snapshot: TemplateState,
  previous: TemplateState | null,
  visited: ReadonlySet<string>,
): TemplateState {
  if (previous === null) return snapshot;
  const present = new Set(snapshot.origins.map((o) => o.origin));
  const carried = previous.origins.filter((o) => !present.has(o.origin) && !visited.has(o.origin));
  return carried.length === 0
    ? snapshot
    : { cookies: snapshot.cookies, origins: [...snapshot.origins, ...carried] };
}

/** Removes everything of a registrable domain (Remove sign-in) from a state. */
export function withoutDomain(state: TemplateState, domain: string): TemplateState {
  const originSite = (origin: string) => {
    try {
      return cookieSite(new URL(origin).hostname);
    } catch {
      return '';
    }
  };
  return {
    cookies: state.cookies.filter((c) => cookieSite(c.domain) !== domain),
    origins: state.origins.filter((o) => originSite(o.origin) !== domain),
  };
}

/** UTF-8 bytes of the JSON a state is written as. */
export function stateBytes(state: TemplateState): number {
  return Buffer.byteLength(JSON.stringify(state), 'utf8');
}

/** What {@link capState} did. */
export interface CappedState {
  readonly state: TemplateState;
  readonly sizeBytes: number;
  /** Origins whose IndexedDB data was left out, largest first. */
  readonly dropped: readonly string[];
}

/**
 * The 64 MiB cap (spec 13 §3.9): above it, IndexedDB data is dropped from the largest origins until
 * the state fits (cookies and localStorage are never dropped).
 */
export function capState(state: TemplateState, maxBytes = TEMPLATE_STATE_MAX_BYTES): CappedState {
  let size = stateBytes(state);
  if (size <= maxBytes) return { state, sizeBytes: size, dropped: [] };
  const weights = state.origins
    .map((o, index) => ({
      index,
      origin: o.origin,
      bytes: o.indexedDB === undefined ? 0 : Buffer.byteLength(JSON.stringify(o.indexedDB)),
    }))
    .filter((w) => w.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const drop = new Set<number>();
  const dropped: string[] = [];
  for (const w of weights) {
    if (size <= maxBytes) break;
    drop.add(w.index);
    dropped.push(w.origin);
    size -= w.bytes;
  }
  const origins: StateOrigin[] = state.origins.map((o, index) =>
    drop.has(index) ? { origin: o.origin, localStorage: o.localStorage } : o,
  );
  const capped = { cookies: state.cookies, origins };
  return { state: capped, sizeBytes: stateBytes(capped), dropped };
}

/** IndexedDB database names of an origin (Playwright writes `[{name, …}]`). */
function indexedDbNames(origin: StateOrigin): string[] {
  return (origin.indexedDB ?? []).flatMap((db) =>
    typeof db === 'object' && db !== null && typeof (db as { name?: unknown }).name === 'string'
      ? [(db as { name: string }).name]
      : [],
  );
}

/**
 * `structure_sha256` (spec 13 §3.9): SHA-256 over the sorted cookie (domain, name) pairs,
 * localStorage keys and IndexedDB database names; never a value, so rolling cookie values do not
 * change it.
 */
export function structureHash(state: TemplateState): string {
  const lines = new Set<string>();
  for (const c of state.cookies) lines.add(`c\t${cookieHost(c.domain).toLowerCase()}\t${c.name}`);
  for (const o of state.origins) {
    for (const item of o.localStorage) lines.add(`l\t${o.origin}\t${item.name}`);
    for (const name of indexedDbNames(o)) lines.add(`i\t${o.origin}\t${name}`);
  }
  return createHash('sha256')
    .update([...lines].sort().join('\n'), 'utf8')
    .digest('hex');
}

/** The sign-in cookie names of each site (learned names; a pack's `cookie_names` from T3a). */
export type SignInNames = ReadonlyMap<string, readonly string[]>;

/** The per-domain `summary` of a version (spec 13 §2.4): counts and cookie NAMES only (D-20). */
export function summarize(state: TemplateState, signIn: SignInNames): TemplateVersionSummaryRecord {
  const byDomain = new Map<
    string,
    { names: Set<string>; count: number; expiry: number | null; session: boolean }
  >();
  for (const c of state.cookies) {
    const domain = cookieSite(c.domain);
    const entry = byDomain.get(domain) ?? {
      names: new Set(),
      count: 0,
      expiry: null,
      session: false,
    };
    entry.names.add(c.name);
    entry.count += 1;
    if (c.expires > 0) {
      const ms = Math.round(c.expires * 1000);
      entry.expiry = entry.expiry === null ? ms : Math.min(entry.expiry, ms);
    } else {
      entry.session = true;
    }
    byDomain.set(domain, entry);
  }
  const domains: TemplateVersionDomainRecord[] = [...byDomain]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([domain, entry]) => ({
      domain,
      cookies: entry.count,
      signInCookies: (signIn.get(domain) ?? []).filter((n) => entry.names.has(n)).sort(),
      earliestExpiry: entry.expiry,
      sessionCookie: entry.session,
    }));
  const storageOrigins = state.origins.filter(
    (o) => o.localStorage.length > 0 || (o.indexedDB?.length ?? 0) > 0,
  ).length;
  return { domains, storageOrigins };
}

/** The present sign-in cookie names of `site` in a summary. */
function presentSignIn(summary: TemplateVersionSummaryRecord, site: string): string {
  return [...(summary.domains.find((d) => d.domain === site)?.signInCookies ?? [])]
    .sort()
    .join('\n');
}

/** Whether the set of present sign-in cookie names of any site differs (spec 13 §3.9 `signin_change`). */
export function signInChanged(
  current: TemplateVersionSummaryRecord,
  newest: TemplateVersionSummaryRecord,
  sites: readonly string[],
): boolean {
  return sites.some((site) => presentSignIn(current, site) !== presentSignIn(newest, site));
}

/** The local calendar day of `at` (`YYYY-MM-DD` in `timeZone`, the host's by default). */
export function localDay(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone !== undefined && { timeZone }),
  }).format(new Date(at));
}

/** What a checkpoint compares against. */
export interface CheckpointFacts {
  readonly now: number;
  /** The previous checkpoint's time (`templates.checkpoint_at`). */
  readonly previousCheckpointAt: number | null;
  readonly summary: TemplateVersionSummaryRecord;
  readonly structure: string;
  /** The newest version, or `null` before the first one. */
  readonly newest: Pick<TemplateVersionRecord, 'summary' | 'structureSha256'> | null;
  /** Sites whose sign-in cookie names are compared. */
  readonly sites: readonly string[];
  readonly timeZone?: string;
}

/**
 * The version a checkpoint also writes, if any (spec 13 §3.9): `signin_change` when the present
 * sign-in cookie names of a site differ from the newest version's; `daily` when this is the first
 * checkpoint of the (host local) day and the structure differs from the newest version's. A template
 * without a version writes none: its first version is the recording's, a seed's or a restore's.
 */
export function checkpointVersionReason(facts: CheckpointFacts): TemplateVersionReason | null {
  if (facts.newest === null) return null;
  if (signInChanged(facts.summary, facts.newest.summary, facts.sites)) return 'signin_change';
  const firstOfDay =
    facts.previousCheckpointAt === null ||
    localDay(facts.previousCheckpointAt, facts.timeZone) !== localDay(facts.now, facts.timeZone);
  if (firstOfDay && facts.structure !== facts.newest.structureSha256) return 'daily';
  return null;
}

/** True when every enabled site was `signed_in` (there is at least one enabled site). */
export function allSignedIn(health: readonly TemplateVersionHealthRecord[]): boolean {
  const enabled = health.filter((h) => h.enabled);
  return enabled.length > 0 && enabled.every((h) => h.state === 'signed_in');
}

/** The "Last good" version: the newest with every enabled site signed in (spec 13 §3.9). */
export function lastGood(versions: readonly TemplateVersionRecord[]): number | null {
  let best: number | null = null;
  for (const v of versions) {
    if (allSignedIn(v.health) && (best === null || v.version > best)) best = v.version;
  }
  return best;
}

/**
 * Retention (spec 13 §3.9): kept are the newest `keep` versions, every pinned version and "Last
 * good"; the returned versions are deleted with their files.
 */
export function prunableVersions(
  versions: readonly TemplateVersionRecord[],
  keep: number,
): readonly number[] {
  const newestFirst = [...versions].sort((a, b) => b.version - a.version);
  const good = lastGood(versions);
  return newestFirst
    .slice(Math.max(0, keep))
    .filter((v) => !v.pinned && v.version !== good)
    .map((v) => v.version);
}
