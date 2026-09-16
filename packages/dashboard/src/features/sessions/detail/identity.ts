/** @module features/sessions/detail/identity — parse the opaque applied identity (the camelCase shape recorded at launch) and derive the head chip + tense-aware fallback copy (spec 04 §12.3.4) */
import type { SessionSummary } from '@browserhive/contracts/http';
import { z } from 'zod';

const Dim = z.object({ width: z.number(), height: z.number() });

/** Applied identity as recorded at launch. */
export const ParsedIdentity = z.object({
  userAgent: z.string(),
  brands: z.array(z.object({ brand: z.string(), version: z.string() })).catch([]),
  platform: z.string().catch(''),
  chromeMajor: z.union([z.string(), z.number()]).transform(String).catch(''),
  geo: z
    .object({
      languages: z.array(z.string()).catch([]),
      timezoneId: z.string().catch(''),
      source: z.enum(['host', 'proxy']).catch('host'),
    })
    .nullable()
    .catch(null),
  display: z
    .object({ screen: Dim, viewport: Dim, deviceScaleFactor: z.number() })
    .nullable()
    .catch(null),
});
/** Applied identity. */
export type ParsedIdentity = z.infer<typeof ParsedIdentity>;

/** Parse; `null` when absent or unrecognisable. */
export function parseIdentity(raw: SessionSummary['identity']): ParsedIdentity | null {
  if (raw === null) return null;
  const parsed = ParsedIdentity.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Head state: `host-coherent` when an identity is present, else a dim chip. */
export function identityChip(
  session: SessionSummary,
  identity: ParsedIdentity | null,
): 'host-coherent' | 'not recorded' | 'no override' | 'stealth off' {
  if (identity !== null) return 'host-coherent';
  if (!session.stealth_recorded) return 'not recorded';
  return session.stealth ? 'no override' : 'stealth off';
}

/** The fallback paragraph when no identity is present (three sentences, tense-aware). */
export function identityFallback(session: SessionSummary): string {
  const past = !session.live;
  if (!session.stealth_recorded) {
    return `This session's stealth settings were not recorded, so what it presented cannot be shown.${
      past ? ' Sessions started from now on record it.' : ''
    }`;
  }
  if (session.stealth) {
    const v = past ? 'was' : 'is';
    return `Stealth ${v} on, but no identity override ${v} applied — the browser's own baseline ${v} in use.`;
  }
  return `This session ${past ? 'ran' : 'runs'} without stealth and ${
    past ? 'presented' : 'presents'
  } the browser's native identity.`;
}

/** Provenance footer under a present identity. */
export function identityProvenance(session: SessionSummary, identity: ParsedIdentity): string {
  return identity.geo === null && session.fingerprint
    ? 'No locale or timezone was asserted: this session uses a caller-supplied proxy, and a host-derived identity over a foreign exit IP would be less believable than asserting nothing.'
    : "The locale and timezone above are this machine's own, matching the IP the traffic leaves from.";
}

/** One-line summary for the metadata rail. */
export function identitySummary(session: SessionSummary, identity: ParsedIdentity | null): string {
  if (identity === null) return identityChip(session, identity);
  const parts = [identity.platform, `Chrome ${identity.chromeMajor}`];
  if (identity.geo !== null) parts.push(identity.geo.timezoneId);
  if (identity.display !== null) {
    parts.push(`${identity.display.viewport.width}×${identity.display.viewport.height}`);
  }
  return parts.filter((p) => p.length > 0).join(' · ');
}
