/** @module contracts/tools/lifecycle — launch_session, close_session, list_sessions contracts */
import { z } from 'zod';
import { Channel } from '../enums/channel.ts';
import { PersistenceMode } from '../enums/persistence-mode.ts';
import { SessionMetadata } from './session-metadata.ts';
import { annotations, SINCE } from './shared.ts';
import { TEMPLATE_NAME_RE } from './templates.ts';
import { defineTool } from './types.ts';

/** Slug rule: starts lowercase, 2–32 chars, lowercase alphanumerics + dash. */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Playwright `LaunchOptions` pass-through. Unknown keys are forwarded verbatim for forward-compat;
 * `args[]` entries are checked against the deny-list (`UNSAFE_LAUNCH_ARG`) before any browser spawns.
 */
export const LaunchOptions = z.looseObject({
  args: z.array(z.string()).optional(),
  executablePath: z.string().optional(),
});

/**
 * Playwright `BrowserContextOptions` pass-through. A **string** `storageState` is treated as a
 * saved storage-state name and resolved to the managed file; anything else passes through verbatim.
 */
export const BrowserContextOptions = z.looseObject({});

/** Server-derived defaults that `launch_session` advertises (spec 02 §4: `defaultChannel`/`defaultHeadless`). */
export interface LaunchSessionDefaults {
  readonly channel: Channel;
  readonly headless: boolean;
}

/** Static defaults (the `defaultChannel`/`defaultHeadless` config defaults), used when no server config is available (goldens, docs). */
export const BASE_LAUNCH_DEFAULTS: LaunchSessionDefaults = {
  channel: 'chromium',
  headless: true,
};

/** Description of `launch_session.template` (spec 13 §5.2; wording rule of §5). */
export const TEMPLATE_PARAM_DESCRIPTION =
  "Name of a session template from list_templates. The session starts signed in to the template's " +
  'sites; sign-ins and site data it changes are kept in the template.';

/**
 * The `context_options` keys a template session applies per session (spec 13 §4, §5.3); any other key
 * is refused on a template launch, whatever its value.
 */
export const PER_SESSION_TEMPLATE_CONTEXT_OPTIONS = [
  'viewport',
  'extraHTTPHeaders',
  'colorScheme',
] as const;

/**
 * Build the `launch_session` input schema with the server's effective defaults baked in, so
 * `tools/list` shows the real `channel`/`headless` defaults rather than hardcoded ones.
 */
export function launchSessionInput(defaults: LaunchSessionDefaults = BASE_LAUNCH_DEFAULTS) {
  return z.object({
    slug: z.string().regex(SLUG_RE, 'slug must match /^[a-z][a-z0-9-]{1,31}$/'),
    channel: Channel.default(defaults.channel),
    incognito: z.boolean().default(false),
    headless: z.boolean().default(defaults.headless),
    persistence_mode: PersistenceMode.optional(),
    restore_profile: z.string().optional(),
    launch_options: LaunchOptions.optional(),
    context_options: BrowserContextOptions.optional(),
    disable_evaluate: z.boolean().default(false),
    vault_enabled: z.boolean().default(true),
    stealth: z.boolean().optional(),
    fingerprint: z.boolean().optional(),
    humanize: z.boolean().optional(),
    template: z
      .string()
      .regex(TEMPLATE_NAME_RE, 'template must match /^[a-z][a-z0-9-]{1,31}$/')
      .optional()
      .describe(TEMPLATE_PARAM_DESCRIPTION),
  });
}

/** Agent-facing description of `launch_session` (spec 13 §5.2). */
export const LAUNCH_SESSION_DESCRIPTION =
  'Launch a new browser session. Without `template`, the session is fully isolated: it owns its own ' +
  'Playwright driver, browser, context and page, and its cookies and storage are its own. With ' +
  "`template`, the session starts signed in to the template's sites (see list_templates). The " +
  "resolved session_id is '<slug>-<nanoid8>' and is returned as the 'session_id' field.";

/** `launch_session`: one isolated browser session per call. */
export const LAUNCH_SESSION = defineTool({
  name: 'launch_session',
  title: 'Launch session',
  description: LAUNCH_SESSION_DESCRIPTION,
  input: launchSessionInput(),
  output: SessionMetadata,
  annotations: annotations(false, false, false, true),
  pack: 'lifecycle',
  capability: 'lifecycle',
  errors: [
    'INVALID_SLUG',
    'UNKNOWN_CHANNEL',
    'SESSION_LIMIT_REACHED',
    'SESSION_ALREADY_EXISTS',
    'UNSAFE_LAUNCH_ARG',
    'INVALID_PERSISTENCE_CONFIG',
    'AUTH_STATE_NOT_FOUND',
    'BROWSER_NOT_INSTALLED',
    'SANDBOX_UNAVAILABLE',
    'TEMPLATE_NOT_FOUND',
    'TEMPLATE_BUSY',
    'TEMPLATE_UNAVAILABLE',
    'TEMPLATE_DISABLED',
  ],
  since: SINCE,
});

/** `close_session`: unknown (or foreign) ids answer `closed: false`, never an error. */
export const CLOSE_SESSION = defineTool({
  name: 'close_session',
  title: 'Close session',
  description: 'Close an existing browser session and release all its resources.',
  input: z.object({ session_id: z.string() }),
  output: z.object({ session_id: z.string(), closed: z.boolean() }),
  annotations: annotations(false, true, true, false),
  pack: 'lifecycle',
  capability: 'lifecycle',
  errors: [],
  since: SINCE,
});

/** `list_sessions`: takes no arguments, so no `inputSchema`; only the caller's sessions. */
export const LIST_SESSIONS = defineTool({
  name: 'list_sessions',
  title: 'List sessions',
  description: 'Return metadata for every live session.',
  output: z.array(SessionMetadata),
  annotations: annotations(true, false, true, false),
  pack: 'lifecycle',
  capability: 'lifecycle',
  errors: [],
  since: SINCE,
});
