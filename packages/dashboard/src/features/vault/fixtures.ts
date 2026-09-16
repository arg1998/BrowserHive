/** @module features/vault/fixtures — wire fixtures for vault component tests (bindings, groups, access rows, overview) */
import { NOW } from '@/features/attention/fixtures.ts';

/** A binding row. */
export function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: 'work.github',
    title: 'GitHub',
    item_name: 'GitHub Login',
    item_id: 'item-1',
    group_id: 'g-work',
    allowed_origins: ['github.com', '*.github.com'],
    authorized_principals: [],
    authorized_session_slugs: ['agent-*'],
    allow_all_sessions: false,
    redact_username: false,
    require_no_evaluate: true,
    dashboard_confirm: false,
    created_at: NOW - 86_400_000,
    updated_at: NOW - 3_600_000,
    version: 1,
    ...overrides,
  };
}

/** A group with a policy. */
export function groupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group_id: 'g-work',
    name: 'Work',
    item_count: 3,
    bound_count: 1,
    policy: {
      group_id: 'g-work',
      access_mode: 'manual',
      allow_all_sessions: false,
      session_slug_globs: [],
      authorized_principals: [],
      dashboard_confirm: false,
      require_no_evaluate: false,
      redact_username: false,
      version: 2,
      created_at: NOW - 86_400_000,
      updated_at: NOW - 86_400_000,
    },
    ...overrides,
  };
}

/** A vault access audit row. */
export function accessRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'e-01HZX0000000000000000000AA',
    session_id: 'shop-ab12cd34',
    session_slug: 'shop',
    tool_event_id: null,
    entry_name: 'work.github',
    handle: 'work.github',
    result: 'success',
    reason: 'origin allowed',
    evaluate_enabled: false,
    page_url: 'https://github.com/login',
    origin_check: 'pass',
    principal_id: 'local',
    details: null,
    ts: NOW - 5_000,
    ...overrides,
  };
}

/** `GET /vault` body. */
export const OVERVIEW = {
  backend: {
    id: 'bitwarden',
    capabilities: {
      unlock: 'token',
      grouping: 'flat',
      writable: false,
      totp: false,
      sync: true,
    },
  },
  unlock: {
    required: true,
    mode: 'token',
    hint: 'Run bw unlock --raw in a terminal where you are logged in to bw, then paste the session token it prints.',
  },
  unlocked: true,
  bindings_count: 1,
  policies_count: 1,
  now: NOW,
};

/** `GET /system` body fragment the pages read (lenient parse tolerates the rest). */
export const SYSTEM_VAULT_ON = { vault: { enabled: true, backend: 'bitwarden' } };
