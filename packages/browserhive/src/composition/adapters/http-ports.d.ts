/** @module composition/adapters/http-ports — adapts app services onto the structural ports `interface/http/services.ts` expects (blocklist, notifications, preferences, runtime log level). */
import type { NotificationRepository, RootLogger } from '@browserhive/core/runtime';
import type {
  BlocklistPort,
  BlocklistService,
  LogLevelController,
  NotificationService,
  NotificationsPort,
  PreferenceService,
  PreferencesPort,
} from '@browserhive/core/server';
/** `BlocklistService` → `BlocklistPort` (patterns from the live holder, skipped/loadedAt from stats). */
export declare function blocklistPort(
  service: BlocklistService,
  path: string | null,
): BlocklistPort;
/**
 * `NotificationService` → `NotificationsPort`. Lists read the repository (the route serializes
 * records itself); every other verb goes through the service so `notification.*` events publish.
 * Produced notifications land in the anonymous inbox (`principal_id = null`), so every count and
 * bulk verb uses that inbox too.
 */
export declare function notificationsPort(
  service: NotificationService,
  repo: NotificationRepository,
): NotificationsPort;
/** `PreferenceService` → `PreferencesPort` (`updatedAt` is never null after a write). */
export declare function preferencesPort(
  service: PreferenceService,
  now: () => number,
): PreferencesPort;
/** Runtime `PATCH /system/log-level`: parses a level spec, applies it, returns the normalised spec. */
export declare function logLevelController(
  logger: Pick<RootLogger, 'setLevel' | 'getLevel'>,
  knownModules: readonly string[],
): LogLevelController;
//# sourceMappingURL=http-ports.d.ts.map
