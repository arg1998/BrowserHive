/** @module lib/status-registry — every domain state → { label, tone, icon, pulse? }; no string tones anywhere else (spec 04 §8) */
import type {
  BlockedSource,
  ClosedReason,
  LogLevel,
  NotificationType,
  OperatorRequestStatus,
  SessionStatus,
  UrlCategory,
} from '@browserhive/contracts/enums';
import type { OriginCheck, SessionSummary, VaultAccessResult } from '@browserhive/contracts/http';
import type { IconName } from './icons.ts';

/** Closed union of tones (spec 04 §7). */
export type Tone =
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  | 'vault'
  | 'info'
  | 'neutral'
  | 'muted';

/** One registry entry. */
export interface StatusEntry {
  readonly label: string;
  readonly tone: Tone;
  readonly icon?: IconName;
  readonly pulse?: boolean;
  /** Explanatory text shown in tooltips. */
  readonly hint?: string;
}

/** Session display states: the enum states plus the derived ones the UI shows (spec 04 §8). */
export type SessionDisplayState =
  | SessionStatus
  | 'attention'
  | 'streaming'
  | 'lease_expired'
  | 'interrupted'
  | 'shutdown'
  | 'archived';

/** Session state registry. */
export const SESSION_STATE: { readonly [K in SessionDisplayState]: StatusEntry } = {
  reserved: { label: 'reserved', tone: 'info' },
  launching: { label: 'launching', tone: 'info', pulse: true },
  live: { label: 'live', tone: 'success', pulse: true },
  attention: { label: 'attention', tone: 'warn', pulse: true, icon: 'attention' },
  paused: { label: 'paused', tone: 'warn' },
  streaming: { label: 'live view', tone: 'success', pulse: true, icon: 'play' },
  draining: { label: 'closing', tone: 'info', pulse: true },
  closed: { label: 'closed', tone: 'neutral' },
  lease_expired: { label: 'expired', tone: 'neutral' },
  crashed: { label: 'crashed', tone: 'danger', icon: 'danger' },
  interrupted: { label: 'interrupted', tone: 'danger' },
  shutdown: { label: 'shutdown', tone: 'neutral' },
  archived: { label: 'archived', tone: 'neutral', icon: 'archive' },
};

/** Map a closed reason to the display state of a closed session. */
export const CLOSED_REASON_STATE: { readonly [K in ClosedReason]: SessionDisplayState } = {
  user: 'closed',
  operator: 'closed',
  lease_expired: 'lease_expired',
  crash: 'crashed',
  shutdown: 'shutdown',
  interrupted: 'interrupted',
  launch_failed: 'crashed',
};

/** Derive the one state a session row shows (attention > live view > paused > live; closed by reason). */
export function sessionDisplayState(session: SessionSummary): SessionDisplayState {
  if (session.archived_at !== null) return 'archived';
  switch (session.state) {
    case 'live':
      if (session.counts.attention_open > 0) return 'attention';
      if (session.has_live_viewers) return 'streaming';
      return 'live';
    case 'paused':
      return session.counts.attention_open > 0 ? 'attention' : 'paused';
    case 'closed':
      return session.closed_reason === null ? 'closed' : CLOSED_REASON_STATE[session.closed_reason];
    case 'crashed':
    case 'reserved':
    case 'launching':
    case 'draining':
      return session.state;
    default:
      return assertNever(session.state);
  }
}

/** Attention / vault-confirm outcome registry. */
export const REQUEST_STATUS: { readonly [K in OperatorRequestStatus]: StatusEntry } = {
  pending: { label: 'pending', tone: 'warn', pulse: true },
  resolved: { label: 'resolved', tone: 'success' },
  rejected: { label: 'rejected', tone: 'danger' },
  timeout: { label: 'timeout', tone: 'warn' },
  cancelled: { label: 'cancelled', tone: 'neutral' },
};

/** Vault fill result registry. */
export const VAULT_RESULT: { readonly [K in VaultAccessResult]: StatusEntry } = {
  success: { label: 'success', tone: 'success' },
  origin_mismatch: { label: 'origin mismatch', tone: 'danger' },
  auth_failed: { label: 'auth failed', tone: 'danger' },
  blocked: { label: 'blocked', tone: 'warn' },
  denied: { label: 'denied', tone: 'danger' },
};

/** Vault origin-check registry. */
export const ORIGIN_CHECK: { readonly [K in OriginCheck]: StatusEntry } = {
  pass: { label: 'origin ok', tone: 'success' },
  fail: { label: 'origin fail', tone: 'danger' },
  skipped: { label: 'origin skipped', tone: 'neutral' },
};

/** URL category registry with tooltip hints. */
export const URL_CATEGORY: { readonly [K in UrlCategory]: StatusEntry } = {
  public: { label: 'Public', tone: 'neutral', icon: 'globe', hint: 'http(s) to a domain name' },
  ip: {
    label: 'IP address',
    tone: 'warn',
    icon: 'ip',
    hint: 'addressed a host by raw IP, not a domain',
  },
  local: { label: 'Local', tone: 'warn', icon: 'local', hint: 'file://, localhost, loopback' },
  ftp: { label: 'FTP', tone: 'info', icon: 'ftp', hint: 'ftp:// transfer' },
  other: {
    label: 'Other',
    tone: 'neutral',
    icon: 'other',
    hint: 'data:, blob:, chrome:, about:, …',
  },
};

/** Blocked-request source registry. */
export const BLOCKED_SOURCE: { readonly [K in BlockedSource]: StatusEntry } = {
  tool: { label: 'tool call', tone: 'neutral' },
  request: { label: 'in-page navigation', tone: 'neutral' },
};

/** Notification type registry. */
export const NOTIFICATION_TYPE: { readonly [K in NotificationType]: StatusEntry } = {
  attention: { label: 'attention', tone: 'warn', icon: 'attention' },
  error: { label: 'error', tone: 'danger', icon: 'danger' },
  vault: { label: 'vault', tone: 'vault', icon: 'vault' },
  lifecycle: { label: 'lifecycle', tone: 'info', icon: 'lifecycle' },
  system: { label: 'system', tone: 'info', icon: 'system' },
};

/** Log level registry. */
export const LOG_LEVEL: { readonly [K in LogLevel]: StatusEntry } = {
  error: { label: 'error', tone: 'danger' },
  warn: { label: 'warn', tone: 'warn' },
  info: { label: 'info', tone: 'neutral' },
  debug: { label: 'debug', tone: 'muted' },
  trace: { label: 'trace', tone: 'muted' },
};

/** Socket state registry (health pill). */
export const SOCKET_STATE = {
  connected: { label: 'daemon · /mcp', tone: 'success', icon: 'online', pulse: true },
  connecting: { label: 'reconnecting…', tone: 'warn', icon: 'refresh', pulse: true },
  offline: { label: 'offline', tone: 'danger', icon: 'offline' },
  idle: { label: 'not connected', tone: 'neutral', icon: 'offline' },
} as const satisfies Record<string, StatusEntry>;

/** Lease thresholds (spec 04 §8). */
export const LEASE_WARN_MS = 10 * 60_000;
/** Lease danger threshold. */
export const LEASE_DANGER_MS = 2 * 60_000;
/** Disk usage warning ratio. */
export const DISK_WARN = 0.8;
/** Disk usage danger ratio. */
export const DISK_DANGER = 0.9;

/** Tone for a remaining lease. */
export function leaseTone(remainingMs: number): Tone {
  if (remainingMs < LEASE_DANGER_MS) return 'danger';
  if (remainingMs < LEASE_WARN_MS) return 'warn';
  return 'neutral';
}

/** Tone for a disk usage ratio. */
export function diskTone(ratio: number): Tone {
  if (ratio >= DISK_DANGER) return 'danger';
  if (ratio >= DISK_WARN) return 'warn';
  return 'neutral';
}

/** Registry domains addressable by name (used by `StatusBadge`). */
export const REGISTRIES = {
  session: SESSION_STATE,
  request: REQUEST_STATUS,
  vaultResult: VAULT_RESULT,
  originCheck: ORIGIN_CHECK,
  urlCategory: URL_CATEGORY,
  blockedSource: BLOCKED_SOURCE,
  notification: NOTIFICATION_TYPE,
  logLevel: LOG_LEVEL,
  socket: SOCKET_STATE,
} as const;

/** Registry domain name. */
export type RegistryDomain = keyof typeof REGISTRIES;
/** Valid value of one domain. */
export type RegistryValue<D extends RegistryDomain> = keyof (typeof REGISTRIES)[D] & string;

/** Look up an entry; a falsy result is a programming error, so callers may rely on the label. */
export function statusEntry<D extends RegistryDomain>(
  domain: D,
  value: RegistryValue<D>,
): StatusEntry {
  const registry: Record<string, StatusEntry> = REGISTRIES[domain];
  return registry[value] ?? { label: value, tone: 'neutral' };
}

function assertNever(value: never): never {
  throw new Error(`unhandled state ${String(value)}`);
}
