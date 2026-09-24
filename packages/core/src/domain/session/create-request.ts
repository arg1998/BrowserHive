/** @module domain/session/create-request — validated CreateSessionRequest from launch_session args + server defaults (spec 02 §3.1). */

import { Channel, PersistenceMode, type StealthLevel } from '@browserhive/contracts/enums';
import { AppError } from '../../kernel/errors/app-error.ts';
import { assertValidSlug } from '../../kernel/slug.ts';
import {
  hasUserDataDir,
  type ParsedContextOptions,
  type ParsedLaunchOptions,
  parseContextOptions,
  parseLaunchOptions,
  storageStateName,
} from '../policies/launch-options.ts';
import type { SessionClientInfo } from './client-info.ts';
import type { SessionPrincipal } from './principal.ts';

/** Server defaults a request inherits (from `ServerConfig`; see `sessionDefaultsFromConfig`). */
export interface SessionDefaults {
  readonly headless: boolean;
  readonly channel: Channel;
  readonly persistence: PersistenceMode;
  readonly stealth: boolean;
  readonly fingerprint: boolean;
  readonly humanize: boolean;
}

/** Derives {@link SessionDefaults} from the resolved config keys. */
export function sessionDefaultsFromConfig(config: {
  readonly defaultHeadless: boolean;
  readonly defaultChannel: Channel;
  readonly persistence: PersistenceMode;
  readonly stealth: StealthLevel;
  readonly fingerprint: boolean;
  readonly humanize: boolean;
}): SessionDefaults {
  return {
    headless: config.defaultHeadless,
    channel: config.defaultChannel,
    persistence: config.persistence,
    stealth: config.stealth !== 'off',
    fingerprint: config.fingerprint,
    humanize: config.humanize,
  };
}

/** `launch_session` arguments in camelCase; every key but `slug` is optional (defaults apply). */
export interface CreateSessionInput {
  readonly slug: string;
  readonly channel?: string;
  readonly incognito?: boolean;
  readonly headless?: boolean;
  readonly persistenceMode?: string;
  readonly restoreProfile?: string;
  readonly launchOptions?: unknown;
  readonly contextOptions?: unknown;
  readonly disableEvaluate?: boolean;
  readonly vaultEnabled?: boolean;
  readonly stealth?: boolean;
  readonly fingerprint?: boolean;
  readonly humanize?: boolean;
  /** MCP connection that launched the session, for `sessions.connection_id`. */
  readonly connectionId?: string | null;
  /** What that connection's client said about itself (dashboard only). */
  readonly client?: SessionClientInfo | null;
}

/** The wire form of `launch_session` args (snake_case, defaults already applied by the tool schema). */
export interface LaunchSessionWireArgs {
  readonly slug: string;
  readonly channel?: string;
  readonly incognito?: boolean;
  readonly headless?: boolean;
  readonly persistence_mode?: string;
  readonly restore_profile?: string;
  readonly launch_options?: unknown;
  readonly context_options?: unknown;
  readonly disable_evaluate?: boolean;
  readonly vault_enabled?: boolean;
  readonly stealth?: boolean;
  readonly fingerprint?: boolean;
  readonly humanize?: boolean;
}

/** Maps the tool's snake_case args to {@link CreateSessionInput}. */
export function createSessionInputFromWire(
  args: LaunchSessionWireArgs,
  connectionId: string | null = null,
  client: SessionClientInfo | null = null,
): CreateSessionInput {
  return {
    slug: args.slug,
    ...(args.channel !== undefined && { channel: args.channel }),
    ...(args.incognito !== undefined && { incognito: args.incognito }),
    ...(args.headless !== undefined && { headless: args.headless }),
    ...(args.persistence_mode !== undefined && { persistenceMode: args.persistence_mode }),
    ...(args.restore_profile !== undefined && { restoreProfile: args.restore_profile }),
    ...(args.launch_options !== undefined && { launchOptions: args.launch_options }),
    ...(args.context_options !== undefined && { contextOptions: args.context_options }),
    ...(args.disable_evaluate !== undefined && { disableEvaluate: args.disable_evaluate }),
    ...(args.vault_enabled !== undefined && { vaultEnabled: args.vault_enabled }),
    ...(args.stealth !== undefined && { stealth: args.stealth }),
    ...(args.fingerprint !== undefined && { fingerprint: args.fingerprint }),
    ...(args.humanize !== undefined && { humanize: args.humanize }),
    connectionId,
    client,
  };
}

/** A fully resolved, validated request the creation pipeline runs on. */
export interface CreateSessionRequest {
  readonly slug: string;
  readonly channel: Channel;
  readonly incognito: boolean;
  readonly headless: boolean;
  readonly persistenceMode: PersistenceMode;
  readonly restoreProfile: string | null;
  /** Saved storage-state name to resolve to the managed file (string `storageState`). */
  readonly storageStateName: string | null;
  readonly launchOptions: ParsedLaunchOptions | undefined;
  readonly contextOptions: ParsedContextOptions | undefined;
  readonly disableEvaluate: boolean;
  readonly vaultEnabled: boolean;
  readonly stealth: boolean;
  readonly fingerprint: boolean;
  readonly humanize: boolean;
  readonly owner: string;
  readonly tenantId: string | null;
  readonly connectionId: string | null;
  /** Self-reported client of that connection, fixed at creation (dashboard only). */
  readonly client: SessionClientInfo | null;
}

function invalidPersistence(reason: string): AppError<'INVALID_PERSISTENCE_CONFIG'> {
  return new AppError(
    'INVALID_PERSISTENCE_CONFIG',
    { reason },
    { publicMessage: `Invalid persistence config: ${reason}` },
  );
}

function resolveChannel(value: string | undefined, fallback: Channel): Channel {
  if (value === undefined) return fallback;
  const parsed = Channel.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(
    'UNKNOWN_CHANNEL',
    { channel: value, supported: [...Channel.options] },
    {
      publicMessage: `Unknown browser channel '${value}'. Expected one of: chromium, chrome, edge.`,
    },
  );
}

function resolvePersistence(value: string | undefined, fallback: PersistenceMode): PersistenceMode {
  if (value === undefined) return fallback;
  const parsed = PersistenceMode.safeParse(value);
  if (parsed.success) return parsed.data;
  throw invalidPersistence(
    `unknown persistence mode '${value}'; expected one of memory, persistent, storage-state`,
  );
}

/**
 * Validate and resolve a `launch_session` request against the server defaults — all of it before
 * the lock and before any I/O, so a bad launch has zero side effects.
 *
 * Rules (each error carries its stable public message):
 * - slug grammar → `INVALID_SLUG`; channel → `UNKNOWN_CHANNEL`; deny-listed args / unsafe fields → `UNSAFE_LAUNCH_ARG`;
 * - persistent + `userDataDir`, persistent + string `storageState`, non-persistent + `restore_profile`,
 *   persistent + `incognito` → `INVALID_PERSISTENCE_CONFIG`;
 * - `stealth ?? default`; `fingerprint = stealth && (req ?? default)`; `humanize = stealth && (req ?? default)`.
 */
export function validateCreateRequest(
  input: CreateSessionInput,
  defaults: SessionDefaults,
  principal: SessionPrincipal,
): CreateSessionRequest {
  assertValidSlug(input.slug);
  const channel = resolveChannel(input.channel, defaults.channel);
  const persistenceMode = resolvePersistence(input.persistenceMode, defaults.persistence);
  // Reject deny-listed launch args before acquiring the lock or spawning anything.
  const launchOptions = parseLaunchOptions(input.launchOptions);
  const contextOptions = parseContextOptions(input.contextOptions);
  // In persistent mode the userDataDir is always the managed path; a user-supplied one collides.
  if (persistenceMode === 'persistent' && hasUserDataDir(launchOptions)) {
    throw invalidPersistence(
      'userDataDir cannot be supplied in persistent mode; the managed profile path is used',
    );
  }
  const stateName = storageStateName(contextOptions);
  if (stateName !== undefined && persistenceMode === 'persistent') {
    throw invalidPersistence('restoring storage state requires a non-persistent mode');
  }
  if (input.restoreProfile !== undefined && persistenceMode !== 'persistent') {
    throw invalidPersistence('restoring a profile requires persistent mode');
  }
  const incognito = input.incognito ?? false;
  // `incognito` means "no on-disk profile", which directly contradicts persistent mode (which
  // exists to write one). Reject the conflicting combo rather than silently persisting to disk
  // while reporting incognito:true.
  if (incognito && persistenceMode === 'persistent') {
    throw invalidPersistence(
      'incognito is incompatible with persistent mode, which writes a profile to disk; use ' +
        'memory or storage-state mode for an ephemeral session',
    );
  }
  const stealth = input.stealth ?? defaults.stealth;
  // Fingerprint injection and humanization are stealth *mechanisms*: with stealth off there is no
  // coherent identity for them to belong to, so they collapse to off rather than half-applying.
  const fingerprint = stealth && (input.fingerprint ?? defaults.fingerprint);
  const humanize = stealth && (input.humanize ?? defaults.humanize);
  return {
    slug: input.slug,
    channel,
    incognito,
    headless: input.headless ?? defaults.headless,
    persistenceMode,
    restoreProfile: input.restoreProfile ?? null,
    storageStateName: stateName ?? null,
    launchOptions,
    contextOptions,
    disableEvaluate: input.disableEvaluate ?? false,
    vaultEnabled: input.vaultEnabled ?? true,
    stealth,
    fingerprint,
    humanize,
    owner: principal.subject,
    tenantId: principal.tenantId ?? null,
    connectionId: input.connectionId ?? null,
    client: input.client ?? null,
  };
}
