/** @module contracts/http/reports — reports in the dashboard (D-45, spec 03 §4.8): the history of in-app report copies, one report, and the in-app report settings */
import { z } from 'zod';
import { NotificationDeliveryStatus } from '../enums/index.ts';
import { NotificationId } from '../ids/index.ts';
import { ReportSettings } from '../notifications/channel.ts';
import { NotificationMessage, NotificationReport } from '../notifications/message.ts';
import { ChannelId, ChannelReports } from './channels.ts';
import { Cursor, csv, limitQuery, page, QueryBool, windowQuery } from './common.ts';
import { Notification } from './notifications.ts';

/** The report kinds (D-43, D-44). */
export const ReportKind = z.enum(['digest.daily', 'digest.weekly', 'report.anomaly']);
/** A report kind. */
export type ReportKind = z.infer<typeof ReportKind>;

/** `channel` filter value for reports that reached no external channel. */
export const REPORTS_IN_APP_ONLY = 'in-app';

/** `GET /notifications/reports` query. */
export const ReportsQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: limitQuery(200, 50),
  total: QueryBool.default(false),
  kind: csv(ReportKind),
  /** A channel id (reports with a delivery to it), or `in-app` (reports that reached no channel). */
  channel: z.union([ChannelId, z.literal(REPORTS_IN_APP_ONLY)]).optional(),
  ...windowQuery,
});
/** `GET /notifications/reports` query. */
export type ReportsQuery = z.infer<typeof ReportsQuery>;

/** A channel a report reached, with the latest status of its delivery. */
export const ReportChannel = z.object({
  channel_id: z.string(),
  name: z.string(),
  kind: z.string(),
  status: NotificationDeliveryStatus,
  /** Suppression or failure reason of that status, or `null`. */
  reason: z.string().nullable(),
});
/** A channel a report reached. */
export type ReportChannel = z.infer<typeof ReportChannel>;

/** One report of the history: its in-app copy, its window and the channels it reached. */
export const ReportItem = z.object({
  notification: Notification,
  /** Window, zone, late and on-demand markers; `null` for a row without a stored message. */
  report: NotificationReport.nullable(),
  channels: z.array(ReportChannel),
});
/** One report of the history. */
export type ReportItem = z.infer<typeof ReportItem>;

/** `GET /notifications/reports` body. */
export const ReportsPage = page(ReportItem);
/** `GET /notifications/reports` body. */
export type ReportsPage = z.infer<typeof ReportsPage>;

/** Path params `{notification_id}` of a report. */
export const ReportIdParams = z.strictObject({ notification_id: NotificationId });
/** Path params of a report. */
export type ReportIdParams = z.infer<typeof ReportIdParams>;

/** `GET /notifications/reports/{notification_id}` body. */
export const ReportDetailResponse = z.object({
  report: ReportItem,
  /** The in-app copy's current message (`full` level). */
  message: NotificationMessage,
});
/** One report. */
export type ReportDetailResponse = z.infer<typeof ReportDetailResponse>;

/** `GET`/`PUT /notifications/report-settings` body. */
export const ReportSettingsResponse = z.object({
  settings: ReportSettings,
  /** The zone the in-app reports use without `time_zone`. */
  host_time_zone: z.string(),
  /** The next digest, the anomaly check and its active checks, as a channel's view shows them. */
  reports: ChannelReports,
});
/** The in-app report settings. */
export type ReportSettingsResponse = z.infer<typeof ReportSettingsResponse>;

/** `PUT /notifications/report-settings` body. */
export const PutReportSettingsRequest = z.strictObject({ settings: ReportSettings });
/** `PUT /notifications/report-settings` body. */
export type PutReportSettingsRequest = z.infer<typeof PutReportSettingsRequest>;
