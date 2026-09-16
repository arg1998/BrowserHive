/** @module interface/ws/upgrade — `GET /api/v1/ws`: subprotocol + auth at upgrade, close codes after upgrade, and the Bun `websocket` handler (spec 03 §6.1). */

import { WS_CLOSE, WS_SUBPROTOCOL } from '@browserhive/contracts/ws';
import type { Authenticator } from '../../app/auth/authenticate.ts';
import type { RequestPrincipal } from '../../domain/auth/principal.ts';
import type { Logger } from '../../ports/logger.ts';
import { type HttpContext, serverOf } from '../http/env.ts';
import { authViewOf } from '../http/middleware/auth.ts';
import type { WsConnection } from './connection.ts';
import type { RealtimeHub } from './hub.ts';
import { type BunServerSocketLike, bunSocket } from './socket.ts';

/** Per-socket data carried through Bun's upgrade. */
export interface WsUpgradeData {
  readonly principal: RequestPrincipal | null;
  /** Non-null: close with this code right after the upgrade (browsers see the code, not 1006). */
  readonly closeCode: number | null;
  connection: WsConnection | undefined;
}

/** Bun socket with our upgrade data. */
export interface UpgradedSocket extends BunServerSocketLike {
  readonly data: WsUpgradeData;
}

/** The handler object `Bun.serve({ websocket })` takes. */
export interface WebSocketHandler {
  open(ws: UpgradedSocket): void;
  message(ws: UpgradedSocket, message: string | Buffer): void;
  close(ws: UpgradedSocket, code: number, reason: string): void;
  drain(ws: UpgradedSocket): void;
}

/** Decides the post-upgrade close code: 4406 bad subprotocol, 4401 unauthenticated, 4403 password change. */
export async function upgradeVerdict(
  c: HttpContext,
  authenticator: Authenticator,
): Promise<{ principal: RequestPrincipal | null; closeCode: number | null; protocol: boolean }> {
  const offered = (c.req.header('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
  const protocol = offered.includes(WS_SUBPROTOCOL);
  let principal: RequestPrincipal | null = null;
  try {
    principal = await authenticator.authenticate(authViewOf(c, 'ws'));
  } catch {
    principal = null;
  }
  const method = principal?.auth.method;
  if (!protocol) return { principal, closeCode: WS_CLOSE.BAD_SUBPROTOCOL, protocol };
  if (principal === null || (method !== 'password-session' && method !== 'bearer')) {
    return { principal: null, closeCode: WS_CLOSE.UNAUTHORIZED, protocol };
  }
  if (principal.mustChangePassword) {
    return { principal, closeCode: WS_CLOSE.PASSWORD_CHANGE_REQUIRED, protocol };
  }
  return { principal, closeCode: null, protocol };
}

/** The Hono handler of `GET /api/v1/ws`. */
export function upgradeHandler(authenticator: Authenticator) {
  return async (c: HttpContext): Promise<Response> => {
    const server = serverOf(c);
    if (server === undefined || c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const verdict = await upgradeVerdict(c, authenticator);
    const data: WsUpgradeData = {
      principal: verdict.principal,
      closeCode: verdict.closeCode,
      connection: undefined,
    };
    const upgraded = server.upgrade(c.req.raw, {
      data,
      ...(verdict.protocol && { headers: { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL } }),
    });
    return upgraded ? new Response(null) : new Response('upgrade failed', { status: 400 });
  };
}

/** Bun `websocket` handler bound to the hub. */
export function websocketHandler(hub: RealtimeHub, logger: Logger): WebSocketHandler {
  const log = logger.child({ module: 'ws' });
  return {
    open(ws) {
      const { principal, closeCode } = ws.data;
      if (closeCode !== null || principal === null) {
        ws.close(closeCode ?? WS_CLOSE.UNAUTHORIZED, 'refused');
        return;
      }
      ws.data.connection = hub.open(bunSocket(ws), principal);
    },
    message(ws, message) {
      const conn = ws.data.connection;
      if (conn === undefined) return;
      const data = typeof message === 'string' ? message : new Uint8Array(message);
      hub
        .message(conn, data)
        .catch((error: unknown) => log.error('ws message failed', { err: error }));
    },
    close(ws) {
      const conn = ws.data.connection;
      if (conn !== undefined) hub.close(conn);
    },
    drain(ws) {
      const conn = ws.data.connection;
      if (conn !== undefined) hub.drain(conn);
    },
  };
}
