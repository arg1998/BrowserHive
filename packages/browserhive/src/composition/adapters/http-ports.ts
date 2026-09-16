/** @module composition/adapters/http-ports — adapts app services onto the structural ports `interface/http/services.ts` expects (blocklist, notifications, preferences, runtime log level). */

import type { NotificationRepository, RootLogger } from '@browserhive/core/runtime';
import { AppError, formatLevelSpec, parseLevelSpec } from '@browserhive/core/runtime';
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
export function blocklistPort(service: BlocklistService, path: string | null): BlocklistPort {
  return {
    get configured() {
      return service.configured;
    },
    path,
    patterns: () => service.holder.current().entries,
    skipped: () => service.stats().skipped,
    loadedAt: () => service.stats().loadedAt,
    reload: () => service.reload(),
  };
}

/**
 * `NotificationService` → `NotificationsPort`. Lists read the repository (the route serializes
 * records itself); every other verb goes through the service so `notification.*` events publish.
 * Produced notifications land in the anonymous inbox (`principal_id = null`), so every count and
 * bulk verb uses that inbox too.
 */
export function notificationsPort(
  service: NotificationService,
  repo: NotificationRepository,
): NotificationsPort {
  return {
    list: (query) => repo.list({ principalId: null, ...query }),
    unreadCount: () => service.unreadCount(null),
    markRead: async (id) => (await service.markRead(id)) !== null,
    markAllRead: () => service.markAllRead(null),
    dismiss: async (id) => (await service.dismiss(id)) !== null,
    dismissAll: () => service.dismissAll(null),
  };
}

/** `PreferenceService` → `PreferencesPort` (`updatedAt` is never null after a write). */
export function preferencesPort(service: PreferenceService, now: () => number): PreferencesPort {
  return {
    list: (principal) => service.list(principal),
    replaceAll: async (principal, values) => {
      const doc = await service.replaceAll(principal, values);
      return { updatedAt: doc.updatedAt ?? now() };
    },
  };
}

/** Runtime `PATCH /system/log-level`: parses a level spec, applies it, returns the normalised spec. */
export function logLevelController(
  logger: Pick<RootLogger, 'setLevel' | 'getLevel'>,
  knownModules: readonly string[],
): LogLevelController {
  return {
    set(spec) {
      const parsed = parseLevelSpec(spec);
      if (!parsed.ok) {
        throw new AppError(
          'VALIDATION_FAILED',
          { issues: [{ path: 'spec', message: parsed.error, code: 'invalid_level_spec' }] },
          { publicMessage: parsed.error },
        );
      }
      const unknown = Object.keys(parsed.value.modules).filter((m) => !knownModules.includes(m));
      if (unknown.length > 0) {
        const message = `unknown log module(s): ${unknown.join(', ')}`;
        throw new AppError(
          'VALIDATION_FAILED',
          { issues: [{ path: 'spec', message, code: 'unknown_module' }] },
          { publicMessage: message },
        );
      }
      logger.setLevel(parsed.value);
      return formatLevelSpec(logger.getLevel());
    },
  };
}
