/** @module composition/notification-snapshots — `NotificationSnapshots` over the live sessions (D-36, spec 03 §9.5): a JPEG of the active page (form fields masked on request) or a crashed session's last stored screenshot, kept in the notification image store; never while the session's secret window is open. */

import type {
  CapturedImage,
  NotificationImageStore,
  NotificationSnapshots,
} from '@browserhive/core/ports/notification-channel';
import type { ScreenshotRepository } from '@browserhive/core/ports/persistence/screenshots';
import { type Logger, serializeError } from '@browserhive/core/runtime';
import type { SessionService } from '@browserhive/core/server';

/** JPEG quality of notification screenshots. */
export const SNAPSHOT_QUALITY = 70;
/** Longest wait for Playwright's screenshot. */
const SNAPSHOT_TIMEOUT_MS = 3_000;
/** What `mask_images` blacks out. */
export const MASK_SELECTOR =
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

async function readWithBun(path: string): Promise<Uint8Array | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * The screenshot seam of the notification service. Every method returns `null` instead of
 * throwing.
 *
 * @returns The snapshots port.
 */
export function createNotificationSnapshots(
  deps: NotificationSnapshotsDeps,
): NotificationSnapshots {
  const log = deps.logger.child({ module: 'notifications' });
  const readFile = deps.readFile ?? readWithBun;
  return {
    async capture(sessionId, options): Promise<CapturedImage | null> {
      if (deps.secretWindowOpen(sessionId)) return null;
      const session = deps.sessions.peek(sessionId);
      if (session === undefined) return null;
      try {
        const page = deps.sessions.page(session);
        const bytes = await page.screenshot({
          type: 'jpeg',
          quality: SNAPSHOT_QUALITY,
          scale: 'css',
          timeout: SNAPSHOT_TIMEOUT_MS,
          ...(options.masked && {
            mask: [page.locator(MASK_SELECTOR)],
            maskColor: '#1f2937',
          }),
        });
        // A fill that started while the capture ran: drop the frame (D-36).
        if (deps.secretWindowOpen(sessionId)) return null;
        const ref = await deps.images.put({
          bytes: new Uint8Array(bytes),
          contentType: 'image/jpeg',
          filename: 'screenshot.jpg',
        });
        return { ref, capturedAt: deps.now() };
      } catch (err) {
        log.debug('snapshot skipped', { session_id: sessionId, err: serializeError(err) });
        return null;
      }
    },
    async lastFrame(sessionId): Promise<CapturedImage | null> {
      try {
        const page = await deps.screenshots.listBySession(sessionId, { limit: 1 });
        const row = page.items[0];
        if (row === undefined) return null;
        const bytes = await readFile(row.path);
        if (bytes === null) return null;
        const extension = row.contentType === 'image/png' ? 'png' : 'jpg';
        const ref = await deps.images.put({
          bytes,
          contentType: row.contentType,
          filename: `last-screenshot.${extension}`,
        });
        return { ref, capturedAt: row.ts };
      } catch {
        return null;
      }
    },
  };
}
