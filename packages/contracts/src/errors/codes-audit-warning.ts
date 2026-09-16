/** @module contracts/errors/codes-audit-warning — audit-only outcome codes and SessionWarning codes (never thrown) */
import { z } from 'zod';
import { defineError } from './spec.ts';

/** Details carried by every `SessionWarning` (the warning record is `{code, session_id, message, details}`). */
export const SessionWarningDetails = z.object({
  session_id: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** Soft outcomes recorded in `tool_calls.error_code` by the outcome classifier; never thrown. */
export const AUDIT_ERRORS = {
  ORIGIN_MISMATCH: defineError({
    code: 'ORIGIN_MISMATCH',
    httpStatus: 403,
    category: 'audit',
    retryable: 'different_args',
    title: 'Origin not on the allow-list',
    message: "Origin '{page_origin}' is not on the allow-list for vault entry '{entry_name}'.",
    hint: 'Navigate to an allowed origin before filling.',
    details: z.object({
      page_origin: z.string(),
      entry_name: z.string(),
      allowed: z.array(z.string()),
    }),
    docs: true,
    cause: 'The page origin at fill time did not match the binding’s allowed origins.',
    resolution: 'Fill only on the sites the operator bound the entry to.',
  }),
  VAULT_FILL_AUTH_FAILED: defineError({
    code: 'VAULT_FILL_AUTH_FAILED',
    httpStatus: 500,
    category: 'audit',
    retryable: 'never',
    title: 'Vault fill: authentication failed',
    message: 'The vault fill completed but the site did not accept the credentials.',
    hint: 'Classification of a returned vault_fill status; not an exception.',
    details: z.object({ entry_name: z.string() }),
    docs: true,
    cause: '`vault_fill` returned `auth_failed`.',
    resolution: 'Check the credential in the vault; nothing to retry automatically.',
  }),
  VAULT_FILL_BLOCKED: defineError({
    code: 'VAULT_FILL_BLOCKED',
    httpStatus: 500,
    category: 'audit',
    retryable: 'never',
    title: 'Vault fill: blocked',
    message: 'The vault fill was blocked by policy.',
    hint: 'Classification of a returned vault_fill status; not an exception.',
    details: z.object({ entry_name: z.string(), reason: z.string().optional() }),
    docs: true,
    cause: '`vault_fill` returned `blocked` (policy gate refused).',
    resolution: 'See the reason; operators adjust bindings and policies.',
  }),
  VAULT_LIST_DENIED: defineError({
    code: 'VAULT_LIST_DENIED',
    httpStatus: 500,
    category: 'audit',
    retryable: 'never',
    title: 'Vault list: denied',
    message: 'The vault listing was denied for this session.',
    hint: 'Classification of a returned vault_list_available status; not an exception.',
    details: z.object({}),
    docs: true,
    cause: '`vault_list_available` returned no entries because policy denied the session.',
    resolution: 'Operators adjust bindings and policies.',
  }),
  ATTENTION_REJECTED: defineError({
    code: 'ATTENTION_REJECTED',
    httpStatus: 500,
    category: 'audit',
    retryable: 'never',
    title: 'Attention: rejected',
    message: 'The attention request was rejected.',
    hint: 'Classification of a returned request_attention status; not an exception.',
    details: z.object({ request_id: z.string() }),
    docs: true,
    cause: 'The operator rejected the request, or the session closed while it was open.',
    resolution: 'Read the returned message; continue or stop the task accordingly.',
  }),
  ATTENTION_TIMEOUT: defineError({
    code: 'ATTENTION_TIMEOUT',
    httpStatus: 500,
    category: 'audit',
    retryable: 'never',
    title: 'Attention: timed out',
    message: 'Attention request timed out; the operator was not available to respond.',
    hint: 'Classification of a returned request_attention status; not an exception.',
    details: z.object({ request_id: z.string() }),
    docs: true,
    cause: 'Nobody resolved the request before its deadline.',
    resolution: 'Retry later with a longer wait, or proceed without the operator.',
  }),
  ATTENTION_CANCELLED: defineError({
    code: 'ATTENTION_CANCELLED',
    httpStatus: 500,
    category: 'audit',
    retryable: 'never',
    title: 'Attention: cancelled',
    message: 'Client cancelled the attention request.',
    hint: 'Classification of a returned request_attention status; not an exception.',
    details: z.object({ request_id: z.string() }),
    docs: true,
    cause: 'The MCP client disconnected or sent notifications/cancelled.',
    resolution: 'Nothing to do.',
  }),
} as const;

function warning<const C extends string>(
  code: C,
  title: string,
  cause: string,
  resolution: string,
) {
  return defineError({
    code,
    httpStatus: 500,
    category: 'warning',
    retryable: 'never',
    title,
    message: '{message}',
    hint: 'Session warning: logged and broadcast on session:<id>, never thrown.',
    details: SessionWarningDetails,
    docs: true,
    cause,
    resolution,
  });
}

/** `SessionWarning` codes (the session warning sink); logged at `warn`, never thrown. */
export const WARNING_ERRORS = {
  EXECUTABLE_PATH_OVERRIDE: warning(
    'EXECUTABLE_PATH_OVERRIDE',
    'Executable path override',
    'A launch option set `executablePath`, which disables channel routing.',
    'Prefer `channel`; use `executablePath` only for custom builds.',
  ),
  TRACE_START_FAILED: warning(
    'TRACE_START_FAILED',
    'Trace could not start',
    'Playwright tracing failed to start for the session; the session continues without a trace.',
    'Check disk space and the session directory permissions.',
  ),
  TRACE_FINALIZE_FAILED: warning(
    'TRACE_FINALIZE_FAILED',
    'Trace could not be finalized',
    'Stopping the trace failed or exceeded the 10 s cap at close.',
    'The trace may be incomplete; check disk space.',
  ),
  STEALTH_INIT_FAILED: warning(
    'STEALTH_INIT_FAILED',
    'Stealth init failed',
    'The CDP identity override could not be applied; the session runs with reduced stealth.',
    'Check the driver (Patchright/Playwright) version compatibility.',
  ),
  BLOCKLIST_ROUTE_FAILED: warning(
    'BLOCKLIST_ROUTE_FAILED',
    'Blocklist route failed',
    'The network-level blocklist route could not be installed; tool-level enforcement still applies.',
    'Check the driver version; report if it repeats.',
  ),
  BYO_PROXY_UNSEEDED: warning(
    'BYO_PROXY_UNSEEDED',
    'BYO proxy: geo not seeded',
    'A caller-supplied proxy suppresses geo-derived identity because the exit location is unknown.',
    'Pass `locale`/`timezoneId` explicitly when using your own proxy.',
  ),
  VIEWPORT_OVERRIDE_UNASSERTED: warning(
    'VIEWPORT_OVERRIDE_UNASSERTED',
    'Viewport override: display not asserted',
    'A caller-supplied viewport disables the display-coherence assertion of the fingerprint.',
    'Omit `viewport` to let the identity pick a coherent display.',
  ),
  IDENTITY_SEED_SAVE_FAILED: warning(
    'IDENTITY_SEED_SAVE_FAILED',
    'Identity seed not saved',
    'The `.identity.json` sidecar could not be written with the full profile.',
    'Check the auth-states directory permissions.',
  ),
  REAP_DEAD_FAILED: warning(
    'REAP_DEAD_FAILED',
    'Dead session reap failed',
    'Closing a dead session raised; the sweeper will retry.',
    'No action; report if it repeats for the same session.',
  ),
  CDP_SESSION_LEAKED: warning(
    'CDP_SESSION_LEAKED',
    'CDP session leaked',
    'A CDP session was still attached when its page closed and had to be pruned late.',
    'No action; report if it repeats.',
  ),
  SCREENSHOT_ARCHIVE_FAILED: warning(
    'SCREENSHOT_ARCHIVE_FAILED',
    'Screenshot archive failed',
    'A tool screenshot could not be written to the session directory.',
    'Check disk space and permissions.',
  ),
} as const;
