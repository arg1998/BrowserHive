/** @module interface/ws/commands/host — what command handlers may do with the hub (implemented by `RealtimeHub`). */

import type { ScreencastControl, WsReplyPayload } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { WsConnection } from '../connection.ts';
import type { LiveView } from '../live-view.ts';

/** Live-view verbs commands call (a structural slice of `LiveView`). */
export type LiveViewPort = Pick<
  LiveView,
  | 'addViewer'
  | 'removeViewer'
  | 'setViewerSize'
  | 'sendInput'
  | 'setViewport'
  | 'hasViewers'
  | 'activeCount'
>;

/** Hub services exposed to command handlers. */
export interface HubCommandHost {
  readonly liveView: LiveViewPort;
  /** The live-view input gate (`AttentionService.isInputPermitted`). */
  isInputPermitted(sessionId: string, command: 'input'): boolean;
  now(): number;
  reply(conn: WsConnection, payload: z.input<typeof WsReplyPayload>, corr?: string): void;
  stream(conn: WsConnection, topic: string, payload: z.input<typeof ScreencastControl>): void;
  /** Subscribes with optional replay; sends the `subscribed` reply (or `resync_required`). */
  subscribe(conn: WsConnection, topic: string, cursor: number | undefined, corr?: string): void;
  unsubscribe(conn: WsConnection, topic: string, corr?: string): void;
  /** Sends one screencast frame to `conn` (latest-wins, droppable). */
  sendFrame(
    conn: WsConnection,
    sessionId: string,
    jpeg: Uint8Array<ArrayBuffer>,
    width: number,
    height: number,
  ): void;
}
