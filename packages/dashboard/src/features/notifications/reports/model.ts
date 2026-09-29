/** @module features/notifications/reports/model — the Reports tab's pure helpers (D-45): kind labels, the window in its zone, the anomaly alert's outcome pill, the Overview period of a report and the words for a channel's delivery */
import type { Notification, ReportItem } from '@browserhive/contracts/http';
import type { NotificationMessage } from '@browserhive/contracts/notifications';
import type { StatusEntry } from '@/lib/status-registry.ts';
import { formatInZone, zoneLabel } from '../channels/model.ts';

const HOUR = 3_600_000;

/** Kinds in the order the filter shows them, with their labels. */
export const REPORT_KINDS = [
  { value: 'digest.daily', label: 'Daily digest' },
  { value: 'digest.weekly', label: 'Weekly digest' },
  { value: 'report.anomaly', label: 'Anomaly alert' },
] as const;

/** The label of a report kind. */
export function reportKindLabel(kind: string): string {
  return REPORT_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** Whether a notification is a digest (never toasts, arrives read). */
export function isDigestKind(kind: string): boolean {
  return kind === 'digest.daily' || kind === 'digest.weekly';
}

/**
 * The window of a report in its zone: `Mon 28 Sep, 09:00 → Tue 29 Sep, 09:00 · Europe/Berlin`.
 *
 * @returns The text, or `null` without a report.
 */
export function reportWindowText(report: ReportItem['report']): string | null {
  if (report === null) return null;
  const { since, until } = report.window;
  return `${formatInZone(since, report.time_zone)} → ${formatInZone(until, report.time_zone)} · ${zoneLabel(report.time_zone)}`;
}

/**
 * The pill of an anomaly alert: active while open, back to normal once resolved, closed when it
 * was superseded or no longer checked. Digests have none.
 *
 * @returns The entry, or `null`.
 */
export function anomalyOutcome(n: Pick<Notification, 'kind' | 'state'>): StatusEntry | null {
  if (n.kind !== 'report.anomaly') return null;
  if (n.state === 'open') return { label: 'active', tone: 'warn' };
  if (n.state === 'resolved') return { label: 'back to normal', tone: 'success' };
  return { label: 'closed', tone: 'muted' };
}

/**
 * The period "Open Overview for this period" opens: a digest's window; for an anomaly alert, from
 * the start of the hour it first checked to its latest update.
 *
 * @returns Epoch-ms bounds, or `null` without a report.
 */
export function overviewPeriod(
  n: Pick<Notification, 'kind' | 'created_at'>,
  message: Pick<NotificationMessage, 'report' | 'at'>,
): { readonly since: number; readonly until: number } | null {
  const report = message.report;
  if (report === undefined) return null;
  if (n.kind !== 'report.anomaly') return report.window;
  return {
    since: Math.min(report.window.since, n.created_at - HOUR),
    until: Math.max(report.window.until, message.at.updated),
  };
}

/** A channel's delivery of a report in words, for the "Sent to" list. */
export function deliveryWords(status: string, reason: string | null): string {
  switch (status) {
    case 'sent':
    case 'superseded':
      return 'sent';
    case 'pending':
    case 'sending':
    case 'retrying':
      return 'sending';
    case 'dead':
      return 'failed';
    case 'suppressed':
      return reason === 'empty'
        ? 'not sent: nothing happened'
        : reason === 'channel_paused'
          ? 'not sent: paused'
          : 'not sent';
    default:
      return status;
  }
}

/** Whether a delivery status reads as a problem. */
export function deliveryFailed(status: string): boolean {
  return status === 'dead';
}
