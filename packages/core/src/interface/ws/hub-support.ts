/** @module interface/ws/hub-support — hub limits, inbound frame parsing and the logs filter. */

import { WS_LIMITS, WsClientCommand } from '@browserhive/contracts/ws';
import type { z } from 'zod';
import type { LogEntry } from '../http/services.ts';
import type { WsConnection } from './connection.ts';
import { DEFAULT_FEED_LIMITS, type FeedBufferLimits } from './feed-buffer.ts';

/** Hub tunables (spec 03 §6.4 defaults). */
export interface HubLimits extends FeedBufferLimits {
  readonly maxInboundFrameBytes: number;
  readonly maxProtocolViolations: number;
  readonly staleMs: number;
  readonly overloadBytes: number;
  readonly overloadGraceMs: number;
  readonly screencastDropBytes: number;
}

/** Spec defaults. */
export const DEFAULT_HUB_LIMITS: HubLimits = {
  ...DEFAULT_FEED_LIMITS,
  maxInboundFrameBytes: WS_LIMITS.maxInboundFrameBytes,
  maxProtocolViolations: WS_LIMITS.maxProtocolViolations,
  staleMs: WS_LIMITS.staleMs,
  overloadBytes: WS_LIMITS.overloadBytes,
  overloadGraceMs: WS_LIMITS.overloadGraceMs,
  screencastDropBytes: WS_LIMITS.screencastDropBytes,
};

const LEVEL_RANK = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 } as const;

/** Parses one inbound text frame into a client command; issues are human-readable. */
export function parseCommand(
  text: string,
):
  | { success: true; data: z.output<typeof WsClientCommand> }
  | { success: false; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { success: false, issues: ['frame is not JSON'] };
  }
  const parsed = WsClientCommand.safeParse(json);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: parsed.error.issues.map(
      (i) => `${i.path.map(String).join('.') || 'frame'}: ${i.message}`,
    ),
  };
}

/** Screencast commands: serialised per (connection, session) so they apply in arrival order. */
export type ScreencastCommand = Extract<
  z.output<typeof WsClientCommand>,
  { type: 'screencast.start' | 'screencast.stop' | 'screencast.set_size' }
>;

/** True for `screencast.start`, `screencast.stop` and `screencast.set_size`. */
export function isScreencastCommand(
  command: z.output<typeof WsClientCommand>,
): command is ScreencastCommand {
  return (
    command.type === 'screencast.start' ||
    command.type === 'screencast.stop' ||
    command.type === 'screencast.set_size'
  );
}

/** True when a log entry passes the connection's `logs.tail` filter. */
export function matchesLogFilter(conn: WsConnection, entry: LogEntry): boolean {
  const { level, module } = conn.logsFilter;
  if (level !== undefined && LEVEL_RANK[entry.record.level] > LEVEL_RANK[level]) return false;
  if (module !== undefined) {
    const m = entry.record.module;
    if (m !== module && !m.startsWith(`${module}.`)) return false;
  }
  return true;
}
