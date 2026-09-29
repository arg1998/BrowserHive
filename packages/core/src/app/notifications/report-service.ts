/** @module app/notifications/report-service — reports in the dashboard (D-45, spec 03 §4.8): the history of in-app report copies with the channels each reached, one report with its message, and the in-app report settings with their schedule view. */

import type {
  ReportChannel,
  ReportDetailResponse,
  ReportItem,
  ReportSettingsResponse,
} from '@browserhive/contracts/http';
import {
  type NotificationMessage,
  NotificationReport,
  type ReportSettings,
} from '@browserhive/contracts/notifications';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { Clock } from '../../ports/clock.ts';
import type {
  NotificationRepository,
  ReportChannelRow,
} from '../../ports/persistence/notifications.ts';
import type { Page, ReportListQuery } from '../../ports/persistence/queries.ts';
import type { NotificationRecord } from '../../ports/persistence/records.ts';
import { decodeMessage } from './message.ts';
import { toNotification } from './notification-service.ts';
import { IN_APP_REPORT_THREAD, type ReportScheduler } from './report-scheduler.ts';
import type { ReportSettingsStore } from './report-settings.ts';

/** Dependencies of {@link ReportService}. */
export interface ReportServiceDeps {
  readonly repo: Pick<NotificationRepository, 'listReports' | 'reportChannels' | 'get'>;
  readonly settings: Pick<ReportSettingsStore, 'current' | 'save'>;
  readonly scheduler: Pick<ReportScheduler, 'inAppView' | 'hostTimeZone'>;
  readonly clock: Clock;
}

/** Whether a row is an in-app report copy (D-45). */
export function isInAppReport(record: NotificationRecord): boolean {
  return record.category === 'reports' && (record.thread ?? '').startsWith(IN_APP_REPORT_THREAD);
}

function channelOf(row: ReportChannelRow): ReportChannel {
  return {
    channel_id: row.channelId,
    name: row.name,
    kind: row.kind,
    status: row.status as ReportChannel['status'],
    reason: row.reason,
  };
}

function messageOf(record: NotificationRecord): NotificationMessage | null {
  return decodeMessage(record.messageJson);
}

function reportOf(message: NotificationMessage | null): ReportItem['report'] {
  if (message?.report === undefined) return null;
  const parsed = NotificationReport.safeParse(message.report);
  return parsed.success ? parsed.data : null;
}

/** The Reports tab's reads and the in-app settings. */
export class ReportService {
  constructor(private readonly deps: ReportServiceDeps) {}

  /**
   * One page of the history.
   *
   * @returns Wire items, newest first.
   */
  async list(query: ReportListQuery): Promise<Page<ReportItem>> {
    const page = await this.deps.repo.listReports(query);
    const channels = await this.deps.repo.reportChannels(page.items.map((r) => r.notificationId));
    return {
      ...page,
      items: page.items.map((record) => this.item(record, channels.get(record.notificationId))),
    };
  }

  /**
   * One report with its current message.
   *
   * @throws AppError `REPORT_NOT_FOUND` for an unknown id or a row that is not an in-app copy.
   */
  async get(notificationId: string): Promise<ReportDetailResponse> {
    const record = await this.deps.repo.get(notificationId);
    const message = record === null ? null : messageOf(record);
    if (record === null || !isInAppReport(record) || message === null) {
      throw new AppError('REPORT_NOT_FOUND', { notification_id: notificationId });
    }
    const channels = await this.deps.repo.reportChannels([notificationId]);
    return { report: this.item(record, channels.get(notificationId), message), message };
  }

  /** The in-app settings with their schedule view. */
  settings(): ReportSettingsResponse {
    return this.view(this.deps.settings.current());
  }

  /**
   * Stores new in-app settings (the scheduler re-arms from now).
   *
   * @returns The stored settings with their view.
   */
  async saveSettings(settings: ReportSettings): Promise<ReportSettingsResponse> {
    const saved = await this.deps.settings.save(settings, this.deps.clock.now());
    return this.view(saved);
  }

  private view(settings: ReportSettings): ReportSettingsResponse {
    return {
      settings,
      host_time_zone: this.deps.scheduler.hostTimeZone(),
      reports: this.deps.scheduler.inAppView(settings),
    };
  }

  private item(
    record: NotificationRecord,
    channels: readonly ReportChannelRow[] | undefined,
    message: NotificationMessage | null = messageOf(record),
  ): ReportItem {
    return {
      notification: toNotification(record),
      report: reportOf(message),
      channels: (channels ?? []).map(channelOf),
    };
  }
}
