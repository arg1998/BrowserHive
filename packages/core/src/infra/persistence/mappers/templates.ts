/** @module infra/persistence/mappers/templates — `templates` / `template_sites` rows ↔ records. JSON columns hold the snake_case wire shapes of spec 13 §2. */

import type { Insertable, Selectable } from 'kysely';
import { z } from 'zod';
import { AppError } from '../../../kernel/errors/app-error.ts';
import {
  AGENT_WINDOW_STATES,
  SESSION_CHANNELS,
  TEMPLATE_STATUSES,
  TEMPLATE_STEALTH_LEVELS,
} from '../../../ports/persistence/enums.ts';
import type {
  ObservedIdentityRecord,
  PinnedIdentityRecord,
  TemplatePatch,
  TemplateProxyRecord,
  TemplateRecord,
  TemplateUnsealRecord,
} from '../../../ports/persistence/records-templates.ts';
import type { Templates } from '../generated/db.d.ts';
import {
  boolToInt,
  intToBool,
  parseEnum,
  parseJsonValue,
  parseStringArray,
  toJson,
} from './codec.ts';

const geolocationJson = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number().optional(),
});

const identityJson = z.object({
  seed: z.string(),
  locale: z.string(),
  languages: z.array(z.string()),
  timezone_id: z.string(),
  country_code: z.string().nullable(),
  geolocation: geolocationJson.optional(),
});

const brandJson = z.object({ brand: z.string(), version: z.string() });

const observedJson = z.object({
  chrome_major: z.string(),
  user_agent: z.string(),
  ua_ch: z.object({
    brands: z.array(brandJson),
    full_version_list: z.array(brandJson),
    platform: z.string(),
    platform_version: z.string(),
    architecture: z.string(),
    bitness: z.string(),
  }),
  screen: z.object({ width: z.number(), height: z.number(), device_scale_factor: z.number() }),
  window: z.object({ width: z.number(), height: z.number() }),
  observed_at: z.number(),
});

const proxyJson = z.object({
  server: z.string(),
  bypass: z.string().nullable(),
  username: z.string().nullable(),
  password_env: z.string().nullable(),
  label: z.string(),
});

/** `unseal_json`; the column default `'{}'` reads as every flag sealed. */
const unsealJson = z.object({
  cookie_values: z.boolean().default(false),
  evaluate: z.boolean().default(false),
  cookie_writes: z.boolean().default(false),
  state_export: z.boolean().default(false),
  principals: z.array(z.string()).optional(),
});

/** Parses a JSON column against its shape; `INTERNAL_ERROR` (`row-codec`) when it does not match. */
export function parseWith<T extends z.ZodType>(
  schema: T,
  text: string,
  where: string,
): z.output<T> {
  const parsed = schema.safeParse(parseJsonValue(text, where));
  if (!parsed.success) {
    throw new AppError(
      'INTERNAL_ERROR',
      { ref: 'row-codec' },
      { message: `${where}: json does not match its shape` },
    );
  }
  return parsed.data;
}

function identityFromJson(text: string, where: string): PinnedIdentityRecord {
  const j = parseWith(identityJson, text, `${where}.identity_json`);
  return {
    seed: j.seed,
    locale: j.locale,
    languages: j.languages,
    timezoneId: j.timezone_id,
    countryCode: j.country_code,
    ...(j.geolocation !== undefined && {
      geolocation: {
        latitude: j.geolocation.latitude,
        longitude: j.geolocation.longitude,
        ...(j.geolocation.accuracy !== undefined && { accuracy: j.geolocation.accuracy }),
      },
    }),
  };
}

function identityToJson(identity: PinnedIdentityRecord): string {
  return toJson({
    seed: identity.seed,
    locale: identity.locale,
    languages: identity.languages,
    timezone_id: identity.timezoneId,
    country_code: identity.countryCode,
    ...(identity.geolocation !== undefined && { geolocation: identity.geolocation }),
  });
}

function observedFromJson(text: string | null, where: string): ObservedIdentityRecord | null {
  if (text === null) return null;
  const j = parseWith(observedJson, text, `${where}.identity_observed_json`);
  return {
    chromeMajor: j.chrome_major,
    userAgent: j.user_agent,
    uaCh: {
      brands: j.ua_ch.brands,
      fullVersionList: j.ua_ch.full_version_list,
      platform: j.ua_ch.platform,
      platformVersion: j.ua_ch.platform_version,
      architecture: j.ua_ch.architecture,
      bitness: j.ua_ch.bitness,
    },
    screen: {
      width: j.screen.width,
      height: j.screen.height,
      deviceScaleFactor: j.screen.device_scale_factor,
    },
    window: j.window,
    observedAt: j.observed_at,
  };
}

function observedToJson(observed: ObservedIdentityRecord | null): string | null {
  if (observed === null) return null;
  return toJson({
    chrome_major: observed.chromeMajor,
    user_agent: observed.userAgent,
    ua_ch: {
      brands: observed.uaCh.brands,
      full_version_list: observed.uaCh.fullVersionList,
      platform: observed.uaCh.platform,
      platform_version: observed.uaCh.platformVersion,
      architecture: observed.uaCh.architecture,
      bitness: observed.uaCh.bitness,
    },
    screen: {
      width: observed.screen.width,
      height: observed.screen.height,
      device_scale_factor: observed.screen.deviceScaleFactor,
    },
    window: observed.window,
    observed_at: observed.observedAt,
  });
}

function proxyFromJson(text: string | null, where: string): TemplateProxyRecord | null {
  if (text === null) return null;
  const j = parseWith(proxyJson, text, `${where}.proxy_json`);
  return {
    server: j.server,
    bypass: j.bypass,
    username: j.username,
    passwordEnv: j.password_env,
    label: j.label,
  };
}

function proxyToJson(proxy: TemplateProxyRecord | null): string | null {
  if (proxy === null) return null;
  return toJson({
    server: proxy.server,
    bypass: proxy.bypass,
    username: proxy.username,
    password_env: proxy.passwordEnv,
    label: proxy.label,
  });
}

function unsealFromJson(text: string, where: string): TemplateUnsealRecord {
  const j = parseWith(unsealJson, text, `${where}.unseal_json`);
  return {
    cookieValues: j.cookie_values,
    evaluate: j.evaluate,
    cookieWrites: j.cookie_writes,
    stateExport: j.state_export,
    principals: j.principals ?? null,
  };
}

function unsealToJson(unseal: TemplateUnsealRecord): string {
  return toJson({
    cookie_values: unseal.cookieValues,
    evaluate: unseal.evaluate,
    cookie_writes: unseal.cookieWrites,
    state_export: unseal.stateExport,
    ...(unseal.principals !== null && { principals: unseal.principals }),
  });
}

function harnessesFromJson(text: string | null, where: string): readonly string[] | null {
  return text === null ? null : parseStringArray(text, `${where}.harnesses_json`);
}

function harnessesToJson(list: readonly string[] | null): string | null {
  return list === null ? null : toJson(list);
}

/** `templates` row → record (total: throws `INTERNAL_ERROR` on a corrupt row). */
export function templateFromRow(row: Selectable<Templates>): TemplateRecord {
  const where = `templates.${row.template_id}`;
  return {
    templateId: row.template_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    status: parseEnum(TEMPLATE_STATUSES, row.status, where),
    owner: row.owner,
    tenantId: row.tenant_id,
    channel: parseEnum(SESSION_CHANNELS, row.channel, where),
    headless: intToBool(row.headless),
    stealth: parseEnum(TEMPLATE_STEALTH_LEVELS, row.stealth, where),
    fingerprint: intToBool(row.fingerprint),
    humanize: intToBool(row.humanize),
    identity: identityFromJson(row.identity_json, where),
    identityObserved: observedFromJson(row.identity_observed_json, where),
    proxy: proxyFromJson(row.proxy_json, where),
    agentWindows: parseEnum(AGENT_WINDOW_STATES, row.agent_windows, where),
    authorizedPrincipals: parseStringArray(row.authorized_principals_json, where),
    harnesses: harnessesFromJson(row.harnesses_json, where),
    maxConcurrent: row.max_concurrent,
    unseal: unsealFromJson(row.unseal_json, where),
    healthIntervalMs: row.health_interval_ms,
    prelaunchCheck: intToBool(row.prelaunch_check),
    currentVersion: row.current_version,
    checkpointAt: row.checkpoint_at,
    checkpointSizeBytes: row.checkpoint_size_bytes,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    disabledAt: row.disabled_at,
  };
}

/** Record → `templates` insert row. */
export function templateToRow(record: TemplateRecord): Insertable<Templates> {
  return {
    template_id: record.templateId,
    name: record.name,
    display_name: record.displayName,
    description: record.description,
    status: record.status,
    owner: record.owner,
    tenant_id: record.tenantId,
    channel: record.channel,
    headless: boolToInt(record.headless),
    stealth: record.stealth,
    fingerprint: boolToInt(record.fingerprint),
    humanize: boolToInt(record.humanize),
    identity_json: identityToJson(record.identity),
    identity_observed_json: observedToJson(record.identityObserved),
    proxy_json: proxyToJson(record.proxy),
    agent_windows: record.agentWindows,
    authorized_principals_json: toJson(record.authorizedPrincipals),
    harnesses_json: harnessesToJson(record.harnesses),
    max_concurrent: record.maxConcurrent,
    unseal_json: unsealToJson(record.unseal),
    health_interval_ms: record.healthIntervalMs,
    prelaunch_check: boolToInt(record.prelaunchCheck),
    current_version: record.currentVersion,
    checkpoint_at: record.checkpointAt,
    checkpoint_size_bytes: record.checkpointSizeBytes,
    version: record.version,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    last_used_at: record.lastUsedAt,
    disabled_at: record.disabledAt,
  };
}

/** Patch → `templates` update columns (only present keys). */
export function templatePatchToRow(patch: TemplatePatch): Partial<Insertable<Templates>> {
  return {
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.displayName !== undefined && { display_name: patch.displayName }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.channel !== undefined && { channel: patch.channel }),
    ...(patch.headless !== undefined && { headless: boolToInt(patch.headless) }),
    ...(patch.stealth !== undefined && { stealth: patch.stealth }),
    ...(patch.fingerprint !== undefined && { fingerprint: boolToInt(patch.fingerprint) }),
    ...(patch.humanize !== undefined && { humanize: boolToInt(patch.humanize) }),
    ...(patch.identity !== undefined && { identity_json: identityToJson(patch.identity) }),
    ...(patch.identityObserved !== undefined && {
      identity_observed_json: observedToJson(patch.identityObserved),
    }),
    ...(patch.proxy !== undefined && { proxy_json: proxyToJson(patch.proxy) }),
    ...(patch.agentWindows !== undefined && { agent_windows: patch.agentWindows }),
    ...(patch.authorizedPrincipals !== undefined && {
      authorized_principals_json: toJson(patch.authorizedPrincipals),
    }),
    ...(patch.harnesses !== undefined && { harnesses_json: harnessesToJson(patch.harnesses) }),
    ...(patch.maxConcurrent !== undefined && { max_concurrent: patch.maxConcurrent }),
    ...(patch.unseal !== undefined && { unseal_json: unsealToJson(patch.unseal) }),
    ...(patch.healthIntervalMs !== undefined && { health_interval_ms: patch.healthIntervalMs }),
    ...(patch.prelaunchCheck !== undefined && {
      prelaunch_check: boolToInt(patch.prelaunchCheck),
    }),
    ...(patch.currentVersion !== undefined && { current_version: patch.currentVersion }),
    ...(patch.checkpointAt !== undefined && { checkpoint_at: patch.checkpointAt }),
    ...(patch.checkpointSizeBytes !== undefined && {
      checkpoint_size_bytes: patch.checkpointSizeBytes,
    }),
    ...(patch.updatedAt !== undefined && { updated_at: patch.updatedAt }),
    ...(patch.lastUsedAt !== undefined && { last_used_at: patch.lastUsedAt }),
    ...(patch.disabledAt !== undefined && { disabled_at: patch.disabledAt }),
  };
}
