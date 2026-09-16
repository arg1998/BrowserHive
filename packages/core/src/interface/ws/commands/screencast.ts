/** @module interface/ws/commands/screencast — `screencast.start/stop/set_size` (spec 03 §6.3, §6.5). */

import {
  type ScreencastSetSizeCommand,
  type ScreencastStartCommand,
  type ScreencastStopCommand,
  screencastTopic,
} from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { WsConnection } from '../connection.ts';
import { DEFAULT_SCREENCAST_SIZE, type LiveFrame, type LiveMeta } from '../live-view.ts';
import type { HubCommandHost } from './host.ts';

/** Viewer id of a connection on a session. */
export function viewerId(conn: WsConnection): string {
  return conn.id;
}

/**
 * Joins (or re-sizes) the session's screencast. The reply and the `started` control go out before
 * any meta or frame for the new ordinal (clients map an ordinal to its topic on `started`), so the
 * initial frame is held until then.
 */
export async function screencastStart(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof ScreencastStartCommand>,
): Promise<void> {
  const sessionId = command.session_id;
  const topic = screencastTopic(sessionId);
  const existing = conn.screencasts.get(sessionId);
  const width = command.max_width ?? DEFAULT_SCREENCAST_SIZE.width;
  const height = command.max_height ?? DEFAULT_SCREENCAST_SIZE.height;
  if (existing !== undefined) {
    await host.liveView.setViewerSize(sessionId, viewerId(conn), width, height);
    host.reply(
      conn,
      { type: 'screencast.started', topic, ordinal: existing.ordinal },
      command.corr,
    );
    return;
  }
  const subscription = { sessionId, ordinal: conn.allocateOrdinal(), seq: 0, pending: undefined };
  const current = () => conn.screencasts.get(sessionId) === subscription;
  let announced = false;
  let heldMeta: LiveMeta | undefined;
  let heldFrame: LiveFrame | undefined;
  const sendMeta = (meta: LiveMeta) =>
    host.stream(conn, topic, {
      type: 'meta',
      session_id: sessionId,
      ordinal: subscription.ordinal,
      device_width: meta.deviceWidth,
      device_height: meta.deviceHeight,
      page_scale: meta.pageScale,
      offset_top: meta.offsetTop,
    });
  conn.screencasts.set(sessionId, subscription);
  try {
    await host.liveView.addViewer(sessionId, {
      id: viewerId(conn),
      maxWidth: width,
      maxHeight: height,
      frame: (frame) => {
        if (!current()) return;
        if (announced) host.sendFrame(conn, sessionId, frame.jpeg, frame.width, frame.height);
        else heldFrame = frame;
      },
      meta: (meta) => {
        if (!current()) return;
        if (announced) sendMeta(meta);
        else heldMeta = meta;
      },
      stopped: (reason) => {
        if (!current()) return;
        conn.screencasts.delete(sessionId);
        host.stream(conn, topic, { type: 'stopped', session_id: sessionId, reason });
      },
      failed: (error) => {
        if (!current()) return;
        conn.screencasts.delete(sessionId);
        host.stream(conn, topic, {
          type: 'failed',
          session_id: sessionId,
          code: error.code,
          message: error.publicMessage,
        });
      },
    });
  } catch (error) {
    if (current()) conn.screencasts.delete(sessionId);
    throw error;
  }
  host.reply(
    conn,
    { type: 'screencast.started', topic, ordinal: subscription.ordinal },
    command.corr,
  );
  host.stream(conn, topic, {
    type: 'started',
    session_id: sessionId,
    ordinal: subscription.ordinal,
  });
  announced = true;
  if (heldMeta !== undefined) sendMeta(heldMeta);
  if (heldFrame !== undefined) {
    host.sendFrame(conn, sessionId, heldFrame.jpeg, heldFrame.width, heldFrame.height);
  }
}

/** Leaves the session's screencast (resolves once live view has released the viewer). */
export async function screencastStop(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof ScreencastStopCommand>,
): Promise<void> {
  const sessionId = command.session_id;
  if (conn.screencasts.delete(sessionId)) {
    await host.liveView.removeViewer(sessionId, viewerId(conn));
    host.stream(conn, screencastTopic(sessionId), {
      type: 'stopped',
      session_id: sessionId,
      reason: 'stopped',
    });
  }
  host.reply(conn, { type: 'ok' }, command.corr);
}

/** Changes this viewer's requested size. */
export async function screencastSetSize(
  host: HubCommandHost,
  conn: WsConnection,
  command: z.output<typeof ScreencastSetSizeCommand>,
): Promise<void> {
  await host.liveView.setViewerSize(
    command.session_id,
    viewerId(conn),
    command.max_width,
    command.max_height,
  );
  host.reply(conn, { type: 'ok' }, command.corr);
}
