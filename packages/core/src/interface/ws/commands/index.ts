/** @module interface/ws/commands — the dispatch table: command type → scope → handler (spec 03 §6.3). */

import { WS_COMMAND_SCOPES, type WsClientCommand } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import { assertNever } from '../../../kernel/errors/app-error.ts';
import type { WsConnection } from '../connection.ts';
import type { HubCommandHost } from './host.ts';
import { input, setViewport } from './input.ts';
import { screencastSetSize, screencastStart, screencastStop } from './screencast.ts';
import { logsTail, ping, subscribe, unsubscribe } from './subscribe.ts';

export type { HubCommandHost, LiveViewPort } from './host.ts';

/** The scope a command needs (`null` = any authenticated principal). */
export function commandScope(command: z.output<typeof WsClientCommand>) {
  return WS_COMMAND_SCOPES[command.type];
}

/** Runs one validated, authorized command. */
export async function runCommand(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof WsClientCommand>,
): Promise<void> {
  switch (command.type) {
    case 'ping':
      return ping(host, conn, command);
    case 'subscribe':
      return subscribe(host, conn, command);
    case 'unsubscribe':
      return unsubscribe(host, conn, command);
    case 'logs.tail':
      return logsTail(host, conn, command);
    case 'screencast.start':
      return screencastStart(host, conn, command);
    case 'screencast.stop':
      return screencastStop(host, conn, command);
    case 'screencast.set_size':
      return screencastSetSize(host, conn, command);
    case 'input':
      return input(host, conn, command);
    case 'session.set_viewport':
      return setViewport(host, conn, command);
    default:
      return assertNever(command);
  }
}
