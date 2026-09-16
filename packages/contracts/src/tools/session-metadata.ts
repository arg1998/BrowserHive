/** @module contracts/tools/session-metadata — SessionMetadata and AppliedIdentity result shapes */
import { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { PersistenceMode } from '../enums/persistence-mode.ts';

/** UA-CH brand entry (`{ brand, version }`). Keys are camelCase on the wire (frozen by D-12). */
export const Brand = z.object({ brand: z.string(), version: z.string() });

/** The geo half of a presented identity, or `null` when the geo layer stood down. */
export const AppliedGeo = z.object({
  locale: z.string(),
  languages: z.array(z.string()),
  countryCode: z.string().nullable(),
  timezoneId: z.string(),
  source: z.enum(['host', 'proxy']),
});

/** The display half of a presented identity, or `null` when fingerprint injection is off. */
export const AppliedDisplay = z.object({
  screen: z.object({ width: z.number(), height: z.number() }),
  viewport: z.object({ width: z.number(), height: z.number() }),
  deviceScaleFactor: z.number(),
});

/**
 * The host-coherent identity applied at launch, surfaced on session metadata. Key names are
 * camelCase (they mirror the browser-side identity fields); frozen by D-12.
 */
export const AppliedIdentity = z.object({
  userAgent: z.string(),
  brands: z.array(Brand),
  platform: z.string(),
  deviceMemory: z.number(),
  chromeMajor: z.string(),
  geo: AppliedGeo.nullable(),
  display: AppliedDisplay.nullable(),
});
/** Parsed {@link AppliedIdentity}. */
export type AppliedIdentity = z.infer<typeof AppliedIdentity>;

/**
 * Session metadata as returned by `launch_session` and `list_sessions`. `proxy_label` is the one
 * additive key (D-13); everything else is the frozen base shape (D-12).
 */
export const SessionMetadata = z.object({
  session_id: z.string(),
  slug: z.string(),
  channel: Channel,
  incognito: z.boolean(),
  headless: z.boolean(),
  persistence_mode: PersistenceMode,
  current_url: z.string().nullable(),
  created_at: z.number(),
  owner: z.string(),
  lease_expires_at: z.number(),
  lease_paused_at: z.number().nullable(),
  disable_evaluate: z.boolean(),
  vault_enabled: z.boolean(),
  stealth: z.boolean(),
  fingerprint: z.boolean(),
  humanize: z.boolean(),
  identity: AppliedIdentity.nullable(),
  proxy_label: z.string().nullable(),
});
/** Parsed {@link SessionMetadata}. */
export type SessionMetadata = z.infer<typeof SessionMetadata>;
