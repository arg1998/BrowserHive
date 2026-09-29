/** @module app/notifications/report-settings — the in-app reports (D-45, spec 03 §9.7): the dashboard's own digest schedule and anomaly switch, server-wide, kept in `notification_cursors['settings:in-app-reports']`; read once at start, validated on every write, and announced to the scheduler on change. */

import { checkReportRules, ReportSettings } from '@browserhive/contracts/notifications';
import { AppError } from '../../kernel/errors/app-error.ts';
import type { NotificationCursorRepository } from '../../ports/persistence/notification-actions.ts';

/** Where the in-app report settings are kept. */
export const REPORT_SETTINGS_KEY = 'settings:in-app-reports';

/** Whether the settings schedule anything (a digest or the anomaly alerts). */
export function schedulesReports(settings: ReportSettings): boolean {
  return settings.digest !== undefined || settings.anomaly !== undefined;
}

/**
 * The in-app report settings: `{}` (off) until saved. A stored value that no longer validates is
 * read as off rather than failing the start.
 */
export class ReportSettingsStore {
  private value: ReportSettings = {};
  private readonly listeners = new Set<() => void>();

  constructor(private readonly cursors: NotificationCursorRepository) {}

  /** Reads the stored settings (at start). */
  async load(): Promise<void> {
    const raw = await this.cursors.get(REPORT_SETTINGS_KEY);
    if (raw === null) return;
    try {
      const parsed = ReportSettings.safeParse(JSON.parse(raw));
      this.value = parsed.success ? parsed.data : {};
    } catch {
      this.value = {};
    }
  }

  /** The current settings. */
  current(): ReportSettings {
    return this.value;
  }

  /**
   * Validates and stores new settings, then tells the listeners (the scheduler re-arms).
   *
   * @throws AppError `VALIDATION_FAILED` for an unknown zone or a rule that mixes daily and weekly
   *   options.
   */
  async save(settings: ReportSettings, now: number): Promise<ReportSettings> {
    const problems = checkReportRules(settings);
    if (problems.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        issues: problems.map((p) => ({
          path: `settings.${p.field}`,
          message: p.message,
          code: 'custom',
        })),
      });
    }
    const clean = ReportSettings.parse(settings);
    await this.cursors.set(REPORT_SETTINGS_KEY, JSON.stringify(clean), now);
    this.value = clean;
    for (const listener of this.listeners) listener();
    return clean;
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
