/** @module interface/mcp/tool-outcome — in-band tool-failure classification: returned statuses that are task-level failures get a synthetic audit code (spec 02 §2.3). */

/*
 * Most tools report failure by throwing. A handful deliberately *return* their failure because the
 * agent is expected to branch on it — `vault_fill` answers `{ status: 'auth_failed' }`,
 * `request_attention` answers `{ status: 'timeout' }`, `navigate` answers `{ status: 404 }`. Recorded
 * naively those rows would be green in the trace view. This module is the single place that reads a
 * returned value and decides "that was a failure"; the codes are audit codes, never thrown.
 */

/** A failure a tool reported inside a successful result. */
export interface SoftFailure {
  /** Synthetic `tool_calls.error_code`. */
  readonly code: string;
  /** Operator-facing explanation, stored as `tool_calls.error_message`. */
  readonly message: string;
}

/** Every audit code this module produces besides the `HTTP_<status>` family. */
export const SOFT_ERROR_CODES: readonly string[] = [
  'ORIGIN_MISMATCH',
  'VAULT_FILL_AUTH_FAILED',
  'VAULT_FILL_BLOCKED',
  'VAULT_LIST_DENIED',
  'ATTENTION_REJECTED',
  'ATTENTION_TIMEOUT',
  'ATTENTION_CANCELLED',
];

type Json = Readonly<Record<string, unknown>>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Inspects a tool's returned value for an in-band failure; `null` when the call genuinely succeeded
 * or the tool has no in-band failure mode. Total and non-throwing: an unexpected shape is "no failure".
 */
export function classifyToolOutcome(tool: string, value: unknown): SoftFailure | null {
  if (!isJson(value)) return null;
  switch (tool) {
    case 'vault_fill':
      return vaultFillFailure(value);
    case 'vault_list_available':
      return vaultListFailure(value);
    case 'request_attention':
    case 'get_attention_result':
      return attentionFailure(value);
    case 'navigate':
      return navigateFailure(value);
    default:
      return null;
  }
}

function vaultFillFailure(result: Json): SoftFailure | null {
  const status = str(result['status']);
  if (status === null || status === 'success') return null;
  const reason = str(result['reason']);
  const detail = reason !== null && reason !== status ? ` (${reason})` : '';
  switch (status) {
    case 'origin_mismatch':
      return {
        code: 'ORIGIN_MISMATCH',
        message: `vault_fill refused: the page's origin is not on this entry's allow-list${detail}.`,
      };
    case 'auth_failed':
      return {
        code: 'VAULT_FILL_AUTH_FAILED',
        message: `vault_fill did not complete: the credential could not be fetched or entered${detail}.`,
      };
    case 'blocked':
      return { code: 'VAULT_FILL_BLOCKED', message: `vault_fill was blocked by policy${detail}.` };
    default:
      return {
        code: 'VAULT_FILL_BLOCKED',
        message: `vault_fill returned a non-success status '${status}'${detail}.`,
      };
  }
}

function vaultListFailure(result: Json): SoftFailure | null {
  if (result['scope'] !== 'rejected') return null;
  const mismatch = result['mismatch'];
  const declared = (isJson(mismatch) ? str(mismatch['declared']) : null) ?? 'unknown';
  const actual = (isJson(mismatch) ? str(mismatch['actual']) : null) ?? 'no page loaded';
  return {
    code: 'VAULT_LIST_DENIED',
    message:
      `vault_list_available was denied: the agent declared the domain '${declared}' but the ` +
      `session is on '${actual}'. The mismatch was recorded in the vault audit log.`,
  };
}

function attentionFailure(result: Json): SoftFailure | null {
  const status = str(result['status']);
  if (status === null || status === 'resolved' || status === 'pending') return null;
  const message = str(result['message']);
  const note = message !== null && message.length > 0 ? ` Operator note: ${message}` : '';
  switch (status) {
    case 'rejected':
      return {
        code: 'ATTENTION_REJECTED',
        message: `The attention request was rejected by an operator.${note}`,
      };
    case 'timeout':
      return {
        code: 'ATTENTION_TIMEOUT',
        message: `The attention request timed out before an operator responded.${note}`,
      };
    case 'cancelled':
      return {
        code: 'ATTENTION_CANCELLED',
        message: `The attention request was cancelled before it was decided.${note}`,
      };
    default:
      return null;
  }
}

function navigateFailure(result: Json): SoftFailure | null {
  const status = typeof result['status'] === 'number' ? result['status'] : null;
  if (status === null || status < 400 || status > 599) return null;
  const url = str(result['url']) ?? 'the requested URL';
  return {
    code: `HTTP_${status}`,
    message: `Navigation to ${url} returned HTTP ${status}; the page content is the server's error response.`,
  };
}
