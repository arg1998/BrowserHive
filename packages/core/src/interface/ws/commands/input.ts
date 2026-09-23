/** @module interface/ws/commands/input — operator `input` (attention-gated per message) and `session.set_viewport` (never gated, D-10). */

import type { InputCommand, SetViewportCommand } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import { AppError } from '../../../kernel/errors/app-error.ts';
import type { WsConnection } from '../connection.ts';
import type { HubCommandHost } from './host.ts';

/**
 * Forwards one input to the page via CDP. The gate is re-checked on every message: without an open
 * takeover attention request the answer is `error INPUT_NOT_PERMITTED` and the socket stays up.
 */
export async function input(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof InputCommand>,
): Promise<void> {
  if (!host.isInputPermitted(command.session_id, 'input')) {
    throw new AppError(
      'INPUT_NOT_PERMITTED',
      { session_id: command.session_id },
      {
        publicMessage: `Input is not permitted on session '${command.session_id}': no takeover attention request is open.`,
      },
    );
  }
  await host.liveView.sendInput(command.session_id, command.input, {
    principalId: conn.principal.subject,
    via: 'ws',
  });
  host.reply(conn, { type: 'ok' }, command.corr);
}

/** Resizes the viewport. Deliberately NOT attention-gated: it is an observability control (D-10). */
export async function setViewport(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof SetViewportCommand>,
): Promise<void> {
  const size = await host.liveView.setViewport(command.session_id, command.width, command.height);
  host.reply(conn, { type: 'ok', result: size }, command.corr);
}
