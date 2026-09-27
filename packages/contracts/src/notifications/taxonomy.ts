/** @module contracts/notifications/taxonomy — the fixed kind → category map, per-kind labels, and the classification of rows written before the contract existed (spec 03 §9.1–9.2). */

import type { NotificationCategory } from '../enums/notification-category.ts';
import type { NotificationKind } from '../enums/notification-kind.ts';
import type { NotificationSeverity } from '../enums/notification-severity.ts';
import type { NotificationState } from '../enums/notification-state.ts';
import type { NotificationType } from '../enums/notification-type.ts';

/** The category of every kind. Fixed: a preset selects categories, never kinds. */
export const KIND_CATEGORY: { readonly [K in NotificationKind]: NotificationCategory } = {
  'attention.requested': 'needs-you',
  'vault.confirm': 'needs-you',
  'vault.filled': 'wrap-ups',
  'session.finished': 'wrap-ups',
  'session.crashed': 'problems',
  'session.reaped': 'problems',
  'tool.errors': 'problems',
  'system.degraded': 'system',
  'channel.broken': 'system',
  'digest.daily': 'reports',
  'report.anomaly': 'reports',
  test: 'system',
};

/** Severity each kind is produced with (a producer may raise it, never lower it below `info`). */
export const KIND_SEVERITY: { readonly [K in NotificationKind]: NotificationSeverity } = {
  'attention.requested': 'warn',
  'vault.confirm': 'warn',
  'vault.filled': 'info',
  'session.finished': 'info',
  'session.crashed': 'error',
  'session.reaped': 'warn',
  'tool.errors': 'warn',
  'system.degraded': 'error',
  'channel.broken': 'error',
  'digest.daily': 'info',
  'report.anomaly': 'warn',
  test: 'info',
};

/** Generic title per kind: what a `counts`-level channel shows instead of the producer's title. */
export const KIND_LABEL: { readonly [K in NotificationKind]: string } = {
  'attention.requested': 'Attention requested',
  'vault.confirm': 'Vault fill awaiting confirm',
  'vault.filled': 'Vault fill',
  'session.finished': 'Session finished',
  'session.crashed': 'Session crashed',
  'session.reaped': 'Session reaped',
  'tool.errors': 'Tool errors',
  'system.degraded': 'BrowserHive degraded',
  'channel.broken': 'Notification channel failing',
  'digest.daily': 'Daily digest',
  'report.anomaly': 'Something looks off',
  test: 'Test notification',
};

/** Kinds that are delivered in-app only and never enqueued for an external channel (D-34 loop cut). */
export const IN_APP_ONLY_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'channel.broken',
]);

/** Title every crashed-session row has carried since v1; used to tell crashes from tool errors. */
export const SESSION_CRASHED_TITLE = 'Session crashed';

/** In-app type that represents each kind in the inbox (icon, colour, the `type` filter). */
export const KIND_TYPE: { readonly [K in NotificationKind]: NotificationType } = {
  'attention.requested': 'attention',
  'vault.confirm': 'vault',
  'vault.filled': 'vault',
  'session.finished': 'lifecycle',
  'session.crashed': 'error',
  'session.reaped': 'lifecycle',
  'tool.errors': 'error',
  'system.degraded': 'system',
  'channel.broken': 'system',
  'digest.daily': 'lifecycle',
  'report.anomaly': 'system',
  test: 'system',
};

/** What a row from before the contract (or from an older reader) carries. */
export interface LegacyNotificationFacts {
  readonly notificationId: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly groupKey: string | null;
  readonly sessionId: string | null;
  readonly sourceEventId: string | null;
}

/** Classification derived for a legacy row. */
export interface LegacyClassification {
  readonly kind: NotificationKind;
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly state: NotificationState;
  readonly thread: string;
}

/**
 * Classifies a row whose contract columns are NULL, exactly as migration v5 backfills rows (spec 03
 * §7): kind from `type` (an `error` titled "Session crashed" is a crash, any other `error` a tool
 * error group), category and severity from the kind, `open` for tool-error groups and `final`
 * otherwise (the request or degradation a row points at is not consulted here), thread from the ids.
 *
 * @returns The derived classification.
 */
export function classifyLegacy(row: LegacyNotificationFacts): LegacyClassification {
  const kind = legacyKind(row.type, row.title);
  return {
    kind,
    category: KIND_CATEGORY[kind],
    severity: KIND_SEVERITY[kind],
    state: kind === 'tool.errors' ? 'open' : 'final',
    thread: legacyThread(kind, row),
  };
}

function legacyKind(type: NotificationType, title: string): NotificationKind {
  switch (type) {
    case 'attention':
      return 'attention.requested';
    case 'vault':
      return 'vault.confirm';
    case 'lifecycle':
      return 'session.reaped';
    case 'system':
      return 'system.degraded';
    case 'error':
      return title === SESSION_CRASHED_TITLE ? 'session.crashed' : 'tool.errors';
  }
}

function legacyThread(kind: NotificationKind, row: LegacyNotificationFacts): string {
  const own = `notification:${row.notificationId}`;
  switch (kind) {
    case 'attention.requested':
      return row.sourceEventId === null ? own : `attention:${row.sourceEventId}`;
    case 'vault.confirm':
      return row.sourceEventId === null ? own : `vault:${row.sourceEventId}`;
    case 'tool.errors':
      return row.groupKey ?? `tool-errors:${row.sessionId ?? 'none'}`;
    case 'session.crashed':
    case 'session.reaped':
      return row.sessionId === null ? own : `session:${row.sessionId}`;
    case 'system.degraded':
      return row.sourceEventId === null ? own : `system:${row.sourceEventId}`;
    default:
      return own;
  }
}
