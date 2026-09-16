/** @module interface/ws/commands/subscribe — `subscribe`, `unsubscribe`, `logs.tail`, `ping` (spec 03 §6.3). */

import type {
  LogsTailCommand,
  PingCommand,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { WsConnection } from '../connection.ts';
import type { HubCommandHost } from './host.ts';

/** Attach to a topic (scope checked by the dispatcher), replaying from `cursor`. */
export function subscribe(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof SubscribeCommand>,
): void {
  host.subscribe(conn, command.topic, command.cursor, command.corr);
}

/** Detach from a topic. */
export function unsubscribe(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof UnsubscribeCommand>,
): void {
  host.unsubscribe(conn, command.topic, command.corr);
}

/** Subscribe to `logs` with a server-side filter. */
export function logsTail(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof LogsTailCommand>,
): void {
  conn.logsFilter = {
    ...(command.level !== undefined && { level: command.level }),
    ...(command.module !== undefined && { module: command.module }),
  };
  host.subscribe(conn, 'logs', undefined, command.corr);
}

/** Heartbeat. */
export function ping(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof PingCommand>,
): void {
  host.reply(conn, { type: 'pong', ts: host.now() }, command.corr);
}
