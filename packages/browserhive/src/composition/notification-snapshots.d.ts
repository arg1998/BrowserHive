/** @module composition/notification-snapshots — `NotificationSnapshots` over the live sessions (D-36, spec 03 §9.5): a JPEG of the active page (form fields masked on request) or a crashed session's last stored screenshot, kept in the notification image store; never while the session's secret window is open. */
import type {
  NotificationImageStore,
  NotificationSnapshots,
} from '@browserhive/core/ports/notification-channel';
import type { ScreenshotRepository } from '@browserhive/core/ports/persistence/screenshots';
import { type Logger } from '@browserhive/core/runtime';
import type { SessionService } from '@browserhive/core/server';
/** JPEG quality of notification screenshots. */
export declare const SNAPSHOT_QUALITY = 70;
/** What `mask_images` blacks out. */
export declare const MASK_SELECTOR =
  'input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
/** Dependencies of {@link createNotificationSnapshots}. */
export interface NotificationSnapshotsDeps {
  readonly sessions: Pick<SessionService, 'peek' | 'page'>;
  readonly screenshots: ScreenshotRepository;
  readonly images: NotificationImageStore;
  /** Whether the session's vault secret window is open (`SecretRegistry.isWindowOpen`). */
  readonly secretWindowOpen: (sessionId: string) => boolean;
  readonly now: () => number;
  readonly logger: Logger;
  /** Reads a stored screenshot file (default `Bun.file`). */
  readonly readFile?: (path: string) => Promise<Uint8Array | null>;
}
/**
 * The screenshot seam of the notification service. Every method returns `null` instead of
 * throwing.
 *
 * @returns The snapshots port.
 */
export declare function createNotificationSnapshots(
  deps: NotificationSnapshotsDeps,
): NotificationSnapshots;
//# sourceMappingURL=notification-snapshots.d.ts.map
