/** @module contracts/errors/audit — `HTTP_<n>` audit codes for navigate results with status ≥ 400 */

/** Template type of an HTTP audit code (`HTTP_400` … `HTTP_599`). */
export type HttpAuditCode = `HTTP_${number}`;

const HTTP_AUDIT_RE = /^HTTP_([4-5]\d{2})$/;

/**
 * Build the audit code recorded in `tool_calls.error_code` when `navigate` returns a status ≥ 400.
 *
 * @returns `HTTP_<status>` for 400–599.
 * @throws RangeError when `status` is outside 400–599 (those statuses are not failures).
 */
export function httpAuditCode(status: number): HttpAuditCode {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`HTTP audit codes cover 400-599, got ${status}`);
  }
  return `HTTP_${status}`;
}

/**
 * Type guard for `HTTP_<n>` audit codes.
 *
 * @returns `true` for `HTTP_400` … `HTTP_599`.
 */
export function isHttpAuditCode(value: string): value is HttpAuditCode {
  return HTTP_AUDIT_RE.test(value);
}

/**
 * The status carried by an `HTTP_<n>` audit code.
 *
 * @returns The numeric status, or `undefined` when `code` is not an HTTP audit code.
 */
export function httpAuditStatus(code: string): number | undefined {
  const match = HTTP_AUDIT_RE.exec(code);
  const digits = match?.[1];
  return digits === undefined ? undefined : Number(digits);
}
