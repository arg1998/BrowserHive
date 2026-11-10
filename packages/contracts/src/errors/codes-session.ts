/** @module contracts/errors/codes-session — session lifecycle, launch-config and tab error codes (message texts are part of the public contract) */
import { z } from 'zod';
import { defineError } from './spec.ts';

const sessionId = z.object({ session_id: z.string() });

/** Session lifecycle, launch configuration and tab codes. */
export const SESSION_ERRORS = {
  SESSION_NOT_FOUND: defineError({
    code: 'SESSION_NOT_FOUND',
    httpStatus: 404,
    category: 'domain',
    retryable: 'different_args',
    title: 'Session not found',
    message: "No browser session with id '{session_id}'",
    hint: 'Use list_sessions to see live sessions.',
    details: sessionId,
    docs: true,
    cause: 'The session id is unknown, mistyped, or the session was already closed and removed.',
    resolution: 'Call list_sessions and use one of the returned ids, or launch a new session.',
  }),
  SESSION_ALREADY_EXISTS: defineError({
    code: 'SESSION_ALREADY_EXISTS',
    httpStatus: 409,
    category: 'domain',
    retryable: 'immediate',
    title: 'Session id collision',
    message:
      "Session '{session_id}' already exists. Slug+nanoid collision is exceptionally rare; the caller should retry.",
    hint: 'Retry launch_session; a fresh id is generated on every call.',
    details: sessionId,
    docs: true,
    cause: 'The generated `<slug>-<nanoid8>` id collided with a live session (36^8 space).',
    resolution: 'Retry immediately; a collision twice in a row indicates a broken id generator.',
  }),
  SESSION_DEAD: defineError({
    code: 'SESSION_DEAD',
    httpStatus: 410,
    category: 'domain',
    retryable: 'different_args',
    title: 'Session is dead',
    message: "Session '{session_id}' is dead — its underlying browser process crashed.",
    hint: 'Close the session and launch a new one.',
    details: sessionId,
    docs: true,
    cause: 'The browser context or process disconnected; the session is awaiting reaping.',
    resolution: 'Launch a replacement session; the crashed one is closed with reason `crash`.',
  }),
  SESSION_LIMIT_REACHED: defineError({
    code: 'SESSION_LIMIT_REACHED',
    httpStatus: 429,
    category: 'domain',
    retryable: 'backoff',
    title: 'Session limit reached',
    message: 'Concurrent session limit reached (max={limit}). Close a session and retry.',
    hint: 'Close an idle session or wait for a lease to expire, then retry.',
    details: z.object({ limit: z.number().int(), live: z.number().int() }),
    docs: true,
    cause:
      'The number of live sessions equals `maxSessions` (derived from available RAM by default).',
    resolution:
      'Close sessions you no longer need, or raise `maxSessions` on a host with more memory.',
  }),
  SESSION_ACCESS_DENIED: defineError({
    code: 'SESSION_ACCESS_DENIED',
    httpStatus: 404,
    category: 'domain',
    retryable: 'never',
    title: 'Session not found',
    // Deliberately identical to SESSION_NOT_FOUND so a cross-principal probe cannot tell "not yours"
    // from "does not exist".
    message: "No browser session with id '{session_id}'",
    hint: 'Use list_sessions to see the sessions you own.',
    details: sessionId,
    docs: true,
    cause:
      'The session belongs to a different principal and ownership enforcement is on (`auth=token`).',
    resolution: 'Only the owning principal may use a session; launch your own.',
  }),
  SESSION_NOT_AVAILABLE: defineError({
    code: 'SESSION_NOT_AVAILABLE',
    httpStatus: 409,
    category: 'domain',
    retryable: 'after_operator',
    title: 'Session not available',
    message: "Session '{session_id}' is not available (state: {state}).",
    hint: 'Wait until the session is live, or pick another session.',
    details: z.object({ session_id: z.string(), state: z.string() }),
    docs: true,
    cause: 'The session is launching, draining, paused for an operator, closed or crashed.',
    resolution: 'Retry once the session state returns to `live`.',
  }),
  SESSION_NOT_LIVE: defineError({
    code: 'SESSION_NOT_LIVE',
    httpStatus: 409,
    category: 'domain',
    retryable: 'never',
    title: 'Session is not live',
    message: "Session '{session_id}' is not live.",
    hint: 'This action needs a live session; the session has ended.',
    details: sessionId,
    docs: true,
    cause:
      'An operator action that needs a running browser (live view, input, terminate) targeted a closed session.',
    resolution: 'Open the trace or history views instead.',
  }),
  SESSION_LIVE: defineError({
    code: 'SESSION_LIVE',
    httpStatus: 409,
    category: 'domain',
    retryable: 'never',
    title: 'Session is still live',
    message: "Session '{session_id}' is still live.",
    hint: 'Terminate or close the session first.',
    details: sessionId,
    docs: true,
    cause:
      'An action that needs a finished session (archive, delete, trace download) targeted a live one.',
    resolution: 'Close the session, then retry.',
  }),
  UNKNOWN_CHANNEL: defineError({
    code: 'UNKNOWN_CHANNEL',
    httpStatus: 400,
    category: 'domain',
    retryable: 'different_args',
    title: 'Unknown browser channel',
    message: "Unknown browser channel '{channel}'. Expected one of: chromium, chrome, edge.",
    hint: 'Pass channel as one of chromium, chrome or edge.',
    details: z.object({ channel: z.string(), supported: z.array(z.string()) }),
    docs: true,
    cause: 'The `channel` argument is not a supported Chromium-family channel.',
    resolution:
      'Use `chromium` (bundled), or `chrome`/`edge` when that browser is installed on the host.',
  }),
  INVALID_SLUG: defineError({
    code: 'INVALID_SLUG',
    httpStatus: 400,
    category: 'domain',
    retryable: 'different_args',
    title: 'Invalid slug',
    message:
      "Invalid slug '{slug}'. Slugs must match /^[a-z][a-z0-9-]{1,31}$/ (start with a lowercase letter, 2–32 chars, lowercase alphanumerics and dashes).",
    hint: 'Use a short lowercase name such as "shop" or "docs-crawl".',
    details: z.object({ slug: z.string(), pattern: z.string() }),
    docs: true,
    cause: 'The slug does not match the filesystem-safe grammar.',
    resolution: 'Lowercase letters, digits and dashes only; start with a letter; 2–32 characters.',
  }),
  UNSAFE_LAUNCH_ARG: defineError({
    code: 'UNSAFE_LAUNCH_ARG',
    httpStatus: 400,
    category: 'domain',
    retryable: 'different_args',
    title: 'Launch argument denied',
    message: "Launch arg '{arg}' is on the deny-list and would break session isolation.",
    hint: 'Remove the argument from launch_options.args.',
    details: z.object({ arg: z.string() }),
    docs: true,
    cause:
      'A Chromium flag that changes the profile directory, sandbox or debugging surface was passed.',
    resolution:
      'Use the persistence modes and channel options instead of raw isolation-breaking flags.',
  }),
  INVALID_PERSISTENCE_CONFIG: defineError({
    code: 'INVALID_PERSISTENCE_CONFIG',
    httpStatus: 400,
    category: 'domain',
    retryable: 'different_args',
    title: 'Invalid persistence config',
    message: 'Invalid persistence config: {reason}',
    hint: 'Check the persistence_mode / restore_profile / storage_state / incognito combination.',
    details: z.object({ reason: z.string() }),
    docs: true,
    cause: 'The requested combination of persistence mode and launch options is contradictory.',
    resolution:
      'See the persistence matrix in the tool reference and pick a consistent combination.',
  }),
  TAB_NOT_FOUND: defineError({
    code: 'TAB_NOT_FOUND',
    httpStatus: 404,
    category: 'domain',
    retryable: 'different_args',
    title: 'Tab not found',
    message: "Tab '{tab_id}' not found in session '{session_id}'.",
    hint: 'Use list_tabs to see open tabs.',
    details: z.object({ session_id: z.string(), tab_id: z.string() }),
    docs: true,
    cause:
      'The tab id is unknown or the tab was closed; `<active>` means the session has no open tab.',
    resolution: 'Call list_tabs, or open a tab with new_tab.',
  }),
  PATH_NOT_ALLOWED: defineError({
    code: 'PATH_NOT_ALLOWED',
    httpStatus: 400,
    category: 'domain',
    retryable: 'different_args',
    title: 'Path outside the sandbox',
    // Core appends " Allowed roots: '…'. Pass an absolute path under one of these[, or a relative
    // path (…)]." only for local audiences (spec 10 §1.3).
    message: "Path '{path}' is outside the allowed sandbox roots.",
    hint: 'Use a relative path or an absolute path under an allowed root.',
    details: z.object({ path: z.string(), roots: z.array(z.string()) }),
    docs: true,
    cause:
      'The resolved path (symlinks followed) escapes the session directory and the uploads directory.',
    resolution:
      'Write inside the session directory (relative paths resolve there) or the uploads directory.',
  }),
  AUTH_STATE_NOT_FOUND: defineError({
    code: 'AUTH_STATE_NOT_FOUND',
    httpStatus: 404,
    category: 'domain',
    retryable: 'different_args',
    title: 'Saved auth state not found',
    // `{kind_label}` is 'full-profile' for kind=profile and 'storage-state' for kind=storage.
    message:
      "No saved {kind_label} snapshot named '{name}'. Use list_saved_auths to see what is available.",
    hint: 'Call list_saved_auths and use one of the returned names.',
    details: z.object({ name: z.string(), kind: z.enum(['storage', 'profile']) }),
    docs: true,
    cause: 'No snapshot of the requested kind exists under that name in the auth-states directory.',
    resolution: 'Save one with save_storage_state or save_full_profile first.',
  }),
  PROFILE_FILE_LOCKED: defineError({
    code: 'PROFILE_FILE_LOCKED',
    httpStatus: 409,
    category: 'domain',
    retryable: 'never',
    title: 'Profile file locked by the running browser',
    message:
      "Cannot save a full profile of the live session: '{file}' is locked by the running browser.",
    hint: "Use save_storage_state to snapshot a live session's cookies, localStorage and IndexedDB.",
    details: z.object({ file: z.string() }),
    docs: true,
    cause:
      'On Windows a running Chromium holds some profile databases (cookies, history) exclusively, so no other process can read them while the session is live.',
    resolution:
      "Use save_storage_state for a live session. A full-profile snapshot needs the browser's files released, which happens when the session closes.",
  }),
  // --- Session templates (spec 13 §12, D-49…D-52). Messages, hints and details are agent-facing:
  // they say what the session can and cannot do, never how templates work or that other sessions
  // exist (spec 13 §5, pinned by `test/tools/template-wording.test.ts`). `cause` and `resolution`
  // are operator documentation and may name the mechanism.
  TEMPLATE_NOT_FOUND: defineError({
    code: 'TEMPLATE_NOT_FOUND',
    httpStatus: 404,
    category: 'domain',
    retryable: 'different_args',
    title: 'Template not found',
    message:
      "No session template named '{template}'. Use list_templates to see the templates you can use.",
    hint: 'Call list_templates and use one of the returned names.',
    details: z.object({ template: z.string() }),
    docs: true,
    cause:
      'No template has that name, the caller is not allowed to use it (its principal or harness is not in the template’s access rule), the template is still being set up (`recording`), or templates are turned off (`templates=false`). All four answer identically, so an agent cannot tell a template it may not use from one that does not exist (D-52).',
    resolution:
      'The operator sees the real reason in the template’s access tester and in the `template launch refused` log line; grant the caller access, finish the recording, or enable templates.',
  }),
  TEMPLATE_BUSY: defineError({
    code: 'TEMPLATE_BUSY',
    httpStatus: 429,
    category: 'domain',
    retryable: 'backoff',
    title: 'Template busy',
    // `{limit_text}`: capacity "Template '<name>' is at capacity."; tabs "This session has reached
    // its tab limit; close a tab you no longer need."; pace "Actions on <site> are being paced."
    message: '{limit_text} Retry in {retry_after_s} s.',
    hint: 'Wait for the time given, then retry.',
    details: z.object({
      template: z.string(),
      limit_kind: z.enum(['capacity', 'tabs', 'pace']),
      limit_text: z.string(),
      retry_after_ms: z.number().int().nonnegative(),
      retry_after_s: z.number().int().nonnegative(),
    }),
    docs: true,
    cause:
      'The template is at its session cap (`max_concurrent`, further bounded by its sites’ packs), its browser holds `templateMaxPagesPerHost` agent pages, the session holds its share of them (`tabs`), or a site strategy paces actions (`pace`, spec 13 §6.3, §9.4).',
    resolution:
      'Close sessions or tabs that are no longer needed, or raise the template’s cap or `templateMaxPagesPerHost`.',
  }),
  TEMPLATE_UNAVAILABLE: defineError({
    code: 'TEMPLATE_UNAVAILABLE',
    httpStatus: 503,
    category: 'domain',
    retryable: 'backoff',
    title: 'Template temporarily unavailable',
    message: "Template '{template}' is temporarily unavailable. Retry in a few seconds.",
    hint: 'Wait a few seconds, then retry.',
    details: z.object({
      template: z.string(),
      reason: z.enum(['starting', 'restarting', 'recovering']),
      retry_after_ms: z.number().int().nonnegative(),
    }),
    docs: true,
    cause:
      'The template’s browser is starting and did not finish within the launch budget (`starting`), is being drained for a recycle, restore or operator restart (`restarting`), or is restarting after a crash (`recovering`, spec 13 §3.2).',
    resolution:
      'Retry after `retry_after_ms`. A template that stays unavailable shows its browser state and last error on the template page.',
  }),
  TEMPLATE_DISABLED: defineError({
    code: 'TEMPLATE_DISABLED',
    httpStatus: 409,
    category: 'domain',
    retryable: 'after_operator',
    title: 'Template disabled',
    message: "Template '{template}' cannot be used until the operator fixes it.",
    hint: 'Use another template, or retry after the operator has fixed this one.',
    details: z.object({ template: z.string(), reason: z.enum(['disabled', 'needs_operator']) }),
    docs: true,
    cause:
      'The operator disabled the template (`disabled`), or its browser cannot start until the operator acts (`needs_operator`: five failed starts, no display, an unreachable proxy or no sandbox under `sandbox=on`; the cause is shown on operator surfaces only).',
    resolution:
      'Enable the template, or fix the cause shown on the template page and restart its browser.',
  }),
  SESSION_SEALED: defineError({
    code: 'SESSION_SEALED',
    httpStatus: 403,
    category: 'domain',
    retryable: 'never',
    title: 'Not available in this session',
    message:
      "{tool} is not available in this session: its sign-ins belong to the operator's session template.",
    hint: 'Continue without it, or ask the operator to allow it for this template.',
    details: z.object({ session_id: z.string(), tool: z.string() }),
    docs: true,
    cause:
      'The session was launched from a sealed template: `set_cookies` (cookie writes) and `save_storage_state` (state export) are refused unless the operator unseals that flag for the template and the caller (spec 13 §5.4, D-51).',
    resolution:
      'Unseal the flag on the template’s Access tab, for every principal or only for the ones that need it.',
  }),
} as const;
