/** @module interface/http/routes/notifications — notifications inbox and operator preferences (spec 03 §4.8, D-16). */

import {
  NotificationAckResponse,
  NotificationIdParams,
  NotificationsPage,
  NotificationsQuery,
  NotificationsUpdatedResponse,
  PREFERENCES_MAX_BYTES,
  Preferences,
  PreferencesResponse,
  PutPreferencesRequest,
  PutPreferencesResponse,
  PutReportSettingsRequest,
  REPORTS_IN_APP_ONLY,
  ReportDetailResponse,
  ReportIdParams,
  ReportSettingsResponse,
  ReportsPage,
  ReportsQuery,
} from '@browserhive/contracts/http';
import { AppError } from '../../../kernel/errors/app-error.ts';
import { defineRoute, reply } from '../define-route.ts';
import { envelope, pagingOf } from '../serializers/page.ts';
import { notificationToWire } from '../serializers/system.ts';
import { requirePrincipal } from './common.ts';

const tags = ['notifications'];

/** Notification and preference routes. */
export const NOTIFICATION_ROUTES = [
  defineRoute({
    operationId: 'listReports',
    tags,
    summary:
      'Reports in BrowserHive: the in-app copies of digests and anomaly alerts, newest first.',
    request: { query: ReportsQuery },
    responses: { 200: ReportsPage },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const page = await services.reports.list({
        ...pagingOf(q),
        ...(q.kind !== undefined && { kinds: q.kind }),
        ...(q.channel !== undefined &&
          (q.channel === REPORTS_IN_APP_ONLY ? { inAppOnly: true } : { channelId: q.channel })),
        ...(q.since !== undefined && { since: q.since }),
        ...(q.until !== undefined && { until: q.until }),
      });
      return reply(
        200,
        envelope(page, (item) => item, { ...q, sort: 'created_at' }, ctx.now, 'created_at'),
      );
    },
  }),
  defineRoute({
    operationId: 'getReport',
    tags,
    summary: 'One report with its message and the channels it reached.',
    request: { params: ReportIdParams },
    responses: { 200: ReportDetailResponse },
    errors: ['REPORT_NOT_FOUND'],
    async handler({ input, services }) {
      return reply(200, await services.reports.get(input.params.notification_id));
    },
  }),
  defineRoute({
    operationId: 'getReportSettings',
    tags,
    summary: 'The in-app reports: the digest schedule and the anomaly switch (D-45).',
    request: {},
    responses: { 200: ReportSettingsResponse },
    async handler({ services }) {
      return reply(200, services.reports.settings());
    },
  }),
  defineRoute({
    operationId: 'putReportSettings',
    tags,
    summary: 'Replaces the in-app reports settings; a changed schedule re-arms from now.',
    request: { body: PutReportSettingsRequest },
    responses: { 200: ReportSettingsResponse },
    async handler({ input, services }) {
      return reply(200, await services.reports.saveSettings(input.body.settings));
    },
  }),
  defineRoute({
    operationId: 'listNotifications',
    tags,
    summary: 'Notifications newest first with the unread count.',
    request: { query: NotificationsQuery },
    responses: { 200: NotificationsPage },
    async handler({ input, services, ctx }) {
      const q = input.query;
      const [page, unread] = await Promise.all([
        services.notifications.list({
          ...pagingOf(q),
          read: q.read,
          sort: q.sort,
          ...(q.type !== undefined && { types: q.type }),
          ...(q.category !== undefined && { categories: q.category }),
          ...(q.since !== undefined && { since: q.since }),
          ...(q.until !== undefined && { until: q.until }),
        }),
        services.notifications.unreadCount(),
      ]);
      const body = envelope(page, notificationToWire, q, ctx.now, 'updated_at');
      return reply(200, { ...body, unread_count: unread });
    },
  }),
  defineRoute({
    operationId: 'markNotificationRead',
    tags,
    summary: 'Mark one notification read.',
    request: { params: NotificationIdParams },
    responses: { 200: NotificationAckResponse },
    async handler({ input, services }) {
      await services.notifications.markRead(input.params.notification_id);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'markAllNotificationsRead',
    tags,
    summary: 'Mark every notification read.',
    request: {},
    responses: { 200: NotificationsUpdatedResponse },
    async handler({ services }) {
      return reply(200, { ok: true, updated: await services.notifications.markAllRead() });
    },
  }),
  defineRoute({
    operationId: 'dismissNotification',
    tags,
    summary: 'Dismiss one notification.',
    request: { params: NotificationIdParams },
    responses: { 200: NotificationAckResponse },
    async handler({ input, services }) {
      await services.notifications.dismiss(input.params.notification_id);
      return reply(200, { ok: true });
    },
  }),
  defineRoute({
    operationId: 'dismissAllNotifications',
    tags,
    summary: 'Dismiss every notification.',
    request: {},
    responses: { 200: NotificationsUpdatedResponse },
    async handler({ services }) {
      return reply(200, { ok: true, updated: await services.notifications.dismissAll() });
    },
  }),
  defineRoute({
    operationId: 'getPreferences',
    tags: ['preferences'],
    summary: "The caller's stored preferences (known keys only).",
    request: {},
    responses: { 200: PreferencesResponse },
    async handler({ principal, services }) {
      const stored = await services.preferences.list(requirePrincipal(principal).subject);
      const known = Preferences.safeParse(stored.preferences);
      return reply(200, {
        preferences: known.success ? known.data : {},
        updated_at: stored.updatedAt,
      });
    },
  }),
  defineRoute({
    operationId: 'putPreferences',
    tags: ['preferences'],
    summary: 'Replace the preferences document (≤ 64 KiB; unknown keys rejected).',
    request: { body: PutPreferencesRequest },
    responses: { 200: PutPreferencesResponse },
    bodyLimitBytes: PREFERENCES_MAX_BYTES + 1024,
    errors: ['PAYLOAD_TOO_LARGE'],
    async handler({ input, principal, services }) {
      const size = new TextEncoder().encode(JSON.stringify(input.body.preferences)).byteLength;
      if (size > PREFERENCES_MAX_BYTES) {
        throw new AppError('PAYLOAD_TOO_LARGE', { limit_bytes: PREFERENCES_MAX_BYTES });
      }
      const result = await services.preferences.replaceAll(
        requirePrincipal(principal).subject,
        input.body.preferences,
      );
      return reply(200, { ok: true, updated_at: result.updatedAt });
    },
  }),
];
