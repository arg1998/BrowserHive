/** @module features/attention/fixtures — `OperatorRequestRow` builders shared by the attention and vault component tests */
import type { OperatorRequestRow } from '@browserhive/contracts/http';

/** Fixed server now used by the harness clock. */
export const NOW = 1_700_000_000_000;

/** Build a wire request row (plain JSON, as the daemon sends it). */
export function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'a-AAAAAAAAAAAA',
    kind: 'attention',
    session_id: 'shop-ab12cd34',
    session_slug: 'shop',
    owner: 'local',
    reason: 'Solve the CAPTCHA',
    mode: 'takeover',
    options: { choices: ['a', 'b'] },
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: NOW - 60_000,
    resolved_at: null,
    deadline_at: NOW + 600_000,
    waited_ms: null,
    page_url: 'https://shop.example.com/checkout',
    tool: 'request_attention',
    event_id: null,
    entry_name: null,
    ...overrides,
  } satisfies Record<keyof OperatorRequestRow, unknown>;
}
