/** @module composition/phases/domain-notifications — the notification parts the build-domain phase assembles before the notification service (D-34, D-41): the screenshot store and its prune timer, the shared Telegram poller and Discord gateway, and the act-button executors of attention and vault requests. */

import { join } from 'node:path';
import type { ServerConfig } from '@browserhive/contracts/config';
import {
  type CursorStore,
  createNotificationImageStore,
  DiscordGatewayHub,
  TelegramUpdatesHub,
} from '@browserhive/core/notifications';
import type { Clock, IdGenerator, Logger, Repositories } from '@browserhive/core/runtime';
import { serializeError } from '@browserhive/core/runtime';
import type { ActionExecutor } from '@browserhive/core/server';
import { asyncTick, type createTimers } from '../adapters/timers.ts';
import type { OperatorsParts } from './domain-operators.ts';

/** Notification screenshots are kept this long (retries last at most 24 h, D-34). */
export const IMAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How often old notification screenshots are pruned. */
export const IMAGE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** What {@link notificationParts} needs. */
export interface NotificationPartsInput {
  readonly config: Readonly<ServerConfig>;
  readonly repos: Repositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly operators: Pick<OperatorsParts, 'attention' | 'vault'>;
  readonly timers: ReturnType<typeof createTimers>;
  readonly undo: (() => void | Promise<void>)[];
}

/** The parts; the hubs and the prune timer stop on `undo` and with the phase. */
export function notificationParts(input: NotificationPartsInput) {
  const { config, repos, clock, ids, logger, operators, timers, undo } = input;
  const images = createNotificationImageStore(join(config.dataDir, 'notifications', 'images'));
  const instanceId = ids.opaque(16);
  // Act buttons (D-41): one Telegram poller and one Discord gateway connection per bot token,
  // shared by that bot's channels and its setup flow; their offsets live in notification_cursors.
  const cursors: CursorStore = {
    get: (key) => repos.notificationCursors.get(key),
    set: (key, value) => repos.notificationCursors.set(key, value, clock.now()),
  };
  const telegramUpdates = new TelegramUpdatesHub({ cursors, logger });
  const discordGateway = new DiscordGatewayHub({ logger });
  undo.push(() => {
    telegramUpdates.stop();
    discordGateway.stop();
  });
  // What an act-button press runs: the services behind the dashboard's resolve routes.
  const actionExecutors = new Map<string, ActionExecutor>();
  const attention = operators.attention;
  if (attention !== null) {
    actionExecutors.set('attention.resolve', {
      scope: 'attention:resolve',
      async run(args, actor) {
        const id = String(args['request_id'] ?? '');
        if (args['decision'] === 'reject') {
          await attention.reject(id, actor);
          return 'Rejected. The agent was told.';
        }
        await attention.resolve(id, actor);
        return 'Marked resolved. The agent continues.';
      },
    });
  }
  actionExecutors.set('vault.confirm.resolve', {
    scope: 'vault:confirm',
    async run(args, actor) {
      const id = String(args['request_id'] ?? '');
      const approve = args['decision'] === 'approve';
      await operators.vault.resolveConfirm(id, approve ? 'approve' : 'deny', actor);
      return approve ? 'Approved. The fill goes ahead.' : 'Denied. Nothing was filled.';
    },
  });
  const stopImagePrune = timers.every(
    asyncTick(
      async () => {
        await images.prune(clock.now() - IMAGE_KEEP_MS);
      },
      (err) => logger.warn('image prune failed', { err: serializeError(err) }),
    ),
    IMAGE_PRUNE_INTERVAL_MS,
  );
  undo.push(stopImagePrune);
  return {
    images,
    instanceId,
    cursors,
    telegramUpdates,
    discordGateway,
    actionExecutors,
    stopImagePrune,
  };
}
