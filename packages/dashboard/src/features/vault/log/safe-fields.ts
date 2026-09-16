/** @module features/vault/log/safe-fields — whitelist of `VaultAccessRow.details` keys the UI may render; everything else (and every non-scalar) is dropped so a secret can never reach the DOM */
/** Detail keys that are policy/audit metadata, never secret material. */
export const SAFE_DETAIL_KEYS = [
  'reason',
  'origin',
  'page_origin',
  'allowed_origins',
  'form_action',
  'handle',
  'tool',
  'confirm_request_id',
  'decision',
  'duration_ms',
  'evaluate_enabled',
] as const;

/** Whitelisted detail pairs as display strings (strings, numbers, booleans, arrays of strings only). */
export function safeDetails(details: unknown): readonly (readonly [string, string])[] {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return [];
  const record = details as Readonly<Record<string, unknown>>;
  const out: [string, string][] = [];
  for (const key of SAFE_DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out.push([key, String(value)]);
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      out.push([key, value.join(', ')]);
  }
  return out;
}
