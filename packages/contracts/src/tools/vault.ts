/** @module contracts/tools/vault — vault_list_available and vault_fill contracts */
import { z } from 'zod';
import { annotations, SESSION_ERRORS, SINCE } from './shared.ts';
import { defineTool } from './types.ts';

/** How `vault_list_available` scoped (or refused) the listing. */
export const VaultListScope = z.enum(['unscoped', 'page', 'no_page', 'rejected']);
/** `vault_fill` outcome; failures are returned, never thrown. */
export const VaultFillStatus = z.enum(['success', 'origin_mismatch', 'auth_failed', 'blocked']);

/** One entry the calling session may fill. Never carries a secret. */
export const AvailableVaultEntry = z.object({
  entry_name: z.string(),
  allowed_origins: z.array(z.string()),
  redact_username: z.boolean(),
  require_no_evaluate: z.boolean(),
});

/** `vault_list_available` result (`mismatch`/`note` only when set). */
export const VaultListResult = z.object({
  entries: z.array(AvailableVaultEntry),
  scope: VaultListScope,
  scoped_to: z.string().nullable(),
  mismatch: z.object({ declared: z.string(), actual: z.string().nullable() }).optional(),
  note: z.string().optional(),
});

/** `vault_fill` result. `reason` carries the code on non-success. */
export const VaultFillResult = z.object({
  status: VaultFillStatus,
  redacted: z.literal(true),
  reason: z.string().optional(),
});

/** `vault_list_available`: scoped to the session's real page; `url` is an honesty probe. */
export const VAULT_LIST_AVAILABLE = defineTool({
  name: 'vault_list_available',
  title: 'Vault: list available',
  description:
    'List the vault entries you may fill on the page this session is currently on. Returns ' +
    '{ entries: [{ entry_name, allowed_origins, redact_username, require_no_evaluate }], scope, ' +
    "scoped_to, note? }. Results are SCOPED to the session's current page — navigate to the login " +
    'page first, then call this. Pass `url` = the domain of that login page (e.g. "github.com"); ' +
    'if it does not match the page the session is actually on, the request is denied and reported. ' +
    'An entry only appears after an operator authorizes this session for it. Never returns secrets.',
  input: z.object({
    session_id: z.string(),
    url: z
      .string()
      .optional()
      .describe(
        'The domain (or URL) of the login page you have navigated to, e.g. "github.com". Results are ' +
          'scoped to this site. Pass only the domain — not the full URL with its path/query — the ' +
          'session already holds the exact page. If it does not match the page the session is actually ' +
          'on, the request is denied and reported.',
      ),
  }),
  output: VaultListResult,
  annotations: annotations(true, false, true, false),
  pack: 'vault',
  capability: 'credential',
  errors: ['VAULT_NOT_CONFIGURED', ...SESSION_ERRORS],
  since: SINCE,
});

/** `vault_fill`: one-shot atomic credential injection; non-success is a returned status. */
export const VAULT_FILL = defineTool({
  name: 'vault_fill',
  title: 'Vault: fill',
  description:
    'Atomically inject a vault credential into a login form: origin re-check, fetch from the ' +
    'backend, fill username + password, optional submit, then redact. `entry_name` is the stable ' +
    'handle from vault_list_available. The filled values are LEFT in the form by default — pass ' +
    '`clear_after_fill: true` only if you want the inputs wiped after the fill (done after ' +
    '`after_submit_wait_ms`, so an async/AJAX submit still reads them). Returns ' +
    '{ status: "success" | "origin_mismatch" | "auth_failed" | "blocked", redacted: true, reason? }. ' +
    'The credential never appears in the response, logs, events, or screenshots. The origin ' +
    'is checked against the entry allow-list by registrable domain.',
  input: z.object({
    session_id: z.string(),
    entry_name: z.string().min(1),
    username_selector: z.string().min(1),
    password_selector: z.string().min(1),
    submit_selector: z.string().min(1).optional(),
    after_submit_wait_ms: z.number().int().nonnegative().optional(),
    clear_after_fill: z.boolean().optional(),
    tab_id: z.string().optional(),
  }),
  output: VaultFillResult,
  annotations: annotations(false, false, false, true),
  pack: 'vault',
  capability: 'credential',
  errors: ['VAULT_NOT_CONFIGURED', 'VAULT_LOCKED', ...SESSION_ERRORS],
  since: SINCE,
});
